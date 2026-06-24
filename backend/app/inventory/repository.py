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
    Item,
    ItemStock,
    ItemVendor,
    Lot,
    ReceiptTransaction,
    StockMovement,
    Vendor,
)

# Whitelist for the ``status`` query filter. Aligned with the
# ``status_code`` values produced by ``app.v_item_stock``.
ITEM_STATUS_CODES: tuple[str, ...] = ("available", "low_stock", "out_of_stock")


# ── Vendors ────────────────────────────────────────────────────────────


async def list_vendors(
    session: AsyncSession,
    *,
    active_only: bool = True,
) -> list[Vendor]:
    stmt = select(Vendor)
    if active_only:
        stmt = stmt.where(Vendor.is_active.is_(True))
    stmt = stmt.order_by(func.lower(Vendor.name))
    return list((await session.execute(stmt)).scalars().all())


async def get_vendor(session: AsyncSession, vendor_id: uuid.UUID) -> Vendor | None:
    return (
        await session.execute(select(Vendor).where(Vendor.id == vendor_id))
    ).scalar_one_or_none()


async def get_vendor_by_name(session: AsyncSession, name: str) -> Vendor | None:
    """Case-insensitive lookup — mirrors the partial-unique index."""
    stmt = select(Vendor).where(func.lower(Vendor.name) == name.lower())
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_vendor(
    session: AsyncSession,
    *,
    name: str,
    contact_email: str | None = None,
    phone: str | None = None,
    notes: str | None = None,
    is_active: bool = True,
) -> Vendor:
    """Insert a vendor row. Caller commits."""
    vendor = Vendor(
        name=name.strip(),
        contact_email=contact_email,
        phone=phone,
        notes=notes,
        is_active=is_active,
    )
    session.add(vendor)
    await session.flush()
    return vendor


async def apply_vendor_patch(
    session: AsyncSession,
    *,
    vendor: Vendor,
    patch: dict[str, object],
) -> Vendor:
    """Apply a dict of changes (from ``model_dump(exclude_unset=True)``)
    to a loaded vendor and flush. Caller commits.

    ``patch`` is trusted — schema-level validation has already run, and
    the caller is responsible for resolving FKs (e.g. checking the
    target vendor name isn't a duplicate).
    """
    for col, value in patch.items():
        setattr(vendor, col, value)
    await session.flush()
    return vendor


def vendor_to_audit_snapshot(vendor: Vendor) -> dict[str, object | None]:
    """Trim a vendor row to the fields worth recording in the audit log.

    Skipping the audit columns (created_at, updated_at) so a no-op patch
    produces an empty diff instead of a meaningless timestamp delta.
    """
    return {
        "name": vendor.name,
        "contact_email": vendor.contact_email,
        "phone": vendor.phone,
        "notes": vendor.notes,
        "is_active": vendor.is_active,
    }


# ── Items ──────────────────────────────────────────────────────────────


SortField = Literal["item_number", "description", "updated_at", "created_at"]
SortDirection = Literal["asc", "desc"]


def _apply_filters(
    stmt: Select[tuple[Item]],
    *,
    q: str | None,
    vendor_id: uuid.UUID | None,
    status: str | None,
) -> Select[tuple[Item]]:
    stmt = stmt.where(Item.deleted_at.is_(None))
    if vendor_id is not None:
        # Vendors live in ``meta.item_vendors`` now — filter items that have
        # the requested vendor in their assigned list.
        stmt = stmt.where(
            Item.id.in_(
                select(ItemVendor.item_id).where(
                    ItemVendor.vendor_id == vendor_id
                )
            )
        )
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Item.item_number).like(like),
                func.lower(Item.description).like(like),
            )
        )
    if status is not None:
        # Join the view explicitly so the filter works in both the
        # ``items`` select and the ``count()`` select. ``v_item_stock``
        # has one row per non-deleted item, so the inner join doesn't
        # change which items are eligible — only filters them by
        # computed ``status_code``.
        stmt = stmt.join(ItemStock, ItemStock.item_id == Item.id).where(
            ItemStock.status_code == status
        )
    return stmt


_SORT_COLUMNS = {
    "item_number": Item.item_number,
    "description": Item.description,
    "updated_at": Item.updated_at,
    "created_at": Item.created_at,
}


