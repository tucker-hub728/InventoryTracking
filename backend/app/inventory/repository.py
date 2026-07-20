"""Persistence helpers for the inventory module.

Routes never call SQLAlchemy directly — they go through this module so
query shape stays consistent and tests can fake one place.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from sqlalchemy import Select, asc, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.inventory import (
    BomLine,
    Item,
    ItemPrefix,
    ItemStock,
    ItemSupplier,
    ItemTier,
    Lot,
    ReceiptEvent,
    ReceiptEventLine,
    ReceiptTransaction,
    ReceiptTransactionLine,
    StockMovement,
    Supplier,
)

# Whitelist for the ``status`` query filter. Aligned with the
# ``status_code`` values produced by ``app.v_item_stock``.
ITEM_STATUS_CODES: tuple[str, ...] = ("available", "low_stock", "out_of_stock")


# ── Suppliers ────────────────────────────────────────────────────────────


async def list_suppliers(
    session: AsyncSession,
    *,
    active_only: bool = True,
) -> list[Supplier]:
    stmt = select(Supplier)
    if active_only:
        stmt = stmt.where(Supplier.is_active.is_(True))
    stmt = stmt.order_by(func.lower(Supplier.name))
    return list((await session.execute(stmt)).scalars().all())


async def get_supplier(session: AsyncSession, supplier_id: uuid.UUID) -> Supplier | None:
    return (
        await session.execute(select(Supplier).where(Supplier.id == supplier_id))
    ).scalar_one_or_none()


async def get_supplier_by_name(session: AsyncSession, name: str) -> Supplier | None:
    """Case-insensitive lookup — mirrors the partial-unique index."""
    stmt = select(Supplier).where(func.lower(Supplier.name) == name.lower())
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_supplier(
    session: AsyncSession,
    *,
    name: str,
    contact_email: str | None = None,
    phone: str | None = None,
    notes: str | None = None,
    is_active: bool = True,
) -> Supplier:
    """Insert a supplier row. Caller commits."""
    supplier = Supplier(
        name=name.strip(),
        contact_email=contact_email,
        phone=phone,
        notes=notes,
        is_active=is_active,
    )
    session.add(supplier)
    await session.flush()
    return supplier


async def apply_supplier_patch(
    session: AsyncSession,
    *,
    supplier: Supplier,
    patch: dict[str, object],
) -> Supplier:
    """Apply a dict of changes (from ``model_dump(exclude_unset=True)``)
    to a loaded supplier and flush. Caller commits.

    ``patch`` is trusted — schema-level validation has already run, and
    the caller is responsible for resolving FKs (e.g. checking the
    target supplier name isn't a duplicate).
    """
    for col, value in patch.items():
        setattr(supplier, col, value)
    await session.flush()
    return supplier


def supplier_to_audit_snapshot(supplier: Supplier) -> dict[str, object | None]:
    """Trim a supplier row to the fields worth recording in the audit log.

    Skipping the audit columns (created_at, updated_at) so a no-op patch
    produces an empty diff instead of a meaningless timestamp delta.
    """
    return {
        "name": supplier.name,
        "contact_email": supplier.contact_email,
        "phone": supplier.phone,
        "notes": supplier.notes,
        "is_active": supplier.is_active,
    }


# ── Items ──────────────────────────────────────────────────────────────


SortField = Literal["item_number", "description", "updated_at", "created_at"]
SortDirection = Literal["asc", "desc"]


def _apply_filters(
    stmt: Select[tuple[Item]],
    *,
    q: str | None,
    supplier_id: uuid.UUID | None,
    status: str | None,
    tier_id: uuid.UUID | None = None,
    prefix_id: uuid.UUID | None = None,
    is_consumable: bool | None = None,
    has_bom: bool | None = None,
    below_reorder: bool | None = None,
) -> Select[tuple[Item]]:
    stmt = stmt.where(Item.deleted_at.is_(None))
    if tier_id is not None:
        # Tier lives on the prefix now — filter by the tier's prefixes.
        stmt = stmt.where(
            Item.prefix_id.in_(
                select(ItemPrefix.id).where(ItemPrefix.tier_id == tier_id)
            )
        )
    if prefix_id is not None:
        stmt = stmt.where(Item.prefix_id == prefix_id)
    if is_consumable is not None:
        stmt = stmt.where(Item.is_consumable.is_(is_consumable))
    if has_bom is not None:
        # Parents of at least one live BOM line. ``has_bom=False`` is the
        # "missing BOM" case — a built item nobody has defined a recipe for.
        with_bom = select(BomLine.parent_item_id).where(BomLine.deleted_at.is_(None))
        stmt = stmt.where(
            Item.id.in_(with_bom) if has_bom else Item.id.not_in(with_bom)
        )
    if supplier_id is not None:
        # Suppliers live in ``meta.item_suppliers`` now — filter items that have
        # the requested supplier in their assigned list.
        stmt = stmt.where(
            Item.id.in_(
                select(ItemSupplier.item_id).where(
                    ItemSupplier.supplier_id == supplier_id
                )
            )
        )
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(
            or_(
                # The number is derived, so match its parts: the suffix, the
                # description, or the prefix code (so "PRR" finds all PRR items).
                func.lower(Item.sku_suffix).like(like),
                func.lower(Item.description).like(like),
                Item.prefix_id.in_(
                    select(ItemPrefix.id).where(func.lower(ItemPrefix.code).like(like))
                ),
            )
        )
    if status is not None or below_reorder is not None:
        # Join the view explicitly so the filter works in both the
        # ``items`` select and the ``count()`` select. ``v_item_stock``
        # has one row per non-deleted item, so the inner join doesn't
        # change which items are eligible — only filters them. Joined once
        # even when both stock filters are set (a second join would error).
        stmt = stmt.join(ItemStock, ItemStock.item_id == Item.id)
        if status is not None:
            stmt = stmt.where(ItemStock.status_code == status)
        if below_reorder is not None:
            # "Needs reorder": at or below the reorder point. Deliberately
            # broader than ``status_code == 'low_stock'``, which excludes
            # zero-stock items because the view tests ``qty_available <= 0``
            # first — so a filter on it would hide the *most* urgent rows.
            at_or_below = ItemStock.qty_available <= Item.reorder_threshold
            stmt = stmt.where(at_or_below if below_reorder else ~at_or_below)
    return stmt


_SORT_COLUMNS = {
    # "item_number" sorts by the stored suffix — the derived number isn't a
    # column. Within a tier's list (one prefix) this matches number order.
    "item_number": Item.sku_suffix,
    "description": Item.description,
    "updated_at": Item.updated_at,
    "created_at": Item.created_at,
}


async def list_items(
    session: AsyncSession,
    *,
    q: str | None = None,
    supplier_id: uuid.UUID | None = None,
    status: str | None = None,
    tier_id: uuid.UUID | None = None,
    prefix_id: uuid.UUID | None = None,
    is_consumable: bool | None = None,
    has_bom: bool | None = None,
    below_reorder: bool | None = None,
    sort: SortField = "item_number",
    direction: SortDirection = "asc",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Item], int]:
    """Return ``(items, total)``. Total is the unpaged count."""
    # Spelled out for both selects rather than unpacked from a dict: a
    # ``**kwargs`` dict widens the value type and loses mypy's per-parameter
    # checking on the way in.
    base = _apply_filters(
        select(Item),
        q=q,
        supplier_id=supplier_id,
        status=status,
        tier_id=tier_id,
        prefix_id=prefix_id,
        is_consumable=is_consumable,
        has_bom=has_bom,
        below_reorder=below_reorder,
    )
    count_stmt = _apply_filters(
        select(func.count()).select_from(Item),
        q=q,
        supplier_id=supplier_id,
        status=status,
        tier_id=tier_id,
        prefix_id=prefix_id,
        is_consumable=is_consumable,
        has_bom=has_bom,
        below_reorder=below_reorder,
    )
    total = int((await session.execute(count_stmt)).scalar_one())

    order_col = _SORT_COLUMNS[sort]
    base = base.order_by(asc(order_col) if direction == "asc" else desc(order_col))
    base = base.limit(limit).offset(offset)
    rows = (await session.execute(base)).scalars().unique().all()
    return list(rows), total


async def get_item(session: AsyncSession, item_id: uuid.UUID) -> Item | None:
    stmt = select(Item).where(Item.id == item_id, Item.deleted_at.is_(None))
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_item_by_prefix_suffix(
    session: AsyncSession, prefix_id: uuid.UUID, sku_suffix: str
) -> Item | None:
    """Live item with this (prefix, suffix) — the uniqueness pair."""
    stmt = select(Item).where(
        Item.prefix_id == prefix_id,
        Item.sku_suffix == sku_suffix,
        Item.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_item_by_number(session: AsyncSession, item_number: str) -> Item | None:
    """Resolve a full SKU (``<prefix code>-<suffix>``) back to its item.

    The number is derived, not stored, so split on the first ``-`` into the
    prefix code and the suffix, resolve the (live) prefix by code, then the item
    by ``(prefix_id, suffix)``.
    """
    code, sep, suffix = item_number.partition("-")
    if not sep:
        return None
    prefix = (
        await session.execute(
            select(ItemPrefix).where(
                func.lower(ItemPrefix.code) == code.lower(),
                ItemPrefix.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if prefix is None:
        return None
    return await get_item_by_prefix_suffix(session, prefix.id, suffix)


async def create_item(
    session: AsyncSession,
    *,
    sku_suffix: str,
    description: str,
    prefix_id: uuid.UUID,
    created_by_user_id: uuid.UUID,
    uom: str | None = None,
    is_consumable: bool = False,
    avg_lead_days: int | None = None,
    reorder_threshold: Decimal = Decimal("0"),
    near_expiry_threshold_days: int = 30,
) -> Item:
    """Insert an item row (no suppliers yet). Caller commits.

    The tier is derived from ``prefix_id`` (a prefix lives inside one tier), so
    there is no ``tier_id`` to set. Assigned suppliers are written separately via
    ``replace_item_suppliers`` so the FK validation / audit happen at the route
    layer.
    """
    item = Item(
        sku_suffix=sku_suffix,
        description=description,
        prefix_id=prefix_id,
        uom=uom,
        is_consumable=is_consumable,
        avg_lead_days=avg_lead_days,
        reorder_threshold=reorder_threshold,
        near_expiry_threshold_days=near_expiry_threshold_days,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(item)
    await session.flush()
    # Re-read so eager relationships (suppliers, stock) populate. The naive
    # ORM returns a half-hydrated instance after flush.
    refreshed = await get_item(session, item.id)
    assert refreshed is not None
    return refreshed


async def apply_item_patch(
    session: AsyncSession,
    *,
    item: Item,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> Item:
    """Apply an item PATCH dict and bump ``updated_by_user_id``. Caller
    commits. ``patch`` carries scalar item columns only — supplier changes go
    through ``replace_item_suppliers``.
    """
    for col, value in patch.items():
        setattr(item, col, value)
    item.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_item(session, item.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_item(
    session: AsyncSession,
    *,
    item: Item,
    deleted_by_user_id: uuid.UUID,
) -> Item:
    """Soft-delete an item by stamping ``deleted_at``. Caller commits.

    The partial-unique index on ``item_number`` ignores soft-deleted
    rows, so the same item_number can be re-issued via a fresh CREATE
    after deletion. Lots and movements that reference the item keep
    resolving through the FK.
    """
    from datetime import datetime

    item.deleted_at = datetime.now(UTC)
    item.updated_by_user_id = deleted_by_user_id
    await session.flush()
    return item


def item_to_audit_snapshot(item: Item) -> dict[str, object | None]:
    """Trim an item row to fields worth recording in the audit log."""
    return {
        "item_number": item.item_number,
        "sku_suffix": item.sku_suffix,
        "description": item.description,
        "uom": item.uom,
        "is_consumable": item.is_consumable,
        "prefix_id": str(item.prefix_id),
        "supplier_ids": sorted(str(iv.supplier_id) for iv in item.suppliers),
        "avg_lead_days": item.avg_lead_days,
        "reorder_threshold": str(item.reorder_threshold),
        "near_expiry_threshold_days": item.near_expiry_threshold_days,
        "must_order_flag": item.must_order_flag,
        "deleted_at": item.deleted_at.isoformat() if item.deleted_at else None,
    }


async def compute_item_valuations(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[Decimal, Decimal, Decimal]]:
    """Return ``{item_id: (inv_value, po_value, qty_on_order)}`` for the given
    items, all derived from the lots' unit prices (the item no longer carries
    a price).

      * ``inv_value``   — Σ over the item's on-hand units of (unit × its lot's
        ``unit_price_amount``). Computed as Σ(``movement.qty_delta`` ×
        ``lot.unit_price_amount``), which is algebraically Σ(per-lot on-hand ×
        per-lot price) since price is constant per lot. Tracks ``v_item_stock``'s
        *physical* on-hand (expired stock still counts as a held asset).
      * ``po_value``    — Σ over the item's **outstanding** Order lines of
        (outstanding × line ``unit_price_amount``).
      * ``qty_on_order``— Σ outstanding over the item's open Order lines.

    "Outstanding" (v3) = ``ordered_qty − Σ received`` on a line, for Orders that
    are not cancelled / soft-deleted. Lots are created at receive, so there are
    no ON_ORDER lots any more — on-order is now line-derived.

    Items with no priced stock and no outstanding lines are absent from the
    dict; callers default the missing entries to zero.
    """
    if not item_ids:
        return {}

    rows: dict[uuid.UUID, list[Decimal]] = {}

    def _row(item_id: uuid.UUID) -> list[Decimal]:
        return rows.setdefault(
            item_id, [Decimal("0"), Decimal("0"), Decimal("0")]
        )

    inv_stmt = (
        select(
            StockMovement.item_id,
            func.coalesce(
                func.sum(StockMovement.qty_delta * Lot.unit_price_amount),
                0,
            ),
        )
        .join(Lot, Lot.id == StockMovement.lot_id)
        .where(
            StockMovement.item_id.in_(item_ids),
            Lot.unit_price_amount.is_not(None),
        )
        .group_by(StockMovement.item_id)
    )
    for item_id, inv_value in (await session.execute(inv_stmt)).all():
        _row(item_id)[0] = Decimal(inv_value)

    # Outstanding per Order line = ordered − Σ received (clamped at 0).
    received_sub = (
        select(
            ReceiptEventLine.receipt_transaction_line_id.label("line_id"),
            func.coalesce(func.sum(ReceiptEventLine.qty_received), 0).label("recd"),
        )
        .group_by(ReceiptEventLine.receipt_transaction_line_id)
        .subquery()
    )
    outstanding = func.greatest(
        ReceiptTransactionLine.ordered_qty - func.coalesce(received_sub.c.recd, 0),
        0,
    )
    po_stmt = (
        select(
            ReceiptTransactionLine.item_id,
            func.coalesce(
                func.sum(outstanding * ReceiptTransactionLine.unit_price_amount), 0
            ),
            func.coalesce(func.sum(outstanding), 0),
        )
        .select_from(ReceiptTransactionLine)
        .join(
            ReceiptTransaction,
            ReceiptTransaction.id == ReceiptTransactionLine.receipt_transaction_id,
        )
        .outerjoin(received_sub, received_sub.c.line_id == ReceiptTransactionLine.id)
        .where(
            ReceiptTransactionLine.item_id.in_(item_ids),
            ReceiptTransaction.deleted_at.is_(None),
            ReceiptTransaction.status != "cancelled",
        )
        .group_by(ReceiptTransactionLine.item_id)
    )
    for item_id, po_value, qty_on_order in (await session.execute(po_stmt)).all():
        row = _row(item_id)
        row[1] = Decimal(po_value)
        row[2] = Decimal(qty_on_order)

    return {k: (v[0], v[1], v[2]) for k, v in rows.items()}


# ── Tiers + BOM helpers (shared by items + catalog modules) ────────


async def get_tier(
    session: AsyncSession, tier_id: uuid.UUID
) -> ItemTier | None:
    """Fetch one live (non-deleted) tier."""
    stmt = select(ItemTier).where(
        ItemTier.id == tier_id,
        ItemTier.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_prefix(
    session: AsyncSession, prefix_id: uuid.UUID
) -> ItemPrefix | None:
    """Fetch one live (non-deleted) prefix (tier eager-joined)."""
    stmt = select(ItemPrefix).where(
        ItemPrefix.id == prefix_id,
        ItemPrefix.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def item_has_lots(session: AsyncSession, item_id: uuid.UUID) -> bool:
    """True if the item has any live lot — i.e. it has been received as stock.
    Used to block re-typing a received (Purchased) item into a Product."""
    stmt = (
        select(Lot.id)
        .where(Lot.item_id == item_id, Lot.deleted_at.is_(None))
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def items_with_bom(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """Subset of ``item_ids`` that have at least one live BOM line (i.e. are
    expandable in the structure tree)."""
    if not item_ids:
        return set()
    stmt = (
        select(BomLine.parent_item_id)
        .where(
            BomLine.parent_item_id.in_(item_ids),
            BomLine.deleted_at.is_(None),
        )
        .distinct()
    )
    return set((await session.execute(stmt)).scalars().all())


async def bom_line_counts(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """``{item_id: live BOM-line count}`` — the item's direct component count.

    Direct lines only, not the whole exploded tree: it answers "how many
    components does this recipe list", which is what the list column shows.
    Items with no BOM are absent; callers default to zero.
    """
    if not item_ids:
        return {}
    stmt = (
        select(BomLine.parent_item_id, func.count())
        .where(
            BomLine.parent_item_id.in_(item_ids),
            BomLine.deleted_at.is_(None),
        )
        .group_by(BomLine.parent_item_id)
    )
    return {pid: int(n) for pid, n in (await session.execute(stmt)).all()}


# ── Lots ───────────────────────────────────────────────────────────────


async def list_lots(
    session: AsyncSession,
    *,
    item_id: uuid.UUID | None = None,
    status: str | None = None,
    include_deleted: bool = False,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[Lot], int]:
    """Return ``(lots, total)``. Newest first."""
    base: Select[tuple[Lot]] = select(Lot)
    if not include_deleted:
        base = base.where(Lot.deleted_at.is_(None))
    if item_id is not None:
        base = base.where(Lot.item_id == item_id)
    if status:
        base = base.where(Lot.status == status)

    count_stmt = select(func.count()).select_from(Lot)
    if not include_deleted:
        count_stmt = count_stmt.where(Lot.deleted_at.is_(None))
    if item_id is not None:
        count_stmt = count_stmt.where(Lot.item_id == item_id)
    if status:
        count_stmt = count_stmt.where(Lot.status == status)
    total = int((await session.execute(count_stmt)).scalar_one())

    base = base.order_by(desc(Lot.created_at)).limit(limit).offset(offset)
    rows = (await session.execute(base)).scalars().unique().all()
    return list(rows), total


async def get_lot(session: AsyncSession, lot_id: uuid.UUID) -> Lot | None:
    stmt = select(Lot).where(Lot.id == lot_id, Lot.deleted_at.is_(None))
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_lot_by_item_and_number(
    session: AsyncSession, *, item_id: uuid.UUID, lot_number: str
) -> Lot | None:
    """Lookup that mirrors the partial-unique index."""
    stmt = select(Lot).where(
        Lot.item_id == item_id,
        Lot.lot_number == lot_number,
        Lot.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_lot(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_number: str,
    created_by_user_id: uuid.UUID,
    supplier_id: uuid.UUID | None = None,
    manufacture_date: date | None = None,
    expiration_date: date | None = None,
    status: str = "available",
    notes: str | None = None,
    unit_price_amount: Decimal | None = None,
    po_reference: str | None = None,
    ordered_qty: Decimal | None = None,
    receipt_transaction_id: uuid.UUID | None = None,
    receipt_transaction_line_id: uuid.UUID | None = None,
    parent_lot_id: uuid.UUID | None = None,
) -> Lot:
    """Insert a lot row. Caller commits.

    Receipt Admin fields (``unit_price_amount``, ``po_reference``,
    ``ordered_qty``, ``receipt_transaction_id``, ``receipt_transaction_line_id``,
    ``parent_lot_id``) default to None so existing callers (admin lot create,
    direct receipt) are unaffected. In v3 a received lot is tied to its Order
    line via ``receipt_transaction_line_id``; on-hand stays ledger-derived.
    """
    lot = Lot(
        item_id=item_id,
        lot_number=lot_number.strip(),
        supplier_id=supplier_id,
        manufacture_date=manufacture_date,
        expiration_date=expiration_date,
        status=status,
        notes=notes,
        unit_price_amount=unit_price_amount,
        po_reference=po_reference,
        ordered_qty=ordered_qty,
        receipt_transaction_id=receipt_transaction_id,
        receipt_transaction_line_id=receipt_transaction_line_id,
        parent_lot_id=parent_lot_id,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(lot)
    await session.flush()
    refreshed = await get_lot(session, lot.id)
    assert refreshed is not None
    return refreshed


async def apply_lot_patch(
    session: AsyncSession,
    *,
    lot: Lot,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> Lot:
    """Apply a PATCH dict to a loaded lot and bump
    ``updated_by_user_id``. Caller commits.
    """
    for col, value in patch.items():
        setattr(lot, col, value)
    lot.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_lot(session, lot.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_lot(
    session: AsyncSession,
    *,
    lot: Lot,
    deleted_by_user_id: uuid.UUID,
) -> Lot:
    """Soft-delete a lot. Caller commits.

    The partial-unique index on ``(item_id, lot_number)`` ignores
    soft-deleted rows so the same lot number can be re-issued for
    the same item after deletion.
    """
    from datetime import datetime

    lot.deleted_at = datetime.now(UTC)
    lot.updated_by_user_id = deleted_by_user_id
    await session.flush()
    return lot


def lot_to_audit_snapshot(lot: Lot) -> dict[str, object | None]:
    return {
        "lot_number": lot.lot_number,
        "item_id": str(lot.item_id),
        "supplier_id": str(lot.supplier_id) if lot.supplier_id else None,
        "manufacture_date": lot.manufacture_date.isoformat() if lot.manufacture_date else None,
        "expiration_date": lot.expiration_date.isoformat() if lot.expiration_date else None,
        "status": lot.status,
        "notes": lot.notes,
        "unit_price_amount": (
            str(lot.unit_price_amount) if lot.unit_price_amount is not None else None
        ),
        "po_reference": lot.po_reference,
        "ordered_qty": str(lot.ordered_qty) if lot.ordered_qty is not None else None,
        "receipt_transaction_id": (
            str(lot.receipt_transaction_id) if lot.receipt_transaction_id else None
        ),
        "parent_lot_id": str(lot.parent_lot_id) if lot.parent_lot_id else None,
        "deleted_at": lot.deleted_at.isoformat() if lot.deleted_at else None,
    }


async def lot_has_movements(session: AsyncSession, lot_id: uuid.UUID) -> bool:
    """True iff at least one ``stock_movements`` row references this lot.

    Used by ``DELETE /lots/{id}`` to refuse deletion when stock has
    already moved against the lot — the audit trail is the only place
    that lot info survives once it's deleted, and we don't want the
    movement row to lose its lot label.
    """
    stmt = (
        select(StockMovement.id)
        .where(StockMovement.lot_id == lot_id)
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


# ── Stock movements ────────────────────────────────────────────────────


MovementType = Literal[
    "receipt",
    "dispense",
    "adjustment",
    "discard",
    "transfer_out",
    "transfer_in",
]


async def list_movements(
    session: AsyncSession,
    *,
    item_id: uuid.UUID | None = None,
    lot_id: uuid.UUID | None = None,
    location_node_id: uuid.UUID | None = None,
    movement_type: MovementType | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[StockMovement], int]:
    """Return ``(movements, total)`` newest first.

    ``location_node_id`` matches movements that touch the node in either
    direction (``from`` OR ``to``) — everything that moved through a box/flat.
    """
    base: Select[tuple[StockMovement]] = select(StockMovement)
    count_stmt = select(func.count()).select_from(StockMovement)

    def _apply(stmt):
        if item_id is not None:
            stmt = stmt.where(StockMovement.item_id == item_id)
        if lot_id is not None:
            stmt = stmt.where(StockMovement.lot_id == lot_id)
        if location_node_id is not None:
            stmt = stmt.where(
                or_(
                    StockMovement.from_location_node_id == location_node_id,
                    StockMovement.to_location_node_id == location_node_id,
                )
            )
        if movement_type is not None:
            stmt = stmt.where(StockMovement.movement_type == movement_type)
        return stmt

    base = _apply(base)
    count_stmt = _apply(count_stmt)
    total = int((await session.execute(count_stmt)).scalar_one())

    base = (
        base.order_by(desc(StockMovement.performed_at))
        .limit(limit)
        .offset(offset)
    )
    rows = (await session.execute(base)).scalars().unique().all()
    return list(rows), total


async def list_item_ledger(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[StockMovement], int]:
    """Per-item ledger — wraps ``list_movements`` for a stable signature."""
    return await list_movements(
        session, item_id=item_id, limit=limit, offset=offset
    )


async def get_movement(
    session: AsyncSession, movement_id: uuid.UUID
) -> StockMovement | None:
    return (
        await session.execute(
            select(StockMovement).where(StockMovement.id == movement_id)
        )
    ).scalar_one_or_none()


# ── Item suppliers ───────────────────────────────────────────────────────
#
# An item's assigned-supplier list (``meta.item_suppliers``). These are the only
# suppliers an item can be received against.


async def list_item_suppliers(
    session: AsyncSession, item_id: uuid.UUID
) -> list[ItemSupplier]:
    """Assigned suppliers for an item (oldest first), supplier joined."""
    stmt = (
        select(ItemSupplier)
        .where(ItemSupplier.item_id == item_id)
        .order_by(ItemSupplier.created_at)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def item_supplier_ids(
    session: AsyncSession, item_id: uuid.UUID
) -> set[uuid.UUID]:
    """The set of supplier ids assigned to an item — used to validate that an
    intake / receive supplier is one of the item's suppliers.
    """
    stmt = select(ItemSupplier.supplier_id).where(ItemSupplier.item_id == item_id)
    return set((await session.execute(stmt)).scalars().all())


async def replace_item_suppliers(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    supplier_ids: list[uuid.UUID],
    created_by_user_id: uuid.UUID,
) -> None:
    """Make the item's assigned-supplier list exactly ``supplier_ids``.

    Adds the missing ones, removes the extras, leaves unchanged rows alone
    (so ``created_at`` / ``created_by`` are preserved for kept suppliers).
    Caller commits. Supplier FKs are assumed validated by the caller.
    """
    target = list(dict.fromkeys(supplier_ids))  # de-dup, keep order
    existing = {iv.supplier_id: iv for iv in await list_item_suppliers(session, item_id)}

    for vid in target:
        if vid not in existing:
            session.add(
                ItemSupplier(
                    item_id=item_id,
                    supplier_id=vid,
                    created_by_user_id=created_by_user_id,
                )
            )
    target_set = set(target)
    for vid, iv in existing.items():
        if vid not in target_set:
            await session.delete(iv)

    await session.flush()


# ── Receipt transactions ───────────────────────────────────────────────


def _order_load_options() -> list:
    """Eager-load an Order's lines (+item/supplier) and events (+lines/lots)."""
    return [
        selectinload(ReceiptTransaction.lines),
        selectinload(ReceiptTransaction.events).selectinload(ReceiptEvent.lines),
    ]


