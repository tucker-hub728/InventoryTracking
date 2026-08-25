"""Persistence helpers for the inventory module.

Routes never call SQLAlchemy directly — they go through this module so
query shape stays consistent and tests can fake one place.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal, NamedTuple

from sqlalchemy import Date, Select, asc, cast, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.search import like_contains
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
from app.notifications.pending import mark_item

# Whitelist for the ``status`` query filter. Aligned with the
# ``status_code`` values produced by ``app.v_item_stock``.
ITEM_STATUS_CODES: tuple[str, ...] = ("available", "low_stock", "out_of_stock")


# ── Suppliers ────────────────────────────────────────────────────────────


async def list_suppliers(
    session: AsyncSession,
    *,
    active_only: bool = True,
    is_active: bool | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[Supplier], int]:
    """Return ``(rows, total)`` of suppliers, ordered by name.

    Two ways to filter on the active flag, because two callers want different
    things. ``active_only=True`` is the picker's "hide the deactivated ones";
    ``is_active`` is the admin page's Active / Deactivated tab split and can ask
    for the inactive side, which ``active_only`` has no way to express. When
    ``is_active`` is given it wins — the caller was explicit.

    ``limit=None`` returns every matching row, which is what the item-edit
    supplier picker needs (it renders a searchable select over the full list).
    """
    conditions = []
    if is_active is not None:
        conditions.append(Supplier.is_active.is_(is_active))
    elif active_only:
        conditions.append(Supplier.is_active.is_(True))
    if q:
        like = like_contains(q.lower())
        conditions.append(
            or_(
                func.lower(Supplier.name).like(like, escape="\\"),
                func.lower(Supplier.contact_email).like(like, escape="\\"),
            )
        )

    total = int(
        (
            await session.execute(
                select(func.count()).select_from(Supplier).where(*conditions)
            )
        ).scalar_one()
    )

    stmt = select(Supplier).where(*conditions).order_by(func.lower(Supplier.name))
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list((await session.execute(stmt)).scalars().all()), total


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
    lead_time_days: int | None = None,
) -> Supplier:
    """Insert a supplier row. Caller commits."""
    supplier = Supplier(
        name=name.strip(),
        contact_email=contact_email,
        phone=phone,
        notes=notes,
        is_active=is_active,
        lead_time_days=lead_time_days,
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
        # Audited because it moves a reorder signal: raising a lead time from
        # 7 to 60 days changes when every item this supplier stocks is flagged,
        # and "who widened the buffer?" is a question the log should answer.
        "lead_time_days": supplier.lead_time_days,
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
    min_bom_lines: int | None = None,
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
    if min_bom_lines is not None and min_bom_lines > 0:
        # Items whose BOM has at least N distinct components. Kitting uses this
        # with N=2: every composition rule in Transaction_Spec §1.1 is
        # two-input (CR+CR→AY, AY+AY→AY, CR+AY→FG), so a one-line "recipe" is
        # an incomplete BOM, not something you can gather a kit for.
        enough_lines = (
            select(BomLine.parent_item_id)
            .where(BomLine.deleted_at.is_(None))
            .group_by(BomLine.parent_item_id)
            .having(func.count(BomLine.id) >= min_bom_lines)
        )
        stmt = stmt.where(Item.id.in_(enough_lines))
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
        like = like_contains(q.lower())
        stmt = stmt.where(
            or_(
                # The number is derived, so match its parts: the suffix, the
                # description, or the prefix code (so "PRR" finds all PRR items).
                func.lower(Item.sku_suffix).like(like, escape="\\"),
                func.lower(Item.description).like(like, escape="\\"),
                Item.prefix_id.in_(
                    select(ItemPrefix.id).where(func.lower(ItemPrefix.code).like(like, escape="\\"))
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
    min_bom_lines: int | None = None,
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
        min_bom_lines=min_bom_lines,
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
        min_bom_lines=min_bom_lines,
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
    """Live item with this (prefix, suffix) — the uniqueness pair.

    Matched case-insensitively: suffixes are stored upper-cased by the schema
    validator, so a differently-cased URL still resolves.
    """
    stmt = select(Item).where(
        Item.prefix_id == prefix_id,
        func.lower(Item.sku_suffix) == sku_suffix.lower(),
        Item.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_item_by_number(session: AsyncSession, item_number: str) -> Item | None:
    """Resolve a full SKU (``<prefix code>-<suffix>``) back to its item.

    The number is derived, not stored, so it has to be split back into a prefix
    code and a suffix — but the split point is **ambiguous**, because a prefix
    code may itself contain ``-`` (e.g. ``AS-TEST-002`` is ``AS-TEST`` + ``002``,
    not ``AS`` + ``TEST-002``). Splitting on the first ``-`` therefore fails for
    such codes.

    Instead, match the number against the real (live) prefix list: try every
    code the number starts with, longest first, and return the first one that
    actually resolves to an item. That is deterministic, handles dashed codes,
    and — because it verifies the item exists — still finds the right row when
    two codes overlap (``AS`` and ``AS-TEST`` both present).

    The prefix table is small (one row per admin-defined code), so loading it is
    cheap compared with guessing.
    """
    number = item_number.strip()
    if not number:
        return None
    prefixes = (
        (
            await session.execute(
                select(ItemPrefix).where(ItemPrefix.deleted_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    lowered = number.lower()
    candidates = [p for p in prefixes if lowered.startswith(f"{p.code.lower()}-")]
    # Longest code first: 'AS-TEST' must win over 'AS' for 'AS-TEST-002'.
    candidates.sort(key=lambda p: len(p.code), reverse=True)
    for prefix in candidates:
        suffix = number[len(prefix.code) + 1 :]
        if not suffix:
            continue
        item = await get_item_by_prefix_suffix(session, prefix.id, suffix)
        if item is not None:
            return item
    return None


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
    # An item can be created already below its own threshold — somebody typing
    # in a reagent they know is short. No stock moves, so nothing else would
    # ever notice.
    mark_item(session, item.id)
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
    # Raising a threshold breaches it without a single unit moving, and is
    # exactly how a planner reacts to a near-miss. Marked unconditionally
    # rather than only when ``reorder_threshold`` is in the patch: an item can
    # also leave the alerting set by being restored, and the evaluation is a
    # no-op when nothing crossed a line.
    mark_item(session, item.id)
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


def outstanding_order_units_expr():
    """``(received_subquery, outstanding_expr)`` — what an Order line still owes.

    Outstanding (v3) = ``ordered_qty − Σ received`` on a line, clamped at 0, in
    ORDER units. Lots are created at receive, so there are no ON_ORDER lots any
    more and on-order is line-derived.

    Extracted so :func:`compute_item_valuations` (which feeds the item page's
    "On-PO $") and the finance export's on-order rows share ONE definition.
    They have to agree exactly: the export publishes a per-line breakdown next
    to the item-level total, and finance reconciles the two. A copied
    expression would tie out today and drift the first time either side gained
    a filter.

    Returns a fresh subquery each call — the caller joins it into their own
    statement, so handing back a shared object would alias two queries.
    """
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
    return received_sub, outstanding


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
        (outstanding × line ``unit_price_amount``). Both factors are in ORDER
        units, so the product is correct with no conversion.
      * ``qty_on_order``— Σ outstanding over the item's open Order lines,
        **converted to CONSUME units** (× ``units_per_pack``, REQ-001) so it is
        comparable with the on-hand figure it is displayed next to.

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

    # Outstanding per Order line = ordered − Σ received (clamped at 0). Shared
    # with the finance export so the per-line breakdown it publishes sums to
    # the ``po_value`` computed here.
    received_sub, outstanding = outstanding_order_units_expr()
    po_stmt = (
        select(
            ReceiptTransactionLine.item_id,
            # Money needs no conversion: ``outstanding`` is in order units and
            # ``unit_price_amount`` is per order unit, so 2 Box × $95.00/Box is
            # already the right $190.00. Converting either half would double-count.
            func.coalesce(
                func.sum(outstanding * ReceiptTransactionLine.unit_price_amount), 0
            ),
            # The COUNT does need it (REQ-001). ``outstanding`` is in order units
            # — 2 Box — but this figure is shown beside on-hand, which is in
            # consume units. Reporting "on order 2 · on hand 300" for one item
            # would be read as a shortfall. NULL ``units_per_pack`` is a line
            # ordered in consume units already, hence the coalesce to 1.
            func.coalesce(
                func.sum(
                    outstanding
                    * func.coalesce(ReceiptTransactionLine.units_per_pack, 1)
                ),
                0,
            ),
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


# ── Synthesized lot numbers (REQ-003) ─────────────────────────────────
#
# A non-lot-controlled item can be received without a lot number, but
# ``lots.lot_number`` is NOT NULL and ~270 places read it expecting a string, so
# the server invents one rather than making the column nullable.

SYNTHETIC_LOT_PREFIX = "AUTO-"


def is_synthetic_lot_number(lot_number: str | None) -> bool:
    """True for a number this system generated rather than a human entering it.

    Deliberately a prefix test on stored data and not a stored boolean. A flag
    would be one more column to keep true, and the prefix is already the thing
    every reader — operator, auditor, exported spreadsheet — actually sees. The
    cost is that a human CAN type "AUTO-…" by hand; that is why the receive
    route refuses to accept one, so the prefix stays honest at the only door
    that writes it.
    """
    return bool(lot_number) and lot_number.startswith(SYNTHETIC_LOT_PREFIX)


def uses_reserved_lot_prefix(lot_number: str | None) -> bool:
    """True for input a human must not be allowed to submit as a lot number.

    Case-INSENSITIVE, unlike ``is_synthetic_lot_number`` above, and the two are
    deliberately different questions. That one classifies what is already
    stored: only the exact prefix the generator emits counts, so a vendor lot
    that happens to read "auto-1" is not mislabelled as machine-made. This one
    guards the input door, where the stricter reading is correct — "auto-…"
    accepted by hand would sit one shift key away from an identifier the whole
    system treats as reserved, and the uniqueness index is case-sensitive, so
    both spellings could coexist and read identically on a label.
    """
    return bool(lot_number) and lot_number.upper().startswith(SYNTHETIC_LOT_PREFIX)


async def next_synthetic_lot_number(
    session: AsyncSession, *, item_id: uuid.UUID, received_on: date
) -> str:
    """Mint the next ``AUTO-YYYYMMDD-N`` for one item on one day.

    Readable on purpose. A UUID fragment would be collision-proof and unreadable,
    and this string ends up in a GxP receiving record, on a label, and in an
    auditor's spreadsheet — "AUTO-20260821-2" says machine-generated, when, and
    which delivery of that day at a glance.

    The count is scoped to (item, day), which is the same scope as the
    partial-unique index it has to satisfy. It is NOT a reservation: two
    concurrent receives can compute the same N. That race is left to the index —
    the caller retries — because taking a lock here would serialise every receipt
    of every non-lot item to remove a collision that needs two receivers booking
    the same item in the same second.

    **Two known limits, kept deliberately** (client call, 2026-08-24 — the format
    was reviewed and left as it is):

    * The item is not in the string, and uniqueness is only enforced per item, so
      two different items received on the same day both read "AUTO-20260821-1".
      They are distinct rows; they are indistinguishable on a label or in an
      export that does not carry the item beside them.
    * The sequence is unpadded, so lot numbers sort as text differently than as
      numbers: ``-10`` lands between ``-1`` and ``-2``.

    Both are fixed by putting the item number in and zero-padding, which is a
    change to this function alone — no migration, and existing lots keep their
    numbers. Do not "tidy" either of these without asking; they were chosen.
    """
    stamp = received_on.strftime("%Y%m%d")
    like = f"{SYNTHETIC_LOT_PREFIX}{stamp}-%"
    # Soft-deleted rows are counted deliberately: the unique index ignores them,
    # but reusing a number a deleted lot once carried would make two different
    # receipts share an identifier in the audit trail.
    stmt = select(func.count()).select_from(Lot).where(
        Lot.item_id == item_id,
        Lot.lot_number.like(like),
    )
    used = int((await session.execute(stmt)).scalar_one())
    return f"{SYNTHETIC_LOT_PREFIX}{stamp}-{used + 1}"


async def lot_number_exists(session: AsyncSession, *, lot_number: str) -> bool:
    """True if any live lot (of any item) already uses this lot number.

    Enforces global uniqueness for operator-entered produced-batch lot numbers in
    kitting (client 2026-07-24): the operator types the lot number at produce /
    close-out, so it must not collide with an existing lot anywhere."""
    stmt = select(Lot.id).where(
        Lot.lot_number == lot_number.strip(),
        Lot.deleted_at.is_(None),
    ).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


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
    release_state: str | None = None,
    notes: str | None = None,
    unit_price_amount: Decimal | None = None,
    po_reference: str | None = None,
    # Integer, not Decimal: the column is ``Integer`` and always was, and the
    # annotation was simply wrong. It matters more since REQ-001, because this
    # value is now the product of a conversion — a Decimal or float slipping
    # through reaches Postgres as a DataError at flush time rather than a 422
    # at the edge, which is the failure mode app/core/bounds.py exists to avoid.
    ordered_qty: int | None = None,
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
        # Defaults to None, NOT to 'quarantine': most lots created through here
        # are received consumables and raw materials, which have no release
        # workflow. Only manufacture passes a value (STS-001).
        release_state=release_state,
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
        # The release state rides in the same snapshot, so a signed change
        # shows up as a before/after diff in the audit store — which is where
        # STS-002's "who and when" record lives (there is no history table).
        "release_state": lot.release_state,
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


async def lot_release_states(
    session: AsyncSession, lot_ids: set[uuid.UUID]
) -> dict[uuid.UUID, str | None]:
    """``{lot_id: release_state}`` for the lots asked about (STS-001).

    Only lots that HAVE a state are returned, so callers should ``.get()`` and
    treat a miss as "no release workflow applies" — which is the common case,
    every consumable and raw material.
    """
    if not lot_ids:
        return {}
    stmt = select(Lot.id, Lot.release_state).where(
        Lot.id.in_(lot_ids), Lot.release_state.is_not(None)
    )
    return {row[0]: row[1] for row in (await session.execute(stmt)).all()}


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

# Ledger order: newest first, with a deterministic tie-break.
#
# Both legs of a transfer are written in ONE transaction and share
# ``performed_at`` to the microsecond, so ordering on the timestamp alone left
# their relative position to whatever the planner happened to return. It came
# back out-above-in, which reads bottom-up (oldest first) as "transferred in,
# then transferred out" — backwards, since a transfer must leave the source
# before it arrives at the destination.
#
# ``paired_movement_id`` is set ONLY on the second leg (the ``transfer_in``
# links back at the ``transfer_out`` inserted before it), so it is exactly the
# "this happened second" marker: descending puts it above its partner in a
# newest-first list, and the pair then reads out → in from the bottom up.
#
# The id tie-break is arbitrary but stable, which OFFSET pagination needs — an
# order that isn't total can skip or repeat rows across page boundaries.
_LEDGER_ORDER = (
    desc(StockMovement.performed_at),
    desc(StockMovement.paired_movement_id.isnot(None)),
    desc(StockMovement.id),
)


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
        base.order_by(*_LEDGER_ORDER)
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


async def movements_by_ids(
    session: AsyncSession, ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, StockMovement]:
    """Fetch movements by id, keyed for reassembly by the caller.

    Unordered on purpose: the audit timeline hydrates one page of ids that it
    has already ordered, and re-sorting here would just be thrown away.
    """
    if not ids:
        return {}
    rows = (
        (await session.execute(select(StockMovement).where(StockMovement.id.in_(ids))))
        .scalars()
        .unique()
        .all()
    )
    return {row.id: row for row in rows}


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


# ── The order-unit / consume-unit boundary (REQ-001) ──────────────────
#
# Exactly two functions convert, and everything that needs to cross the
# boundary calls one of them. Written out rather than inlined because the two
# directions are trivially confusable — ``3`` and ``300`` are both plausible
# values in either column — and a silent × instead of ÷ produces a number that
# is wrong by two orders of magnitude while looking entirely reasonable.


def packs_to_units(qty_packs: int, units_per_pack: int | None) -> int:
    """Order units → consume units. 3 Box of 100 → 300 Each.

    ``units_per_pack`` of ``None`` means the line was ordered in consume units
    already (every line predating REQ-001), so the value passes through.
    """
    if units_per_pack is None:
        return qty_packs
    return qty_packs * units_per_pack


def units_to_packs(qty_units: int, units_per_pack: int | None) -> int:
    """Consume units → order units. 300 Each of 100 → 3 Box.

    Raises when the division is not exact. That is not defensiveness for its own
    sake: the only caller is the lot-quantity correction, which re-syncs an
    Order line's received total from a lot's placed quantity. A lot holding 250
    units of a 100-pack does not correspond to any whole number of boxes, so
    there is no honest value to write back — and writing 2 (or 3) would quietly
    move the order's fulfilment state to something nobody chose.
    """
    if units_per_pack is None:
        return qty_units
    packs, remainder = divmod(qty_units, units_per_pack)
    if remainder:
        raise ValueError(
            f"{qty_units} units is not a whole number of packs of {units_per_pack}"
        )
    return packs


async def add_order_line(
    session: AsyncSession,
    *,
    txn_id: uuid.UUID,
    line_no: int,
    item_id: uuid.UUID,
    supplier_id: uuid.UUID,
    ordered_qty: int,
    unit_price_amount: Decimal | None = None,
    pack_uom: str | None = None,
    units_per_pack: int | None = None,
) -> ReceiptTransactionLine:
    """Insert one Order line. Caller commits.

    ``ordered_qty`` and ``unit_price_amount`` are in ORDER units (3 Box at
    $95.00 per Box). ``pack_uom`` / ``units_per_pack`` are the line's own record
    of what a Box is — the item carries no pack to copy from, so this row is the
    only place the answer lives, and later edits to anything else cannot rewrite
    it. Nothing is multiplied here: the conversion to consume units happens
    once, at receive.
    """
    line = ReceiptTransactionLine(
        receipt_transaction_id=txn_id,
        line_no=line_no,
        item_id=item_id,
        supplier_id=supplier_id,
        ordered_qty=ordered_qty,
        unit_price_amount=unit_price_amount,
        pack_uom=pack_uom,
        units_per_pack=units_per_pack,
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
    q: str | None = None,
    statuses: Sequence[str] | None = None,
    archived: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ReceiptTransaction], int]:
    """Return ``(orders, total)`` newest first, lines + events eager-loaded.

    Soft-deleted Orders are always excluded.

    ``archived`` selects which side of the archiving policy to look at
    (DATA-001): the default ``False`` is the working list, ``True`` is the
    archive. There is no "both" — a list that mixes them is the crowded list
    the requirement exists to fix, and the caller that wants everything can ask
    twice.

    ``statuses`` takes several at once, because the list's filter is a set of
    ticked statuses rather than one choice — the working default is open +
    partially received (DATA-003), which is two of them.

    ``q`` searches the PO reference, the item number / description on any line,
    and the lot number on any receive event — the same three things the page
    used to filter for in the browser. It has to be done HERE, because a search
    applied to the fetched page can only ever find what that page happened to
    contain, which quietly turns "no results" into "no results in the first 200".
    """

    def _apply(stmt):
        stmt = stmt.where(ReceiptTransaction.deleted_at.is_(None))
        stmt = stmt.where(
            ReceiptTransaction.archived_at.is_not(None)
            if archived
            else ReceiptTransaction.archived_at.is_(None)
        )
        if statuses:
            stmt = stmt.where(ReceiptTransaction.status.in_(statuses))
        if q:
            like = like_contains(q.lower())
            # EXISTS rather than JOIN: an Order with four matching lines must
            # still be ONE row, and a join would multiply it (and the count).
            line_match = (
                select(ReceiptTransactionLine.id)
                .join(Item, Item.id == ReceiptTransactionLine.item_id)
                .join(ItemPrefix, ItemPrefix.id == Item.prefix_id, isouter=True)
                .where(
                    ReceiptTransactionLine.receipt_transaction_id
                    == ReceiptTransaction.id,
                    or_(
                        # ``item_number`` is a PROPERTY — "<prefix code>-<suffix>"
                        # — with no column behind it, so the whole number has to
                        # be rebuilt here. Matching only the pieces made a search
                        # for "CR-001" (what the operator actually reads off the
                        # screen) return nothing at all.
                        func.lower(
                            func.concat(ItemPrefix.code, "-", Item.sku_suffix)
                        ).like(like, escape="\\"),
                        func.lower(Item.sku_suffix).like(like, escape="\\"),
                        func.lower(Item.description).like(like, escape="\\"),
                        func.lower(ItemPrefix.code).like(like, escape="\\"),
                    ),
                )
                .exists()
            )
            lot_match = (
                select(ReceiptEventLine.id)
                .join(ReceiptEvent, ReceiptEvent.id == ReceiptEventLine.receipt_event_id)
                .join(Lot, Lot.id == ReceiptEventLine.lot_id)
                .where(
                    ReceiptEvent.receipt_transaction_id == ReceiptTransaction.id,
                    func.lower(Lot.lot_number).like(like, escape="\\"),
                )
                .exists()
            )
            stmt = stmt.where(
                or_(
                    func.lower(ReceiptTransaction.po_reference).like(like, escape="\\"),
                    line_match,
                    lot_match,
                )
            )
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


def _placed_units_subquery():
    """Units already shelved per lot — the ``receipt`` side of the ledger.

    Shared by the receive-to-inventory queue and the awaiting-release total below so the
    two cannot drift: a lot is "still waiting" precisely to the extent that its
    ordered quantity exceeds what has been placed.
    """
    return (
        select(
            StockMovement.lot_id.label("lot_id"),
            func.coalesce(func.sum(StockMovement.qty_delta), 0).label("qty"),
        )
        .where(StockMovement.movement_type == "receipt")
        .group_by(StockMovement.lot_id)
        .subquery()
    )


def awaiting_release_units_subquery():
    """Correlated scalar: CONSUME units that have ARRIVED but are not placed.

    The same predicate as :func:`lots_awaiting_put_away`, expressed as a number
    per item so a list query can carry it without loading every lot. **Both must
    stay in step** — the banner on the item page and the Reorder screen would
    otherwise disagree about the same material, which is worse than either being
    wrong alone.

    Why this number matters to planning (PLN-001): stock in this state is on
    site and paid for. Counting it as missing sends a planner to raise a second
    order for material already in the building, which is the one mistake a
    reorder screen must not cause. Ordinary on-order quantity is deliberately
    NOT netted off (client, 2026-08-24) because it has not arrived and may be
    late; this HAS arrived, so the client's own "until stock physically
    arrives" rule puts it on the other side of the line.

    Manufactured output is excluded for the same reason it is excluded from the
    receive-to-inventory queue: a kit-produced lot is quarantined too, but releasing it is a
    quality decision, not a shelving task, and no amount of it means "do not
    order".
    """
    placed = _placed_units_subquery()
    remaining = Lot.ordered_qty - func.coalesce(placed.c.qty, 0)
    return (
        select(func.coalesce(func.sum(remaining), 0))
        .select_from(Lot)
        .outerjoin(placed, placed.c.lot_id == Lot.id)
        .where(
            Lot.item_id == Item.id,
            Lot.deleted_at.is_(None),
            Lot.release_state == "quarantine",
            Lot.receipt_transaction_line_id.is_not(None),
            Lot.ordered_qty.is_not(None),
            Lot.ordered_qty > func.coalesce(placed.c.qty, 0),
        )
        .correlate(Item)
        .scalar_subquery()
    )


async def awaiting_release_units(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """``{item_id: units awaiting release}`` for a page of items.

    Bulk, so the items list costs one extra query rather than one per row.
    Items with nothing waiting are absent from the mapping; callers default
    to zero.
    """
    if not item_ids:
        return {}
    placed = _placed_units_subquery()
    remaining = Lot.ordered_qty - func.coalesce(placed.c.qty, 0)
    stmt = (
        select(Lot.item_id, func.coalesce(func.sum(remaining), 0))
        .select_from(Lot)
        .outerjoin(placed, placed.c.lot_id == Lot.id)
        .where(
            Lot.item_id.in_(item_ids),
            Lot.deleted_at.is_(None),
            Lot.release_state == "quarantine",
            Lot.receipt_transaction_line_id.is_not(None),
            Lot.ordered_qty.is_not(None),
            Lot.ordered_qty > func.coalesce(placed.c.qty, 0),
        )
        .group_by(Lot.item_id)
    )
    return {row[0]: int(row[1]) for row in (await session.execute(stmt)).all()}


def on_order_units_subquery():
    """Correlated scalar: units on open purchase orders, in CONSUME units.

    Same definition of "outstanding" as :func:`compute_item_valuations` —
    ``ordered_qty − Σ received``, clamped at zero, over Orders that are neither
    cancelled nor soft-deleted — and the same REQ-001 conversion by
    ``units_per_pack``, so the figure is comparable with ``qty_available`` and
    ``reorder_threshold`` rather than being a count of boxes sitting next to a
    count of millilitres.

    Planning needs this to tell two very different situations apart: an item
    nobody has ordered, and an item whose delivery is simply not here yet.
    Before the split, both said "order this", so the Reorder screen was
    recommending a second purchase order for material already bought — on every
    row it was showing (client-reported 2026-08-24).

    Note this does NOT net the quantity off the shortfall. The client's rule
    stands: an item stays visible until stock physically arrives, because an
    order can be late or never come. What changes is the heading it appears
    under, not whether it appears.
    """
    received = (
        select(
            ReceiptEventLine.receipt_transaction_line_id.label("line_id"),
            func.coalesce(func.sum(ReceiptEventLine.qty_received), 0).label("recd"),
        )
        .group_by(ReceiptEventLine.receipt_transaction_line_id)
        .subquery()
    )
    outstanding = func.greatest(
        ReceiptTransactionLine.ordered_qty - func.coalesce(received.c.recd, 0),
        0,
    )
    return (
        select(
            func.coalesce(
                func.sum(
                    outstanding
                    * func.coalesce(ReceiptTransactionLine.units_per_pack, 1)
                ),
                0,
            )
        )
        .select_from(ReceiptTransactionLine)
        .join(
            ReceiptTransaction,
            ReceiptTransaction.id == ReceiptTransactionLine.receipt_transaction_id,
        )
        .outerjoin(received, received.c.line_id == ReceiptTransactionLine.id)
        .where(
            ReceiptTransactionLine.item_id == Item.id,
            ReceiptTransaction.deleted_at.is_(None),
            ReceiptTransaction.status != "cancelled",
        )
        .correlate(Item)
        .scalar_subquery()
    )


class NextOpenOrder(NamedTuple):
    """The open purchase order an item is next expecting stock from."""

    order_id: uuid.UUID
    po_reference: str
    #: ``order date + that line's supplier's lead time``. None when that
    #: supplier has no lead time recorded — the order is still real and still
    #: linked, there is just no date to project.
    expected_arrival: date | None
    #: How many open orders the item has in total, so a row can say the date
    #: it shows is the first of several rather than the only one.
    open_order_count: int


async def next_open_orders(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, NextOpenOrder]:
    """``{item_id: NextOpenOrder}`` — the soonest-landing open order per item.

    One bulk query rather than a correlated subquery per fact, because the date
    and the purchase order it came from must agree. Sourcing them separately
    invites the row to show one order's reference beside another order's date
    the moment two are open.

    "Soonest" is by projected arrival, with undated orders last: an order whose
    supplier has no lead time cannot be compared, so it only wins when nothing
    else is open. Ties break on order date, oldest first — the one that has been
    waiting longest is the one to chase.

    The projection uses the line's OWN supplier rather than the item-level worst
    case ``_lead_time_subquery`` uses. Those answer different questions: a
    planner deciding whether to buy needs the slowest supplier they might end up
    using; an order already placed has one actual supplier and one actual date,
    so there is nothing to guess.

    **The order date is ``created_at``** — there is no separate "ordered on"
    column; the row is created when the order is raised. For a blanket order
    ``valid_from`` is the better anchor (the delivery window can open long after
    the paperwork), so it wins when set.
    """
    if not item_ids:
        return {}
    received = (
        select(
            ReceiptEventLine.receipt_transaction_line_id.label("line_id"),
            func.coalesce(func.sum(ReceiptEventLine.qty_received), 0).label("recd"),
        )
        .group_by(ReceiptEventLine.receipt_transaction_line_id)
        .subquery()
    )
    outstanding = ReceiptTransactionLine.ordered_qty - func.coalesce(received.c.recd, 0)
    anchor = func.coalesce(
        ReceiptTransaction.valid_from,
        cast(ReceiptTransaction.created_at, Date),
    )
    expected = (anchor + Supplier.lead_time_days).label("expected")
    stmt = (
        select(
            ReceiptTransactionLine.item_id,
            ReceiptTransaction.id,
            ReceiptTransaction.po_reference,
            expected,
            ReceiptTransaction.created_at,
        )
        .select_from(ReceiptTransactionLine)
        .join(
            ReceiptTransaction,
            ReceiptTransaction.id == ReceiptTransactionLine.receipt_transaction_id,
        )
        .join(Supplier, Supplier.id == ReceiptTransactionLine.supplier_id)
        .outerjoin(received, received.c.line_id == ReceiptTransactionLine.id)
        .where(
            ReceiptTransactionLine.item_id.in_(item_ids),
            ReceiptTransaction.deleted_at.is_(None),
            ReceiptTransaction.status != "cancelled",
            outstanding > 0,
        )
    )
    out: dict[uuid.UUID, NextOpenOrder] = {}
    seen_orders: dict[uuid.UUID, set[uuid.UUID]] = {}
    for item_id, order_id, po_ref, eta, _created in (await session.execute(stmt)).all():
        seen_orders.setdefault(item_id, set()).add(order_id)
        best = out.get(item_id)
        # Rows arrive unordered; keep the soonest, undated last. Done in Python
        # rather than DISTINCT ON so the per-item order count comes from the
        # same pass instead of a second query that could disagree.
        if best is None or _sooner(eta, best.expected_arrival):
            out[item_id] = NextOpenOrder(order_id, po_ref, eta, 0)
    return {
        item_id: row._replace(open_order_count=len(seen_orders[item_id]))
        for item_id, row in out.items()
    }


def _sooner(candidate: date | None, current: date | None) -> bool:
    """Is ``candidate`` a better "next arrival" than ``current``?

    A dated order always beats an undated one — an unknown arrival is not
    evidence of an early one.
    """
    if candidate is None:
        return False
    if current is None:
        return True
    return candidate < current


async def lots_awaiting_put_away(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[Lot, int]]]:
    """``{item_id: [(lot, units still to place), …]}`` — the receive-to-inventory queue.

    Material that has ARRIVED but has not been received to inventory yet
    (REQ-004): quarantined, received against a purchase order, and with units
    left over the append-only receipt ledger.

    Derived rather than stored. A "pending receipt" column would be a second
    copy of a fact the ledger already holds, and the two would disagree the
    first time anyone placed a lot by another route. The predicate rides the
    existing partial index on ``release_state``.

    Deliberately excludes manufactured output: a kit-produced lot is also
    quarantined, but it was placed at close-out and its release is a quality
    decision rather than a receive-to-inventory. ``receipt_transaction_line_id`` is what
    tells the two apart.
    """
    if not item_ids:
        return {}
    # Same subquery the awaiting-release total uses — one definition of
    # "already placed", so the banner and the Reorder screen agree.
    placed = _placed_units_subquery()
    stmt = (
        select(Lot, func.coalesce(placed.c.qty, 0))
        .outerjoin(placed, placed.c.lot_id == Lot.id)
        .where(
            Lot.item_id.in_(item_ids),
            Lot.deleted_at.is_(None),
            Lot.release_state == "quarantine",
            Lot.receipt_transaction_line_id.is_not(None),
            Lot.ordered_qty.is_not(None),
            Lot.ordered_qty > func.coalesce(placed.c.qty, 0),
        )
        .order_by(Lot.created_at)
    )
    out: dict[uuid.UUID, list[tuple[Lot, int]]] = {}
    for lot, already in (await session.execute(stmt)).unique().all():
        remaining = int(lot.ordered_qty or 0) - int(already)
        out.setdefault(lot.item_id, []).append((lot, remaining))
    return out


async def get_order_line_for_lot(
    session: AsyncSession, lot_id: uuid.UUID
) -> ReceiptTransactionLine | None:
    """The Order line a lot was received against, via its receive-event draw.

    Needed to read the line's frozen ``units_per_pack`` when converting a lot's
    quantity (CONSUME units) back to the packs the line counts (REQ-001).
    Returns None for a lot with no receipt behind it — a seeded or
    directly-created lot — in which case there is nothing to convert.
    """
    stmt = (
        select(ReceiptTransactionLine)
        .join(
            ReceiptEventLine,
            ReceiptEventLine.receipt_transaction_line_id == ReceiptTransactionLine.id,
        )
        .where(ReceiptEventLine.lot_id == lot_id)
    )
    return (await session.execute(stmt)).scalars().unique().one_or_none()


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
        # Both in ORDER units — recorded alongside the pack below, because
        # "ordered_qty: 3" in an audit row is unreadable without it.
        "ordered_qty": line.ordered_qty,
        "unit_price_amount": (
            str(line.unit_price_amount)
            if line.unit_price_amount is not None
            else None
        ),
        "pack_uom": line.pack_uom,
        "units_per_pack": line.units_per_pack,
    }