async def list_items(
    session: AsyncSession,
    *,
    q: str | None = None,
    vendor_id: uuid.UUID | None = None,
    status: str | None = None,
    sort: SortField = "item_number",
    direction: SortDirection = "asc",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Item], int]:
    """Return ``(items, total)``. Total is the unpaged count."""
    base = _apply_filters(
        select(Item),
        q=q,
        vendor_id=vendor_id,
        status=status,
    )

    count_stmt = _apply_filters(
        select(func.count()).select_from(Item),
        q=q,
        vendor_id=vendor_id,
        status=status,
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


async def get_item_by_number(session: AsyncSession, item_number: str) -> Item | None:
    stmt = select(Item).where(
        Item.item_number == item_number,
        Item.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_item(
    session: AsyncSession,
    *,
    item_number: str,
    description: str,
    created_by_user_id: uuid.UUID,
    avg_lead_days: int | None = None,
    reorder_threshold: Decimal = Decimal("0"),
    near_expiry_threshold_days: int = 30,
) -> Item:
    """Insert an item row (no vendors yet). Caller commits.

    Assigned vendors are written separately via ``replace_item_vendors`` so
    the FK validation / audit happen at the route layer.
    """
    item = Item(
        item_number=item_number,
        description=description,
        avg_lead_days=avg_lead_days,
        reorder_threshold=reorder_threshold,
        near_expiry_threshold_days=near_expiry_threshold_days,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(item)
    await session.flush()
    # Re-read so eager relationships (vendors, stock) populate. The naive
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
    commits. ``patch`` carries scalar item columns only — vendor changes go
    through ``replace_item_vendors``.
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
        "description": item.description,
        "vendor_ids": sorted(str(iv.vendor_id) for iv in item.vendors),
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
      * ``po_value``    — Σ over the item's ON_ORDER lots of
        (``ordered_qty`` × ``unit_price_amount``).
      * ``qty_on_order``— Σ ``ordered_qty`` over the item's ON_ORDER lots.

    Items with no priced stock and no on-order lots are absent from the dict;
    callers default the missing entries to zero.
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

    po_stmt = (
        select(
            Lot.item_id,
            func.coalesce(func.sum(Lot.ordered_qty * Lot.unit_price_amount), 0),
            func.coalesce(func.sum(Lot.ordered_qty), 0),
        )
        .where(
            Lot.item_id.in_(item_ids),
            Lot.status == "on_order",
            Lot.deleted_at.is_(None),
        )
        .group_by(Lot.item_id)
    )
    for item_id, po_value, qty_on_order in (await session.execute(po_stmt)).all():
        row = _row(item_id)
        row[1] = Decimal(po_value)
        row[2] = Decimal(qty_on_order)

    return {k: (v[0], v[1], v[2]) for k, v in rows.items()}


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
    vendor_id: uuid.UUID | None = None,
    manufacture_date: date | None = None,
    expiration_date: date | None = None,
    status: str = "available",
    notes: str | None = None,
    unit_price_amount: Decimal | None = None,
    po_reference: str | None = None,
    ordered_qty: Decimal | None = None,
    receipt_transaction_id: uuid.UUID | None = None,
    parent_lot_id: uuid.UUID | None = None,
) -> Lot:
    """Insert a lot row. Caller commits.

    Receipt Admin v2 fields (``unit_price_amount``, ``po_reference``,
    ``ordered_qty``, ``receipt_transaction_id``, ``parent_lot_id``) default to
    None so existing callers (admin lot create, direct receipt) are unaffected.
    ``ordered_qty`` is planning data for ON_ORDER lots; on-hand stays
    ledger-derived.
    """
    lot = Lot(
        item_id=item_id,
        lot_number=lot_number.strip(),
        vendor_id=vendor_id,
        manufacture_date=manufacture_date,
        expiration_date=expiration_date,
        status=status,
        notes=notes,
        unit_price_amount=unit_price_amount,
        po_reference=po_reference,
        ordered_qty=ordered_qty,
        receipt_transaction_id=receipt_transaction_id,
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
        "vendor_id": str(lot.vendor_id) if lot.vendor_id else None,
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


# ── Item vendors ───────────────────────────────────────────────────────
#
# An item's assigned-vendor list (``meta.item_vendors``). These are the only
# vendors an item can be received against.


async def list_item_vendors(
    session: AsyncSession, item_id: uuid.UUID
) -> list[ItemVendor]:
    """Assigned vendors for an item (oldest first), vendor joined."""
    stmt = (
        select(ItemVendor)
        .where(ItemVendor.item_id == item_id)
        .order_by(ItemVendor.created_at)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def item_vendor_ids(
    session: AsyncSession, item_id: uuid.UUID
) -> set[uuid.UUID]:
    """The set of vendor ids assigned to an item — used to validate that an
    intake / receive vendor is one of the item's vendors.
    """
    stmt = select(ItemVendor.vendor_id).where(ItemVendor.item_id == item_id)
    return set((await session.execute(stmt)).scalars().all())


async def replace_item_vendors(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    vendor_ids: list[uuid.UUID],
    created_by_user_id: uuid.UUID,
) -> None:
    """Make the item's assigned-vendor list exactly ``vendor_ids``.

    Adds the missing ones, removes the extras, leaves unchanged rows alone
    (so ``created_at`` / ``created_by`` are preserved for kept vendors).
    Caller commits. Vendor FKs are assumed validated by the caller.
    """
    target = list(dict.fromkeys(vendor_ids))  # de-dup, keep order
    existing = {iv.vendor_id: iv for iv in await list_item_vendors(session, item_id)}

    for vid in target:
        if vid not in existing:
            session.add(
                ItemVendor(
                    item_id=item_id,
                    vendor_id=vid,
                    created_by_user_id=created_by_user_id,
                )
            )
    target_set = set(target)
    for vid, iv in existing.items():
        if vid not in target_set:
            await session.delete(iv)

    await session.flush()


# ── Receipt transactions ───────────────────────────────────────────────


async def create_receipt_transaction(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    created_by_user_id: uuid.UUID,
    po_reference: str | None = None,
    notes: str | None = None,
) -> ReceiptTransaction:
    """Insert an ``open`` receipt-transaction header. Caller commits."""
    txn = ReceiptTransaction(
        item_id=item_id,
        status="open",
        po_reference=po_reference,
        notes=notes,
        created_by_user_id=created_by_user_id,
    )
    session.add(txn)
    await session.flush()
    refreshed = await get_receipt_transaction(session, txn.id)
    assert refreshed is not None
    return refreshed


async def get_receipt_transaction(
    session: AsyncSession, txn_id: uuid.UUID
) -> ReceiptTransaction | None:
    """Load a transaction with its (non-deleted) lots eager-loaded.

    ``populate_existing`` forces the eager ``lots`` collection to refresh
    even when the transaction instance is already in the session identity
    map. Without it, the intake flow (which loads the txn once with an
    empty ``lots`` before adding lots, then re-reads) would return the
    stale empty collection, and the receive flow would show pre-mutation
    lot statuses.
    """
    stmt = (
        select(ReceiptTransaction)
        .where(ReceiptTransaction.id == txn_id)
        .options(selectinload(ReceiptTransaction.lots))
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_receipt_transactions(
    session: AsyncSession,
    *,
    item_id: uuid.UUID | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ReceiptTransaction], int]:
    """Return ``(transactions, total)`` newest first, lots eager-loaded."""

    def _apply(stmt):
        if item_id is not None:
            stmt = stmt.where(ReceiptTransaction.item_id == item_id)
        if status is not None:
            stmt = stmt.where(ReceiptTransaction.status == status)
        return stmt

    count_stmt = _apply(select(func.count()).select_from(ReceiptTransaction))
    total = int((await session.execute(count_stmt)).scalar_one())

    base = _apply(
        select(ReceiptTransaction).options(
            selectinload(ReceiptTransaction.lots)
        )
    )
    base = (
        base.order_by(desc(ReceiptTransaction.created_at)).limit(limit).offset(offset)
    )
    rows = (await session.execute(base)).scalars().unique().all()
    return list(rows), total


async def set_receipt_transaction_status(
    session: AsyncSession,
    *,
    txn: ReceiptTransaction,
    status: str,
    received_by_user_id: uuid.UUID | None = None,
) -> ReceiptTransaction:
    """Flip a transaction's status (``received`` stamps the receiver).
    Caller commits.
    """
    txn.status = status
    if status == "received":
        txn.received_by_user_id = received_by_user_id
        txn.received_at = datetime.now(UTC)
    await session.flush()
    refreshed = await get_receipt_transaction(session, txn.id)
    assert refreshed is not None
    return refreshed


def receipt_transaction_to_audit_snapshot(
    txn: ReceiptTransaction,
) -> dict[str, object | None]:
    return {
        "item_id": str(txn.item_id),
        "status": txn.status,
        "po_reference": txn.po_reference,
        "notes": txn.notes,
        "received_by_user_id": (
            str(txn.received_by_user_id) if txn.received_by_user_id else None
        ),
        "received_at": txn.received_at.isoformat() if txn.received_at else None,
    }