async def create_order(
    session: AsyncSession,
    *,
    created_by_user_id: uuid.UUID,
    po_reference: str,
    is_blanket: bool = False,
    valid_from: date | None = None,
    valid_to: date | None = None,
    notes: str | None = None,
) -> ReceiptTransaction:
    """Insert an ``open`` Order header. Caller adds lines + commits."""
    txn = ReceiptTransaction(
        status="open",
        po_reference=po_reference,
        is_blanket=is_blanket,
        valid_from=valid_from,
        valid_to=valid_to,
        notes=notes,
        created_by_user_id=created_by_user_id,
    )
    session.add(txn)
    await session.flush()
    return txn


async def add_order_line(
    session: AsyncSession,
    *,
    txn_id: uuid.UUID,
    line_no: int,
    item_id: uuid.UUID,
    supplier_id: uuid.UUID,
    ordered_qty: int,
    unit_price_amount: Decimal | None = None,
) -> ReceiptTransactionLine:
    """Insert one Order line. Caller commits."""
    line = ReceiptTransactionLine(
        receipt_transaction_id=txn_id,
        line_no=line_no,
        item_id=item_id,
        supplier_id=supplier_id,
        ordered_qty=ordered_qty,
        unit_price_amount=unit_price_amount,
    )
    session.add(line)
    await session.flush()
    return line


