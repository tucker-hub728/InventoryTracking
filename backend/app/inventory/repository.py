"""Persistence helpers for the inventory module.

Routes never call SQLAlchemy directly — they go through this module so
query shape stays consistent and tests can fake one place.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from sqlalchemy import Integer, Select, asc, cast, desc, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, lazyload, selectinload

from app.models.identity import User
from app.models.inventory import (
    Item,
    ItemStock,
    Location,
    Lot,
    StockMovement,
    UnitOfMeasure,
    Vendor,
)
from app.models.storage import (
    StorageAssignmentEvent,
    StoragePosition,
    StorageRack,
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
    prefix: str | None,
    vendor_id: uuid.UUID | None,
    status: str | None,
) -> Select[tuple[Item]]:
    stmt = stmt.where(Item.deleted_at.is_(None))
    if prefix:
        # Match e.g. "CM-" (or "CM" without the dash — accept either).
        normalized = prefix.upper().rstrip("-") + "-"
        stmt = stmt.where(Item.item_number.like(f"{normalized}%"))
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
    prefix: str | None = None,
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
        prefix=prefix,
        vendor_id=vendor_id,
        status=status,
    )

    count_stmt = _apply_filters(
        select(func.count()).select_from(Item),
        q=q,
        prefix=prefix,
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
    vendor_id: uuid.UUID | None = None,
    avg_lead_days: int | None = None,
    reorder_threshold: Decimal = Decimal("0"),
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
        vendor_id=vendor_id,
        avg_lead_days=avg_lead_days,
        reorder_threshold=reorder_threshold,
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
        "vendor_id": str(item.vendor_id) if item.vendor_id else None,
        "avg_lead_days": item.avg_lead_days,
        "reorder_threshold": str(item.reorder_threshold),
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


async def next_item_number(session: AsyncSession, prefix: str) -> str:
    """Suggest the next free ``XX-NNNN`` for the given prefix.

    Strategy: read the current MAX numeric suffix for the prefix, add 1,
    zero-pad to 4 digits. Races are acceptable because the actual INSERT
    is protected by the partial-unique index; on collision the caller
    retries with this endpoint or types their own number.
    """
    normalized = prefix.upper().rstrip("-")
    pattern = f"{normalized}-%"
    # Strip the ``XX-`` prefix and cast the remainder to int so we sort
    # numerically (``CM-0010`` > ``CM-0009``), not lexically.
    suffix = func.substring(Item.item_number, len(normalized) + 2)
    stmt = (
        select(func.max(cast(suffix, Integer)))
        .where(Item.item_number.like(pattern))
    )
    max_n = (await session.execute(stmt)).scalar_one_or_none()
    next_n = (max_n or 0) + 1
    return f"{normalized}-{next_n:04d}"


# ── Locations ──────────────────────────────────────────────────────────


async def list_locations(
    session: AsyncSession,
    *,
    active_only: bool = True,
    kind: str | None = None,
) -> list[Location]:
    stmt = select(Location)
    if active_only:
        stmt = stmt.where(Location.is_active.is_(True))
    if kind:
        stmt = stmt.where(Location.kind == kind)
    stmt = stmt.order_by(Location.kind, func.lower(Location.code))
    return list((await session.execute(stmt)).scalars().all())


async def get_location(
    session: AsyncSession, location_id: uuid.UUID
) -> Location | None:
    return (
        await session.execute(select(Location).where(Location.id == location_id))
    ).scalar_one_or_none()


async def get_location_by_code(
    session: AsyncSession, code: str
) -> Location | None:
    """Case-insensitive lookup — mirrors the partial-unique index."""
    stmt = select(Location).where(func.lower(Location.code) == code.lower())
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_location(
    session: AsyncSession,
    *,
    code: str,
    name: str,
    kind: str,
    temperature_c: Decimal | None = None,
    notes: str | None = None,
    is_active: bool = True,
) -> Location:
    """Insert a location row. Caller commits."""
    loc = Location(
        code=code.strip(),
        name=name.strip(),
        kind=kind,
        temperature_c=temperature_c,
        notes=notes,
        is_active=is_active,
    )
    session.add(loc)
    await session.flush()
    return loc


async def apply_location_patch(
    session: AsyncSession,
    *,
    location: Location,
    patch: dict[str, object],
) -> Location:
    """Apply a PATCH dict to a loaded location. Caller commits.

    Code / name are stripped on the way in (the schema validator
    already trimmed, but the seed migrations did not, so this is the
    defence-in-depth pass).
    """
    for col, value in patch.items():
        if col in ("code", "name") and isinstance(value, str):
            value = value.strip()
        setattr(location, col, value)
    await session.flush()
    return location


def location_to_audit_snapshot(loc: Location) -> dict[str, object | None]:
    return {
        "code": loc.code,
        "name": loc.name,
        "kind": loc.kind,
        "temperature_c": str(loc.temperature_c) if loc.temperature_c is not None else None,
        "notes": loc.notes,
        "is_active": loc.is_active,
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
    coa_url: str | None = None,
    status: str = "released",
    notes: str | None = None,
) -> Lot:
    """Insert a lot row. Caller commits."""
    lot = Lot(
        item_id=item_id,
        lot_number=lot_number.strip(),
        vendor_id=vendor_id,
        manufacture_date=manufacture_date,
        expiration_date=expiration_date,
        coa_url=coa_url,
        status=status,
        notes=notes,
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
        "coa_url": lot.coa_url,
        "status": lot.status,
        "notes": lot.notes,
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
    location_id: uuid.UUID | None = None,
    movement_type: MovementType | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[StockMovement], int]:
    """Return ``(movements, total)`` newest first.

    ``location_id`` matches movements that touch the location in either
    direction (``from`` OR ``to``) — useful for "everything that moved
    through freezer X."
    """
    base: Select[tuple[StockMovement]] = select(StockMovement)
    count_stmt = select(func.count()).select_from(StockMovement)

    def _apply(stmt):
        if item_id is not None:
            stmt = stmt.where(StockMovement.item_id == item_id)
        if lot_id is not None:
            stmt = stmt.where(StockMovement.lot_id == lot_id)
        if location_id is not None:
            stmt = stmt.where(
                or_(
                    StockMovement.from_location_id == location_id,
                    StockMovement.to_location_id == location_id,
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


async def list_stock_by_lot(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    location_id: uuid.UUID | None = None,
    only_positive: bool = True,
) -> list[dict]:
    """Per-lot-per-location available quantity for one item.

    Read from ``app.v_lot_stock`` (lazy projection over the ledger) and
    joined with ``app.lots`` + ``meta.locations`` so the picker has
    everything it needs in one round trip. Optionally narrows to a
    specific location.

    Returned shape mirrors ``StockByLotEntry`` — plain dicts so the
    serialisation layer can build the Pydantic model without an ORM
    facade for the view.
    """
    # asyncpg can't infer NULL parameter types; cast at the bind site.
    stmt = text(
        """
        SELECT
            v.lot_id::text       AS lot_id,
            l.lot_number          AS lot_number,
            l.status              AS lot_status,
            l.expiration_date     AS expiration_date,
            v.location_id::text   AS location_id,
            loc.code              AS location_code,
            loc.name              AS location_name,
            v.qty_available       AS qty_available,
            v.last_movement_at    AS last_movement_at
        FROM app.v_lot_stock v
        JOIN app.lots l       ON l.id = v.lot_id
        JOIN meta.locations loc ON loc.id = v.location_id
        WHERE v.item_id = CAST(:item_id AS uuid)
          AND l.deleted_at IS NULL
          AND (CAST(:location_id AS uuid) IS NULL OR v.location_id = CAST(:location_id AS uuid))
          AND (NOT CAST(:only_positive AS boolean) OR v.qty_available > 0)
        ORDER BY loc.code, l.expiration_date NULLS LAST, l.lot_number
        """
    )
    rows = (
        await session.execute(
            stmt,
            {
                "item_id": str(item_id),
                "location_id": str(location_id) if location_id else None,
                "only_positive": only_positive,
            },
        )
    ).mappings().all()
    # ``last_movement_at`` is already tz-aware from the view.
    return [dict(r) for r in rows]


async def get_lot_location_available(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    location_id: uuid.UUID,
) -> Decimal:
    """Return the current available qty for a (lot, location) pair.

    Returns ``Decimal("0")`` when the row doesn't exist in the view
    (no prior movement for this combo). Negative results are clamped
    to zero here so the route layer's check is "qty <= available."
    """
    stmt = text(
        """
        SELECT qty_available
        FROM app.v_lot_stock
        WHERE item_id = CAST(:item_id AS uuid)
          AND lot_id = CAST(:lot_id AS uuid)
          AND location_id = CAST(:location_id AS uuid)
        """
    )
    qty = (
        await session.execute(
            stmt,
            {
                "item_id": str(item_id),
                "lot_id": str(lot_id),
                "location_id": str(location_id),
            },
        )
    ).scalar_one_or_none()
    if qty is None or qty < 0:
        return Decimal("0")
    return Decimal(qty)


async def create_dispense_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str | None = None,
    notes: str | None = None,
    reference: str | None = None,
    destination: str | None = None,
) -> StockMovement:
    """Insert a ``dispense`` movement row. Caller commits.

    ``qty_delta = -qty`` (stock leaves) and ``qty_abs = qty``. The DB
    CHECK ``ck_movements_type_sign`` enforces dispenses must have
    negative deltas; we honour it here. The route is responsible for
    proving the caller isn't trying to dispense more than is available.
    ``destination`` is the free-text "where did it go" for the unit-out.
    """
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_id=from_location_id,
        to_location_id=None,
        movement_type="dispense",
        qty_delta=-qty,
        qty_abs=qty,
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        destination_text=destination,
        reversal_of_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    refreshed = await get_movement(session, movement.id)
    assert refreshed is not None
    return refreshed


async def create_discard_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str,
    notes: str | None = None,
    reference: str | None = None,
) -> StockMovement:
    """Insert a ``discard`` movement row. Caller commits.

    Same wire shape as ``create_dispense_movement`` but produces a
    distinct ``movement_type`` so the audit / variance reports can tell
    "used for purpose" from "thrown away" without parsing reason text.
    """
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_id=from_location_id,
        to_location_id=None,
        movement_type="discard",
        qty_delta=-qty,
        qty_abs=qty,
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        reversal_of_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    refreshed = await get_movement(session, movement.id)
    assert refreshed is not None
    return refreshed


async def create_adjustment_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    location_id: uuid.UUID,
    qty_delta: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str,
    notes: str | None = None,
    reference: str | None = None,
) -> StockMovement:
    """Insert an ``adjustment`` movement row. Caller commits.

    ``qty_delta`` is **signed** — positive bumps the balance, negative
    reduces it. ``qty_abs = abs(qty_delta)`` to satisfy the DB CHECK
    ``abs(qty_delta) = qty_abs``. Per the CHECK ``ck_movements_locations``,
    adjustments may have a from / to / neither set; we put the
    operator-supplied location on ``from_location_id`` for symmetry
    with dispense and to keep the ``v_lot_stock`` view's
    ``COALESCE(from, to)`` resolver working.

    The route is responsible for proving qty_delta != 0 and that
    negative deltas don't overdraw the lot/location balance.
    """
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_id=location_id,
        to_location_id=None,
        movement_type="adjustment",
        qty_delta=qty_delta,
        qty_abs=abs(qty_delta),
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        reversal_of_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    refreshed = await get_movement(session, movement.id)
    assert refreshed is not None
    return refreshed


async def create_receipt_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    to_location_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str | None = None,
    notes: str | None = None,
    reference: str | None = None,
) -> StockMovement:
    """Insert a ``receipt`` movement row. Caller commits.

    Quantities are stored as ``qty_delta = +qty`` (receipts add stock)
    and ``qty_abs = qty``. The DB CHECK ``ck_movements_type_sign``
    enforces that receipts must have positive deltas; we honour it here.

    No validation on inputs — the route handler is responsible for
    proving item / lot / location exist, evidence is valid, etc. This
    function trusts its caller and just inserts.
    """
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        to_location_id=to_location_id,
        from_location_id=None,
        movement_type="receipt",
        qty_delta=qty,
        qty_abs=qty,
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        reversal_of_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    # Re-read so joined-loaded relationships (item, lot, locations) hydrate.
    refreshed = await get_movement(session, movement.id)
    assert refreshed is not None
    return refreshed


# ── Transfer (two-leg) ─────────────────────────────────────────────────


async def create_transfer_pair(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_id: uuid.UUID,
    to_location_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str | None = None,
    notes: str | None = None,
    reference: str | None = None,
) -> tuple[StockMovement, StockMovement]:
    """Insert a ``transfer_out`` + ``transfer_in`` pair atomically.

    Both rows carry the same ``performed_at`` (server default at flush
    time is close enough for ordering — the linkage is via
    ``paired_movement_id``, not timestamp). ``transfer_in`` is the
    leg that holds the pair link; the ``transfer_out`` stays NULL on
    that column (the append-only trigger forbids back-fill).

    Caller commits. Caller is responsible for proving the source has
    enough stock and the locations differ.
    """
    out_leg = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_id=from_location_id,
        to_location_id=None,
        movement_type="transfer_out",
        qty_delta=-qty,
        qty_abs=qty,
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        reversal_of_id=None,
        paired_movement_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(out_leg)
    await session.flush()

    in_leg = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_id=None,
        to_location_id=to_location_id,
        movement_type="transfer_in",
        qty_delta=qty,
        qty_abs=qty,
        reason_code=reason_code,
        notes=notes,
        reference=reference,
        reversal_of_id=None,
        paired_movement_id=out_leg.id,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(in_leg)
    await session.flush()

    out_full = await get_movement(session, out_leg.id)
    in_full = await get_movement(session, in_leg.id)
    assert out_full is not None
    assert in_full is not None
    return out_full, in_full


# ── Reversal (counter-movement) ────────────────────────────────────────


async def get_existing_reversal(
    session: AsyncSession, original_id: uuid.UUID
) -> StockMovement | None:
    """Look up the counter-movement that already cancelled an original.

    Used by the reverse endpoint to refuse a double-reverse. Returns
    ``None`` when the original hasn't been reversed yet.
    """
    stmt = select(StockMovement).where(StockMovement.reversal_of_id == original_id)
    return (await session.execute(stmt)).scalars().first()


async def get_transfer_partner(
    session: AsyncSession, movement: StockMovement
) -> StockMovement | None:
    """Return the partner leg of a transfer.

    ``transfer_in`` rows carry ``paired_movement_id`` pointing at the
    ``transfer_out``; ``transfer_out`` rows are found via the reverse
    lookup. Returns ``None`` for non-transfer movements.
    """
    if movement.movement_type == "transfer_in":
        if movement.paired_movement_id is None:
            return None
        return await get_movement(session, movement.paired_movement_id)
    if movement.movement_type == "transfer_out":
        stmt = select(StockMovement).where(
            StockMovement.paired_movement_id == movement.id
        )
        return (await session.execute(stmt)).scalars().first()
    return None


async def create_reversal_movement(
    session: AsyncSession,
    *,
    original: StockMovement,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    reason_code: str,
    notes: str | None = None,
) -> StockMovement:
    """Insert a single counter-movement cancelling one original row.

    Movement-type mapping:
      * receipt    → dispense   (− qty_abs from original.to_location)
      * dispense   → receipt    (+ qty_abs into original.from_location)
      * discard    → receipt    (+ qty_abs into original.from_location)
      * adjustment → adjustment (− original.qty_delta at the same loc)
      * transfer_out → transfer_in (+ qty_abs into original.from_location)
      * transfer_in  → transfer_out (− qty_abs from original.to_location)

    Caller commits. Transfer reversals are NOT atomic-paired here —
    the route handler invokes this twice (once per leg) inside one
    transaction and links the two counters together.
    """
    qty = original.qty_abs
    counter_type: str
    from_loc: uuid.UUID | None
    to_loc: uuid.UUID | None
    qty_delta: Decimal
    qty_abs: Decimal

    if original.movement_type == "receipt":
        counter_type = "dispense"
        from_loc = original.to_location_id
        to_loc = None
        qty_delta = -qty
        qty_abs = qty
    elif original.movement_type == "dispense" or original.movement_type == "discard":
        counter_type = "receipt"
        from_loc = None
        to_loc = original.from_location_id
        qty_delta = qty
        qty_abs = qty
    elif original.movement_type == "adjustment":
        counter_type = "adjustment"
        # Adjustment ``from_location_id`` carries the operator-supplied
        # location (matches create_adjustment_movement).
        from_loc = original.from_location_id
        to_loc = None
        qty_delta = -original.qty_delta
        qty_abs = abs(qty_delta)
    elif original.movement_type == "transfer_out":
        counter_type = "transfer_in"
        from_loc = None
        to_loc = original.from_location_id
        qty_delta = qty
        qty_abs = qty
    elif original.movement_type == "transfer_in":
        counter_type = "transfer_out"
        from_loc = original.to_location_id
        to_loc = None
        qty_delta = -qty
        qty_abs = qty
    else:  # pragma: no cover — guarded by enum
        raise ValueError(
            f"unreversible movement_type {original.movement_type!r}"
        )

    counter = StockMovement(
        item_id=original.item_id,
        lot_id=original.lot_id,
        from_location_id=from_loc,
        to_location_id=to_loc,
        movement_type=counter_type,
        qty_delta=qty_delta,
        qty_abs=qty_abs,
        reason_code=reason_code,
        notes=notes,
        reference=None,
        reversal_of_id=original.id,
        paired_movement_id=None,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(counter)
    await session.flush()
    refreshed = await get_movement(session, counter.id)
    assert refreshed is not None
    return refreshed


# ── Storage (racks + positions) ────────────────────────────────────────
#
# The LN2 / Storage grid: Location → Rack(rows×cols) → Position. Positions
# are materialised on rack creation and immutable. See docs/modules/storage.md.


def _storage_position_label(row_idx: int, col_idx: int) -> str:
    """Human cell label: column-letter + row-number (col 3, row 2 -> 'C2').

    ``cols`` is capped at 26, so the column letter is always A–Z.
    """
    return f"{chr(ord('A') + col_idx - 1)}{row_idx}"


def _build_rack_positions(
    rack_id: uuid.UUID, rows: int, cols: int
) -> list[StoragePosition]:
    """Materialise a rack's empty positions, row-major (left→right, top→bottom)."""
    positions: list[StoragePosition] = []
    seq = 0
    for r in range(1, rows + 1):
        for c in range(1, cols + 1):
            seq += 1
            positions.append(
                StoragePosition(
                    rack_id=rack_id,
                    row_idx=r,
                    col_idx=c,
                    seq=seq,
                    label=_storage_position_label(r, c),
                    status="empty",
                )
            )
    return positions


