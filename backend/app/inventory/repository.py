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
    ItemApprovedVendor,
    ItemStock,
    Lot,
    ReceiptTransaction,
    StockMovement,
    UnitOfMeasure,
    Vendor,
)

# Whitelist for the ``status`` query filter. Aligned with the
# ``status_code`` values produced by ``app.v_item_stock``.
ITEM_STATUS_CODES: tuple[str, ...] = ("available", "low_stock", "out_of_stock")


async def list_uoms(session: AsyncSession) -> list[UnitOfMeasure]:
    stmt = select(UnitOfMeasure).order_by(UnitOfMeasure.code)
    return list((await session.execute(stmt)).scalars().all())


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
        stmt = stmt.where(Item.vendor_id == vendor_id)
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
    category: str | None = None,
    vendor_id: uuid.UUID | None = None,
    avg_lead_days: int | None = None,
    reorder_threshold: Decimal = Decimal("0"),
    near_expiry_threshold_days: int = 30,
    unit_price_amount: Decimal | None = None,
    units_per_package: int | None = None,
    uom_code: str = "unit",
    po_note: str | None = None,
    notes: str | None = None,
) -> Item:
    """Insert an item row. Caller commits.

    ``price_per_package_amount`` is computed at the API layer when both
    inputs are present — the doc's invariant trigger (§6.1) will be
    added when ``items`` writes go through the price-aware UI.
    """
    price_per_package = (
        unit_price_amount * units_per_package
        if unit_price_amount is not None and units_per_package is not None
        else None
    )
    item = Item(
        item_number=item_number,
        description=description,
        category=category,
        vendor_id=vendor_id,
        avg_lead_days=avg_lead_days,
        reorder_threshold=reorder_threshold,
        near_expiry_threshold_days=near_expiry_threshold_days,
        unit_price_amount=unit_price_amount,
        units_per_package=units_per_package,
        price_per_package_amount=price_per_package,
        uom_code=uom_code,
        po_note=po_note,
        notes=notes,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(item)
    await session.flush()
    # Re-read so joined-loaded relationships (vendor, uom) populate. The
    # naive ORM returns a half-hydrated instance after flush.
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
    commits.

    ``price_per_package_amount`` is **derived** from
    ``unit_price_amount × units_per_package`` whenever either input is
    touched (or both, or one of them is cleared). Kept in sync here so
    every read past this point reflects the relationship the long-spec
    will eventually enforce by trigger.
    """
    for col, value in patch.items():
        setattr(item, col, value)
    item.updated_by_user_id = updated_by_user_id
    # Recompute price_per_package if either input was in the patch.
    if "unit_price_amount" in patch or "units_per_package" in patch:
        if (
            item.unit_price_amount is not None
            and item.units_per_package is not None
        ):
            item.price_per_package_amount = (
                item.unit_price_amount * item.units_per_package
            )
        else:
            item.price_per_package_amount = None
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
        "category": item.category,
        "vendor_id": str(item.vendor_id) if item.vendor_id else None,
        "avg_lead_days": item.avg_lead_days,
        "reorder_threshold": str(item.reorder_threshold),
        "near_expiry_threshold_days": item.near_expiry_threshold_days,
        "unit_price_amount": (
            str(item.unit_price_amount) if item.unit_price_amount is not None else None
        ),
        "units_per_package": item.units_per_package,
        "uom_code": item.uom_code,
        "po_note": item.po_note,
        "notes": item.notes,
        "must_order_flag": item.must_order_flag,
        "deleted_at": item.deleted_at.isoformat() if item.deleted_at else None,
    }


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


# ── Receipt Admin v2 ───────────────────────────────────────────────────
#
# Approved-vendor mapping, dynamic vendor resolution, and the receipt
# transaction header. See docs/modules/receipt-admin.md.


async def get_or_create_vendor_by_name(
    session: AsyncSession, *, name: str
) -> tuple[Vendor, bool]:
    """Resolve a vendor by case-insensitive name, creating it if absent.

    Returns ``(vendor, created)``. Mirrors the dynamic-vendor edge case
    (v2 §6 case 2): an unknown vendor typed during a receipt is created
    on the fly. Caller commits.
    """
    existing = await get_vendor_by_name(session, name)
    if existing is not None:
        return existing, False
    vendor = await create_vendor(session, name=name)
    return vendor, True


async def item_has_approved_vendors(
    session: AsyncSession, item_id: uuid.UUID
) -> bool:
    """True iff the item has at least one ``approved`` vendor mapping.

    Drives the "suggest only approved vendors" behaviour and the
    ``unverified_vendor_for_item`` flag (only meaningful when a list exists).
    """
    stmt = (
        select(ItemApprovedVendor.id)
        .where(
            ItemApprovedVendor.item_id == item_id,
            ItemApprovedVendor.approval_status == "approved",
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def is_vendor_approved_for_item(
    session: AsyncSession, *, item_id: uuid.UUID, vendor_id: uuid.UUID
) -> bool:
    """True iff there's an ``approved`` mapping for this (item, vendor)."""
    stmt = (
        select(ItemApprovedVendor.id)
        .where(
            ItemApprovedVendor.item_id == item_id,
            ItemApprovedVendor.vendor_id == vendor_id,
            ItemApprovedVendor.approval_status == "approved",
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def vendor_used_on_item_before(
    session: AsyncSession, *, item_id: uuid.UUID, vendor_id: uuid.UUID
) -> bool:
    """True iff a (non-deleted) lot for this item already used this vendor.

    Used to compute ``vendor_not_previously_associated_with_item`` — a lot
    is "not previously associated" when neither a prior lot nor any
    approved/pending mapping links the vendor to the item.
    """
    lot_stmt = (
        select(Lot.id)
        .where(
            Lot.item_id == item_id,
            Lot.vendor_id == vendor_id,
            Lot.deleted_at.is_(None),
        )
        .limit(1)
    )
    if (await session.execute(lot_stmt)).first() is not None:
        return True
    map_stmt = (
        select(ItemApprovedVendor.id)
        .where(
            ItemApprovedVendor.item_id == item_id,
            ItemApprovedVendor.vendor_id == vendor_id,
        )
        .limit(1)
    )
    return (await session.execute(map_stmt)).first() is not None


async def list_approved_vendors(
    session: AsyncSession, item_id: uuid.UUID
) -> list[ItemApprovedVendor]:
    """Approved + pending vendor mappings for an item (approved first)."""
    stmt = (
        select(ItemApprovedVendor)
        .where(ItemApprovedVendor.item_id == item_id)
        .order_by(
            # 'approved' sorts before 'pending' alphabetically — good enough.
            ItemApprovedVendor.approval_status,
            ItemApprovedVendor.created_at,
        )
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def get_approved_vendor(
    session: AsyncSession, *, item_id: uuid.UUID, vendor_id: uuid.UUID
) -> ItemApprovedVendor | None:
    stmt = select(ItemApprovedVendor).where(
        ItemApprovedVendor.item_id == item_id,
        ItemApprovedVendor.vendor_id == vendor_id,
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def add_approved_vendor(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    vendor_id: uuid.UUID,
    approval_status: str,
    created_by_user_id: uuid.UUID,
) -> ItemApprovedVendor:
    """Insert an item↔vendor mapping. Caller handles the unique-violation
    path (already-mapped) and commits.
    """
    mapping = ItemApprovedVendor(
        item_id=item_id,
        vendor_id=vendor_id,
        approval_status=approval_status,
        created_by_user_id=created_by_user_id,
    )
    session.add(mapping)
    await session.flush()
    refreshed = await get_approved_vendor(
        session, item_id=item_id, vendor_id=vendor_id
    )
    assert refreshed is not None
    return refreshed


async def remove_approved_vendor(
    session: AsyncSession, *, mapping: ItemApprovedVendor
) -> None:
    """Hard-delete a mapping row (it carries no history). Caller commits."""
    await session.delete(mapping)
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