async def get_order(
    session: AsyncSession, txn_id: uuid.UUID
) -> ReceiptTransaction | None:
    """Load a non-deleted Order with lines + events eager-loaded.

    ``populate_existing`` forces the eager collections to refresh even when
    the instance is already in the identity map (intake/receive load the
    header, mutate, then re-read).
    """
    stmt = (
        select(ReceiptTransaction)
        .where(
            ReceiptTransaction.id == txn_id,
            ReceiptTransaction.deleted_at.is_(None),
        )
        .options(*_order_load_options())
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_orders(
    session: AsyncSession,
    *,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ReceiptTransaction], int]:
    """Return ``(orders, total)`` newest first, lines + events eager-loaded.

    Soft-deleted Orders are excluded.
    """

    def _apply(stmt):
        stmt = stmt.where(ReceiptTransaction.deleted_at.is_(None))
        if status is not None:
            stmt = stmt.where(ReceiptTransaction.status == status)
        return stmt

    count_stmt = _apply(select(func.count()).select_from(ReceiptTransaction))
    total = int((await session.execute(count_stmt)).scalar_one())

    base = _apply(select(ReceiptTransaction).options(*_order_load_options()))
    base = (
        base.order_by(desc(ReceiptTransaction.created_at)).limit(limit).offset(offset)
    )
    rows = (await session.execute(base)).scalars().unique().all()
    return list(rows), total