def _slug_location_code(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").upper()
    return base or "LOC"


async def _unique_location_code(session: AsyncSession, base: str) -> str:
    taken = {
        c.lower()
        for c in (await session.execute(select(Location.code))).scalars().all()
    }
    if base.lower() not in taken:
        return base
    n = 2
    while f"{base}-{n}".lower() in taken:
        n += 1
    return f"{base}-{n}"


async def get_storage_location(
    session: AsyncSession, location_id: uuid.UUID
) -> tuple[Location, list[StorageRack]] | None:
    """Load a location plus its active racks (positions eager-loaded)."""
    loc = (
        await session.execute(select(Location).where(Location.id == location_id))
    ).scalar_one_or_none()
    if loc is None:
        return None
    racks = list(
        (
            await session.execute(
                select(StorageRack)
                .where(
                    StorageRack.location_id == location_id,
                    StorageRack.is_active.is_(True),
                )
                .options(selectinload(StorageRack.positions))
                .order_by(StorageRack.position_order, StorageRack.code)
            )
        )
        .scalars()
        .all()
    )
    return loc, racks


async def list_storage_locations(
    session: AsyncSession, *, active_only: bool = True
) -> list[tuple[Location, list[StorageRack]]]:
    """Every location that owns at least one active rack, hydrated + sorted."""
    racks = list(
        (
            await session.execute(
                select(StorageRack)
                .where(StorageRack.is_active.is_(True))
                .options(selectinload(StorageRack.positions))
                .order_by(StorageRack.position_order, StorageRack.code)
            )
        )
        .scalars()
        .all()
    )
    if not racks:
        return []
    loc_ids = {r.location_id for r in racks}
    loc_stmt = select(Location).where(Location.id.in_(loc_ids))
    if active_only:
        loc_stmt = loc_stmt.where(Location.is_active.is_(True))
    locs = {loc.id: loc for loc in (await session.execute(loc_stmt)).scalars().all()}
    grouped: dict[uuid.UUID, list[StorageRack]] = {}
    for rack in racks:
        if rack.location_id in locs:
            grouped.setdefault(rack.location_id, []).append(rack)
    return sorted(
        ((locs[lid], rks) for lid, rks in grouped.items()),
        key=lambda pair: pair[0].name.lower(),
    )


async def create_storage_location(
    session: AsyncSession,
    *,
    name: str,
    kind: str,
    detail: str | None,
    racks: list,
) -> Location:
    """Create a location + its racks (positions materialised). Caller commits.

    ``racks`` is a list of ``RackInput``-shaped objects (``.name/.rows/.cols``).
    The location ``code`` is derived from ``name`` and de-duplicated.
    """
    code = await _unique_location_code(session, _slug_location_code(name))
    loc = Location(
        code=code,
        name=name.strip(),
        kind=kind,
        notes=(detail.strip() if detail else None),
        is_active=True,
    )
    session.add(loc)
    await session.flush()  # assigns loc.id
    for idx, rack_input in enumerate(racks, start=1):
        rack = StorageRack(
            location_id=loc.id,
            code=f"R{idx:02d}",
            name=rack_input.name.strip(),
            rows=rack_input.rows,
            cols=rack_input.cols,
            position_order=idx,
        )
        session.add(rack)
        await session.flush()  # assigns rack.id
        for pos in _build_rack_positions(rack.id, rack_input.rows, rack_input.cols):
            session.add(pos)
    await session.flush()
    return loc


async def add_storage_rack(
    session: AsyncSession,
    *,
    location_id: uuid.UUID,
    name: str,
    rows: int,
    cols: int,
) -> StorageRack:
    """Append a rack to an existing location. Caller commits."""
    count = (
        await session.execute(
            select(func.count())
            .select_from(StorageRack)
            .where(StorageRack.location_id == location_id)
        )
    ).scalar_one()
    idx = int(count) + 1
    rack = StorageRack(
        location_id=location_id,
        code=f"R{idx:02d}",
        name=name.strip(),
        rows=rows,
        cols=cols,
        position_order=idx,
    )
    session.add(rack)
    await session.flush()
    for pos in _build_rack_positions(rack.id, rows, cols):
        session.add(pos)
    await session.flush()
    return rack


async def get_storage_rack(
    session: AsyncSession, rack_id: uuid.UUID
) -> StorageRack | None:
    return (
        await session.execute(
            select(StorageRack)
            .where(StorageRack.id == rack_id)
            .options(selectinload(StorageRack.positions))
        )
    ).scalar_one_or_none()


async def get_storage_position(
    session: AsyncSession,
    position_id: uuid.UUID,
    *,
    refresh: bool = False,
) -> StoragePosition | None:
    """Load one position (its lot → item → vendor are eager-joined).

    ``refresh=True`` forces ``populate_existing`` so a just-mutated row
    re-hydrates its joined ``lot`` — needed because the session runs with
    ``expire_on_commit=False``.
    """
    stmt = select(StoragePosition).where(StoragePosition.id == position_id)
    if refresh:
        stmt = stmt.execution_options(populate_existing=True)
    return (await session.execute(stmt)).scalar_one_or_none()


async def assign_storage_position(
    session: AsyncSession,
    *,
    position: StoragePosition,
    lot_id: uuid.UUID,
    actor_id: uuid.UUID,
) -> None:
    """Occupy an empty slot with a lot (one vial). Caller commits."""
    from_status = position.status
    position.status = "occupied"
    position.lot_id = lot_id
    position.assigned_at = datetime.now(UTC)
    session.add(
        StorageAssignmentEvent(
            position_id=position.id,
            event_kind="assign",
            from_status=from_status,
            to_status="occupied",
            lot_id=lot_id,
            actor_id=actor_id,
        )
    )
    await session.flush()


async def empty_storage_position(
    session: AsyncSession,
    *,
    position: StoragePosition,
    actor_id: uuid.UUID,
) -> None:
    """Unmap a slot (reversible — the vial can be re-placed). Caller commits."""
    from_status = position.status
    prev_lot = position.lot_id
    position.status = "empty"
    position.lot_id = None
    position.assigned_at = None
    session.add(
        StorageAssignmentEvent(
            position_id=position.id,
            event_kind="empty",
            from_status=from_status,
            to_status="empty",
            lot_id=prev_lot,
            actor_id=actor_id,
        )
    )
    await session.flush()


async def move_storage_position(
    session: AsyncSession,
    *,
    source: StoragePosition,
    dest: StoragePosition,
    actor_id: uuid.UUID,
) -> None:
    """Move the occupant from ``source`` to ``dest`` (cross-location ok).

    Writes a paired ``move_out`` / ``move_in`` history. Caller commits.
    """
    lot_id = source.lot_id
    assigned_at = source.assigned_at or datetime.now(UTC)
    source.status = "empty"
    source.lot_id = None
    source.assigned_at = None
    dest.status = "occupied"
    dest.lot_id = lot_id
    dest.assigned_at = assigned_at
    session.add(
        StorageAssignmentEvent(
            position_id=source.id,
            event_kind="move_out",
            from_status="occupied",
            to_status="empty",
            lot_id=lot_id,
            counterpart_position_id=dest.id,
            actor_id=actor_id,
        )
    )
    session.add(
        StorageAssignmentEvent(
            position_id=dest.id,
            event_kind="move_in",
            from_status="empty",
            to_status="occupied",
            lot_id=lot_id,
            counterpart_position_id=source.id,
            actor_id=actor_id,
        )
    )
    await session.flush()


# ── Storage ↔ movement coupling (unit-in / unit-out) ───────────────────
#
# A unit-in (receipt) fills N empty positions in the target location's racks;
# a unit-out (dispense) empties N of the lot's occupied positions there. One
# unit = one vial = one position. Locations without racks are ledger-only.
# See docs/modules/storage.md §5.1.


async def location_has_racks(session: AsyncSession, location_id: uuid.UUID) -> bool:
    """True when the location owns at least one active rack (so unit-in/out
    can map to physical positions)."""
    n = (
        await session.execute(
            select(func.count())
            .select_from(StorageRack)
            .where(
                StorageRack.location_id == location_id,
                StorageRack.is_active.is_(True),
            )
        )
    ).scalar_one()
    return int(n) > 0


async def count_empty_positions(
    session: AsyncSession, location_id: uuid.UUID
) -> int:
    """Empty positions across a location's active racks."""
    n = (
        await session.execute(
            select(func.count())
            .select_from(StoragePosition)
            .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
            .where(
                StorageRack.location_id == location_id,
                StorageRack.is_active.is_(True),
                StoragePosition.status == "empty",
            )
        )
    ).scalar_one()
    return int(n)


async def count_occupied_positions_for_lot(
    session: AsyncSession, location_id: uuid.UUID, lot_id: uuid.UUID
) -> int:
    """Occupied positions holding ``lot_id`` across a location's racks."""
    n = (
        await session.execute(
            select(func.count())
            .select_from(StoragePosition)
            .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
            .where(
                StorageRack.location_id == location_id,
                StoragePosition.status == "occupied",
                StoragePosition.lot_id == lot_id,
            )
        )
    ).scalar_one()
    return int(n)


async def fill_positions_for_lot(
    session: AsyncSession,
    *,
    location_id: uuid.UUID,
    lot_id: uuid.UUID,
    n: int,
    actor_id: uuid.UUID,
) -> int:
    """Occupy the next ``n`` empty positions in the location (row-major) with
    ``lot_id``. Returns the count filled. Caller commits.

    ``lazyload`` keeps the position's ``lot`` relationship off this SELECT so
    ``FOR UPDATE`` doesn't hit the nullable side of an outer join.
    """
    if n <= 0:
        return 0
    stmt = (
        select(StoragePosition)
        .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
        .where(
            StorageRack.location_id == location_id,
            StorageRack.is_active.is_(True),
            StoragePosition.status == "empty",
        )
        .order_by(StorageRack.position_order, StoragePosition.seq)
        .limit(n)
        .options(lazyload(StoragePosition.lot))
        .with_for_update(of=StoragePosition)
    )
    positions = list((await session.execute(stmt)).scalars().all())
    for pos in positions:
        await assign_storage_position(
            session, position=pos, lot_id=lot_id, actor_id=actor_id
        )
    return len(positions)


async def empty_positions_for_lot(
    session: AsyncSession,
    *,
    location_id: uuid.UUID,
    lot_id: uuid.UUID,
    n: int,
    actor_id: uuid.UUID,
) -> int:
    """Empty the next ``n`` occupied positions of ``lot_id`` in the location
    (row-major). Returns the count emptied. Caller commits."""
    if n <= 0:
        return 0
    stmt = (
        select(StoragePosition)
        .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
        .where(
            StorageRack.location_id == location_id,
            StoragePosition.status == "occupied",
            StoragePosition.lot_id == lot_id,
        )
        .order_by(StorageRack.position_order, StoragePosition.seq)
        .limit(n)
        .options(lazyload(StoragePosition.lot))
        .with_for_update(of=StoragePosition)
    )
    positions = list((await session.execute(stmt)).scalars().all())
    for pos in positions:
        await empty_storage_position(session, position=pos, actor_id=actor_id)
    return len(positions)


async def transfer_positions_for_lot(
    session: AsyncSession,
    *,
    from_location_id: uuid.UUID,
    to_location_id: uuid.UUID,
    lot_id: uuid.UUID,
    n: int,
    actor_id: uuid.UUID,
) -> int:
    """Move ``n`` of the lot's vials from one rack location to another.

    Pairs each source position with a destination position and reuses
    :func:`move_storage_position` so the history is a proper ``move_out`` /
    ``move_in`` pair (not empty + assign). Caller commits and is responsible
    for the capacity checks (enough occupied at source, enough empty at dest).
    """
    if n <= 0:
        return 0
    src_stmt = (
        select(StoragePosition)
        .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
        .where(
            StorageRack.location_id == from_location_id,
            StoragePosition.status == "occupied",
            StoragePosition.lot_id == lot_id,
        )
        .order_by(StorageRack.position_order, StoragePosition.seq)
        .limit(n)
        .options(lazyload(StoragePosition.lot))
        .with_for_update(of=StoragePosition)
    )
    dst_stmt = (
        select(StoragePosition)
        .join(StorageRack, StorageRack.id == StoragePosition.rack_id)
        .where(
            StorageRack.location_id == to_location_id,
            StorageRack.is_active.is_(True),
            StoragePosition.status == "empty",
        )
        .order_by(StorageRack.position_order, StoragePosition.seq)
        .limit(n)
        .options(lazyload(StoragePosition.lot))
        .with_for_update(of=StoragePosition)
    )
    sources = list((await session.execute(src_stmt)).scalars().all())
    dests = list((await session.execute(dst_stmt)).scalars().all())
    count = min(len(sources), len(dests))
    for i in range(count):
        await move_storage_position(
            session, source=sources[i], dest=dests[i], actor_id=actor_id
        )
    return count


async def list_position_events(
    session: AsyncSession, position_id: uuid.UUID
) -> list[dict]:
    """History for one position — newest first — hydrated with the lot, the
    actor's name, and (for moves) the counterpart position + location."""
    ev = StorageAssignmentEvent
    cp = aliased(StoragePosition)  # counterpart position (for moves)
    cp_rack = aliased(StorageRack)
    cp_loc = aliased(Location)
    stmt = (
        select(
            ev.id,
            ev.event_kind,
            ev.from_status,
            ev.to_status,
            ev.occurred_at,
            Lot.lot_number,
            User.full_name,
            cp.label,
            cp_loc.name,
        )
        .select_from(ev)
        .outerjoin(Lot, Lot.id == ev.lot_id)
        .outerjoin(User, User.id == ev.actor_id)
        .outerjoin(cp, cp.id == ev.counterpart_position_id)
        .outerjoin(cp_rack, cp_rack.id == cp.rack_id)
        .outerjoin(cp_loc, cp_loc.id == cp_rack.location_id)
        .where(ev.position_id == position_id)
        .order_by(ev.occurred_at.desc(), ev.id.desc())
    )
    rows = (await session.execute(stmt)).all()
    return [
        {
            "id": str(r.id),
            "event_kind": r.event_kind,
            "from_status": r.from_status,
            "to_status": r.to_status,
            "lot_number": r.lot_number,
            "actor_name": r.full_name,
            "counterpart_label": r.label,
            "counterpart_location": r.name,
            "occurred_at": r.occurred_at,
        }
        for r in rows
    ]


async def position_location_id(
    session: AsyncSession, position: StoragePosition
) -> uuid.UUID:
    """The ``meta.locations`` id that owns a position (via its rack). Used to
    bind a grid assign / empty / move to the right ledger location."""
    return (
        await session.execute(
            select(StorageRack.location_id).where(
                StorageRack.id == position.rack_id
            )
        )
    ).scalar_one()