async def get_event_line_by_lot(
    session: AsyncSession, lot_id: uuid.UUID
) -> ReceiptEventLine | None:
    """The receive-event draw that created a given lot (one-to-one via lot_id)."""
    stmt = select(ReceiptEventLine).where(ReceiptEventLine.lot_id == lot_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def received_qty_by_line(
    session: AsyncSession, line_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Σ ``qty_received`` per Order line. Missing lines default to 0."""
    if not line_ids:
        return {}
    stmt = (
        select(
            ReceiptEventLine.receipt_transaction_line_id,
            func.coalesce(func.sum(ReceiptEventLine.qty_received), 0),
        )
        .where(ReceiptEventLine.receipt_transaction_line_id.in_(line_ids))
        .group_by(ReceiptEventLine.receipt_transaction_line_id)
    )
    return {lid: int(q) for lid, q in (await session.execute(stmt)).all()}


def derive_order_status(
    lines: list[ReceiptTransactionLine],
    received: dict[uuid.UUID, int],
) -> str:
    """Derive open / partially_received / received from line fulfilment.

    ``cancelled`` is set explicitly elsewhere — never derived here.
    """
    total_received = sum(received.get(line.id, 0) for line in lines)
    if total_received == 0:
        return "open"
    if all(received.get(line.id, 0) >= line.ordered_qty for line in lines):
        return "received"
    return "partially_received"


async def delete_order_lines(session: AsyncSession, *, txn_id: uuid.UUID) -> None:
    """Hard-delete all lines of an Order (used to replace lines on edit).

    Only valid while the Order is un-received (no event lines reference these
    lines), so the RESTRICT FK from ``receipt_event_lines`` is never hit.
    """
    from sqlalchemy import delete as sa_delete

    await session.execute(
        sa_delete(ReceiptTransactionLine).where(
            ReceiptTransactionLine.receipt_transaction_id == txn_id
        )
    )
    await session.flush()


async def create_receipt_event(
    session: AsyncSession,
    *,
    txn_id: uuid.UUID,
    received_at: date,
    received_by_user_id: uuid.UUID,
    reauth_event_id: uuid.UUID,
    notes: str | None = None,
) -> ReceiptEvent:
    """Insert one dated receive-event header. Caller adds lines + commits."""
    event = ReceiptEvent(
        receipt_transaction_id=txn_id,
        received_at=received_at,
        received_by_user_id=received_by_user_id,
        reauth_event_id=reauth_event_id,
        notes=notes,
    )
    session.add(event)
    await session.flush()
    return event


async def add_receipt_event_line(
    session: AsyncSession,
    *,
    event_id: uuid.UUID,
    line_id: uuid.UUID,
    qty_received: int,
    lot_id: uuid.UUID,
    over_receipt_reason: str | None = None,
) -> ReceiptEventLine:
    """Insert one per-line draw within a receive event. Caller commits."""
    row = ReceiptEventLine(
        receipt_event_id=event_id,
        receipt_transaction_line_id=line_id,
        qty_received=qty_received,
        over_receipt_reason=over_receipt_reason,
        lot_id=lot_id,
    )
    session.add(row)
    await session.flush()
    return row


async def set_order_status(
    session: AsyncSession,
    *,
    txn: ReceiptTransaction,
    status: str,
    received_by_user_id: uuid.UUID | None = None,
) -> None:
    """Set an Order's status. ``received`` stamps the receiver/time; any other
    status clears them. Caller commits.
    """
    txn.status = status
    if status == "received":
        txn.received_by_user_id = received_by_user_id
        txn.received_at = datetime.now(UTC)
    else:
        txn.received_by_user_id = None
        txn.received_at = None
    await session.flush()


async def soft_delete_order(
    session: AsyncSession,
    *,
    txn: ReceiptTransaction,
    deleted_by_user_id: uuid.UUID,
) -> None:
    """Soft-delete an un-received Order (stamps ``deleted_at``). Caller commits."""
    txn.deleted_at = datetime.now(UTC)
    await session.flush()


def order_to_audit_snapshot(txn: ReceiptTransaction) -> dict[str, object | None]:
    return {
        "po_reference": txn.po_reference,
        "status": txn.status,
        "is_blanket": txn.is_blanket,
        "valid_from": txn.valid_from.isoformat() if txn.valid_from else None,
        "valid_to": txn.valid_to.isoformat() if txn.valid_to else None,
        "notes": txn.notes,
        "received_by_user_id": (
            str(txn.received_by_user_id) if txn.received_by_user_id else None
        ),
        "received_at": txn.received_at.isoformat() if txn.received_at else None,
        "deleted_at": txn.deleted_at.isoformat() if txn.deleted_at else None,
    }


def order_line_to_audit_snapshot(
    line: ReceiptTransactionLine,
) -> dict[str, object | None]:
    return {
        "line_no": line.line_no,
        "item_id": str(line.item_id),
        "supplier_id": str(line.supplier_id),
        "ordered_qty": line.ordered_qty,
        "unit_price_amount": (
            str(line.unit_price_amount)
            if line.unit_price_amount is not None
            else None
        ),
    }
