"""``/v1/items`` and ``/v1/vendors`` routes.

Read endpoints require ``inventory:view`` (every role); create requires
``inventory:create`` (admin + editor). No update / delete in this slice —
they're gated behind the audit log work.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.inventory.schemas import (
    AdjustmentRequest,
    AssignPositionRequest,
    DiscardRequest,
    DispenseRequest,
    EmptyPositionRequest,
    ItemCreate,
    ItemListResponse,
    ItemPrefix,
    ItemRead,
    ItemUpdate,
    LocationCreate,
    LocationKind,
    LocationRead,
    LocationUpdate,
    LotCreate,
    LotRead,
    LotStatus,
    LotUpdate,
    MovementListResponse,
    MovementRead,
    MovementType,
    MovePositionRequest,
    MovePositionResult,
    NextItemNumberResponse,
    PositionEventRead,
    PositionRead,
    RackInput,
    RackRead,
    ReceiptRequest,
    ReverseRequest,
    StockByLotEntry,
    StorageLocationCreate,
    StorageLocationRead,
    TransferRequest,
    TransferResponse,
    UnitOfMeasureRead,
    VendorCreate,
    VendorRead,
    VendorUpdate,
)
from app.models.inventory import (
    Item,
    Location,
    Lot,
    StockMovement,
    UnitOfMeasure,
    Vendor,
)
from app.models.storage import StoragePosition, StorageRack
from app.security.permissions import RequirePermission

items_router = APIRouter(prefix="/items", tags=["items"])
vendors_router = APIRouter(prefix="/vendors", tags=["vendors"])
uoms_router = APIRouter(prefix="/uoms", tags=["uoms"])
locations_router = APIRouter(prefix="/locations", tags=["locations"])
lots_router = APIRouter(prefix="/lots", tags=["lots"])
movements_router = APIRouter(prefix="/movements", tags=["movements"])
storage_router = APIRouter(prefix="/storage", tags=["storage"])


# ── Serialisers ────────────────────────────────────────────────────────


def _uom_to_read(u: UnitOfMeasure) -> UnitOfMeasureRead:
    return UnitOfMeasureRead(code=u.code, label=u.label, is_discrete=u.is_discrete)


def _location_to_read(loc: Location) -> LocationRead:
    return LocationRead(
        id=str(loc.id),
        code=loc.code,
        name=loc.name,
        kind=loc.kind,  # type: ignore[arg-type]
        temperature_c=loc.temperature_c,
        notes=loc.notes,
        is_active=loc.is_active,
        created_at=loc.created_at,
        updated_at=loc.updated_at,
    )


def _movement_to_read(m: StockMovement) -> MovementRead:
    return MovementRead(
        id=str(m.id),
        item_id=str(m.item_id),
        item_number=m.item.item_number if m.item else None,
        item_description=m.item.description if m.item else None,
        lot_id=str(m.lot_id) if m.lot_id else None,
        lot_number=m.lot.lot_number if m.lot else None,
        lot_expiration_date=m.lot.expiration_date if m.lot else None,
        from_location_id=str(m.from_location_id) if m.from_location_id else None,
        from_location_code=m.from_location.code if m.from_location else None,
        from_location_name=m.from_location.name if m.from_location else None,
        to_location_id=str(m.to_location_id) if m.to_location_id else None,
        to_location_code=m.to_location.code if m.to_location else None,
        to_location_name=m.to_location.name if m.to_location else None,
        movement_type=m.movement_type,  # type: ignore[arg-type]
        qty_delta=m.qty_delta,
        qty_abs=m.qty_abs,
        reason_code=m.reason_code,
        notes=m.notes,
        reference=m.reference,
        destination_text=m.destination_text,
        reversal_of_id=str(m.reversal_of_id) if m.reversal_of_id else None,
        reauth_evidence_id=str(m.reauth_evidence_id) if m.reauth_evidence_id else None,
        performed_by_user_id=str(m.performed_by_user_id),
        performed_by_user_name=m.performed_by.full_name if m.performed_by else None,
        performed_by_user_email=m.performed_by.email if m.performed_by else None,
        performed_at=m.performed_at,
        created_at=m.created_at,
    )


def _lot_to_read(lot: Lot) -> LotRead:
    return LotRead(
        id=str(lot.id),
        item_id=str(lot.item_id),
        lot_number=lot.lot_number,
        vendor_id=str(lot.vendor_id) if lot.vendor_id else None,
        vendor_name=lot.vendor.name if lot.vendor else None,
        item_number=lot.item.item_number if lot.item else None,
        item_description=lot.item.description if lot.item else None,
        manufacture_date=lot.manufacture_date,
        expiration_date=lot.expiration_date,
        coa_url=lot.coa_url,
        status=lot.status,  # type: ignore[arg-type]
        notes=lot.notes,
        created_at=lot.created_at,
        updated_at=lot.updated_at,
        created_by_user_id=str(lot.created_by_user_id),
        updated_by_user_id=str(lot.updated_by_user_id),
    )


def _vendor_to_read(v: Vendor) -> VendorRead:
    return VendorRead(
        id=str(v.id),
        name=v.name,
        contact_email=v.contact_email,
        phone=v.phone,
        is_active=v.is_active,
        notes=v.notes,
        created_at=v.created_at,
        updated_at=v.updated_at,
    )


def _item_to_read(item: Item) -> ItemRead:
    # The eager ``Item.stock`` relationship joins ``app.v_item_stock``,
    # which is LEFT-joined on the items query so newly-created items
    # without movements still resolve (``qty_on_hand = 0``,
    # ``status_code = 'out_of_stock'``).
    stock = item.stock
    qty_on_hand = stock.qty_on_hand if stock else Decimal("0")
    status_code = stock.status_code if stock else "out_of_stock"
    last_movement_at = stock.last_movement_at if stock else None
    # ``inv_value_amount`` is qty × unit_price when both are known.
    # Pricing module / FX / per-package math comes later; this is the
    # straight-line cost projection for the inventory tile.
    inv_value_amount = (
        qty_on_hand * item.unit_price_amount
        if item.unit_price_amount is not None
        else Decimal("0")
    )
    return ItemRead(
        id=str(item.id),
        item_number=item.item_number,
        item_prefix=item.item_prefix,
        description=item.description,
        vendor_id=str(item.vendor_id) if item.vendor_id else None,
        vendor_name=item.vendor.name if item.vendor else None,
        avg_lead_days=item.avg_lead_days,
        reorder_threshold=item.reorder_threshold,
        unit_price_amount=item.unit_price_amount,
        units_per_package=item.units_per_package,
        price_per_package_amount=item.price_per_package_amount,
        uom_code=item.uom_code,
        po_note=item.po_note,
        po_due_text=item.po_due_text,
        must_order_flag=item.must_order_flag,
        last_updated_on=item.last_updated_on,
        notes=item.notes,
        created_at=item.created_at,
        updated_at=item.updated_at,
        created_by_user_id=str(item.created_by_user_id),
        updated_by_user_id=str(item.updated_by_user_id),
        # Derived from the ledger view.
        qty_on_hand=qty_on_hand,
        inv_value_amount=inv_value_amount,
        status_code=status_code,  # type: ignore[arg-type]
        last_movement_at=last_movement_at,
        # qty_on_order / po_value_amount stay at zero until the PO module ships.
    )


# ── Vendors ────────────────────────────────────────────────────────────


@vendors_router.get(
    "",
    response_model=list[VendorRead],
    summary="List vendors",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_vendors(
    db: DBSession,
    active_only: bool = Query(default=True, description="Hide vendors with is_active=false"),
) -> list[VendorRead]:
    vendors = await inv_repo.list_vendors(db, active_only=active_only)
    return [_vendor_to_read(v) for v in vendors]


@vendors_router.get(
    "/{vendor_id}",
    response_model=VendorRead,
    summary="Get one vendor",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_vendor(
    db: DBSession,
    vendor_id: Annotated[uuid.UUID, Path()],
) -> VendorRead:
    vendor = await inv_repo.get_vendor(db, vendor_id)
    if vendor is None:
        raise NotFoundError(f"Vendor {vendor_id} not found")
    return _vendor_to_read(vendor)


@vendors_router.post(
    "",
    response_model=VendorRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a vendor (admin master-data write)",
    # Vendors are master data — same gate as item create. PATCH / DELETE
    # now ship (Chunk A); every edit + soft-delete writes to
    # ``audit.audit_events`` via the recorder helper.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_vendor(
    db: DBSession,
    payload: VendorCreate,
) -> VendorRead:
    # Pre-check for a clean 409. The partial-unique index on lower(name)
    # is the authoritative guard (handled in the except).
    if (await inv_repo.get_vendor_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"Vendor with name '{payload.name}' already exists",
            code="vendor_name_conflict",
        )
    try:
        vendor = await inv_repo.create_vendor(
            db,
            name=payload.name,
            contact_email=payload.contact_email,
            phone=payload.phone,
            notes=payload.notes,
            is_active=payload.is_active,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = (str(exc.orig).lower() if exc.orig else str(exc).lower())
        if "uq_vendors_name" in msg:
            raise ConflictError(
                f"Vendor with name '{payload.name}' already exists",
                code="vendor_name_conflict",
            ) from exc
        raise
    return _vendor_to_read(vendor)


@vendors_router.patch(
    "/{vendor_id}",
    response_model=VendorRead,
    summary="Update a vendor (admin master-data write)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_vendor(
    db: DBSession,
    current: CurrentDbUserDep,
    vendor_id: Annotated[uuid.UUID, Path()],
    payload: VendorUpdate,
) -> VendorRead:
    """Partial update + audit-log row.

    Empty patches (no fields set) return 422 — there's no work to do
    and writing a no-op audit row creates noise. To audit "user viewed
    this row" use the future read-audit module.
    """
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError(
            "No fields to update",
            code="empty_patch",
        )

    vendor = await inv_repo.get_vendor(db, vendor_id)
    if vendor is None:
        raise NotFoundError(f"Vendor {vendor_id} not found")

    # Name-collision pre-check when renaming.
    if "name" in patch and isinstance(patch["name"], str):
        if patch["name"].strip().lower() != vendor.name.lower():
            existing = await inv_repo.get_vendor_by_name(db, patch["name"])
            if existing is not None and existing.id != vendor.id:
                raise ConflictError(
                    f"Vendor with name '{patch['name']}' already exists",
                    code="vendor_name_conflict",
                )

    before = inv_repo.vendor_to_audit_snapshot(vendor)
    try:
        updated = await inv_repo.apply_vendor_patch(db, vendor=vendor, patch=patch)
    except IntegrityError as exc:
        await db.rollback()
        msg = (str(exc.orig).lower() if exc.orig else str(exc).lower())
        if "uq_vendors_name" in msg:
            raise ConflictError(
                "Vendor name conflict",
                code="vendor_name_conflict",
            ) from exc
        raise
    after = inv_repo.vendor_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.vendors",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
    )

    # Refresh inside the async greenlet so ``updated_at`` (computed by
    # the ``onupdate=func.now()``) is read back BEFORE the response
    # serializer touches it. Without this, the read triggers a lazy
    # SELECT outside the request scope → MissingGreenlet.
    await db.refresh(updated)
    response = _vendor_to_read(updated)
    await db.commit()
    return response


@vendors_router.delete(
    "/{vendor_id}",
    response_model=VendorRead,
    summary="Deactivate a vendor (soft delete via is_active=false)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_vendor(
    db: DBSession,
    current: CurrentDbUserDep,
    vendor_id: Annotated[uuid.UUID, Path()],
) -> VendorRead:
    """Soft-delete a vendor by flipping ``is_active=false``.

    Hard deletion is forbidden — items and lots FK to this vendor and
    the audit trail wants to keep resolving the vendor name historic.
    A deactivated vendor stops appearing in pickers but stays visible
    on past records.
    """
    vendor = await inv_repo.get_vendor(db, vendor_id)
    if vendor is None:
        raise NotFoundError(f"Vendor {vendor_id} not found")
    if not vendor.is_active:
        # Idempotent — second DELETE on an already-deactivated vendor
        # returns the current state without an extra audit row.
        return _vendor_to_read(vendor)

    before = inv_repo.vendor_to_audit_snapshot(vendor)
    updated = await inv_repo.apply_vendor_patch(
        db, vendor=vendor, patch={"is_active": False}
    )
    after = inv_repo.vendor_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="meta.vendors",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _vendor_to_read(updated)
    await db.commit()
    return response


# ── Items ──────────────────────────────────────────────────────────────


@items_router.get(
    "",
    response_model=ItemListResponse,
    summary="List inventory items",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_items(
    db: DBSession,
    q: Annotated[str | None, Query(description="Search description + item_number")] = None,
    prefix: Annotated[
        ItemPrefix | None, Query(description="Filter by 2-letter prefix")
    ] = None,
    vendor_id: Annotated[uuid.UUID | None, Query()] = None,
    status_filter: Annotated[
        Literal["available", "low_stock", "out_of_stock"] | None,
        Query(
            alias="status",
            description="Filter by computed stock status from v_item_stock",
        ),
    ] = None,
    sort: Annotated[
        Literal["item_number", "description", "updated_at", "created_at"],
        Query(),
    ] = "item_number",
    direction: Annotated[Literal["asc", "desc"], Query()] = "asc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ItemListResponse:
    items, total = await inv_repo.list_items(
        db,
        q=q,
        prefix=prefix,
        vendor_id=vendor_id,
        status=status_filter,
        sort=sort,
        direction=direction,
        limit=limit,
        offset=offset,
    )
    return ItemListResponse(
        items=[_item_to_read(i) for i in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@items_router.get(
    "/next-number",
    response_model=NextItemNumberResponse,
    summary="Suggest the next free item_number for a given prefix",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def next_item_number(
    db: DBSession,
    prefix: Annotated[ItemPrefix, Query(description="2-letter prefix (CM, NM, CR, or AY)")],
) -> NextItemNumberResponse:
    suggested = await inv_repo.next_item_number(db, prefix)
    return NextItemNumberResponse(prefix=prefix, item_number=suggested)


@items_router.get(
    "/by-number/{item_number}",
    response_model=ItemRead,
    summary="Get one inventory item by its human-readable number (e.g. CM-0001)",
    # Registered *before* the UUID route so ``by-number`` isn't swallowed
    # by FastAPI's UUID Path validator on ``/items/{item_id}``.
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_item_by_number(
    db: DBSession,
    item_number: Annotated[str, Path(pattern=r"^(CM|NM|CR|AY)-\d+$")],
) -> ItemRead:
    item = await inv_repo.get_item_by_number(db, item_number)
    if item is None:
        raise NotFoundError(f"Item {item_number} not found")
    return _item_to_read(item)


@items_router.get(
    "/{item_id}",
    response_model=ItemRead,
    summary="Get one inventory item",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_item(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
) -> ItemRead:
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    return _item_to_read(item)


@items_router.post(
    "",
    response_model=ItemRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create an inventory item",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_item(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ItemCreate,
) -> ItemRead:
    # Uniqueness pre-check for a clean 409. The partial-unique index is
    # still the authoritative guard (handled in the except).
    existing = await inv_repo.get_item_by_number(db, payload.item_number)
    if existing is not None:
        raise ConflictError(
            f"item_number {payload.item_number} is already in use",
            code="item_number_conflict",
        )

    vendor_uuid: uuid.UUID | None = None
    if payload.vendor_id is not None:
        try:
            vendor_uuid = uuid.UUID(payload.vendor_id)
        except ValueError as exc:
            raise ValidationError(
                "vendor_id is not a valid UUID",
                code="invalid_vendor_id",
            ) from exc
        if (await inv_repo.get_vendor(db, vendor_uuid)) is None:
            raise NotFoundError(f"Vendor {payload.vendor_id} not found")

    try:
        item = await inv_repo.create_item(
            db,
            item_number=payload.item_number,
            description=payload.description,
            created_by_user_id=current.id,
            vendor_id=vendor_uuid,
            avg_lead_days=payload.avg_lead_days,
            reorder_threshold=payload.reorder_threshold,
            unit_price_amount=payload.unit_price_amount,
            units_per_package=payload.units_per_package,
            uom_code=payload.uom_code,
            po_note=payload.po_note,
            notes=payload.notes,
        )
    except IntegrityError as exc:
        # Race lost on the partial-unique index, or an unknown FK / CHECK.
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_items_item_number" in msg:
            raise ConflictError(
                f"item_number {payload.item_number} is already in use",
                code="item_number_conflict",
            ) from exc
        if "ck_items_item_number" in msg:
            raise ValidationError(
                "item_number violates prefix or format rules",
                code="item_number_invalid",
            ) from exc
        if "fk_items_uom_code" in msg:
            raise ValidationError(
                f"unknown uom_code: {payload.uom_code}",
                code="invalid_uom_code",
            ) from exc
        raise

    return _item_to_read(item)


@items_router.patch(
    "/{item_id}",
    response_model=ItemRead,
    summary="Update an inventory item",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_item(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    payload: ItemUpdate,
) -> ItemRead:
    """Partial item update + audit-log row.

    ``vendor_id`` is FK-validated (404 on unknown). ``uom_code`` may
    only be changed while the item has no ledger rows — switching
    "vial" → "mL" mid-life would reinterpret historic balances.
    """
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    item = await inv_repo.get_item(db, item_id)
    if item is None or item.deleted_at is not None:
        raise NotFoundError(f"Item {item_id} not found")

    # Resolve vendor_id (may be UUID-string or None to clear).
    if "vendor_id" in patch:
        v = patch["vendor_id"]
        if v is None:
            patch["vendor_id"] = None
        elif isinstance(v, str):
            try:
                vendor_uuid = uuid.UUID(v)
            except ValueError as exc:
                raise ValidationError(
                    "vendor_id is not a valid UUID",
                    code="invalid_vendor_id",
                ) from exc
            if (await inv_repo.get_vendor(db, vendor_uuid)) is None:
                raise NotFoundError(f"Vendor {v} not found")
            patch["vendor_id"] = vendor_uuid

    # uom_code change only allowed while no movements exist.
    if "uom_code" in patch:
        # Quick check — the v_item_stock view has one row per item with
        # ``last_movement_at`` set when any movement exists.
        if item.stock is not None and item.stock.last_movement_at is not None:
            raise ValidationError(
                "uom_code cannot change after stock has moved against this item",
                code="uom_change_after_movement",
            )

    before = inv_repo.item_to_audit_snapshot(item)
    updated = await inv_repo.apply_item_patch(
        db,
        item=item,
        patch=patch,
        updated_by_user_id=current.id,
    )
    after = inv_repo.item_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.items",
        subject_id=updated.id,
        subject_label=f"{updated.item_number} · {updated.description}",
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _item_to_read(updated)
    await db.commit()
    return response


@items_router.delete(
    "/{item_id}",
    response_model=ItemRead,
    summary="Soft-delete an inventory item (deleted_at stamp)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_item(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
) -> ItemRead:
    """Soft-delete an item.

    Refused if the item still has positive stock — orphaned ledger
    rows are a worse audit problem than the inability to delete a
    busy item. Operators must zero the balance (dispense / discard
    the remainder) before deletion.
    """
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    if item.deleted_at is not None:
        return _item_to_read(item)

    if item.stock is not None and Decimal(str(item.stock.qty_on_hand)) > 0:
        raise ValidationError(
            (
                f"Item still has {item.stock.qty_on_hand} units on hand; "
                f"zero the balance before deleting"
            ),
            code="item_has_stock",
        )

    before = inv_repo.item_to_audit_snapshot(item)
    deleted = await inv_repo.soft_delete_item(
        db, item=item, deleted_by_user_id=current.id
    )
    after = inv_repo.item_to_audit_snapshot(deleted)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.items",
        subject_id=deleted.id,
        subject_label=f"{deleted.item_number} · {deleted.description}",
        before=before,
        after=after,
    )

    await db.refresh(deleted)
    response = _item_to_read(deleted)
    await db.commit()
    return response


# ── Units of measure ───────────────────────────────────────────────────


@uoms_router.get(
    "",
    response_model=list[UnitOfMeasureRead],
    summary="List units of measure (read-only)",
    # No POST/PATCH — new units land via migration. Items FK to ``code``,
    # so ad-hoc creates would break referential design.
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_uoms(db: DBSession) -> list[UnitOfMeasureRead]:
    return [_uom_to_read(u) for u in await inv_repo.list_uoms(db)]


# ── Locations ──────────────────────────────────────────────────────────


@locations_router.get(
    "",
    response_model=list[LocationRead],
    summary="List storage locations",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_locations(
    db: DBSession,
    active_only: bool = Query(default=True, description="Hide deactivated locations"),
    kind: Annotated[LocationKind | None, Query(description="Filter by kind")] = None,
) -> list[LocationRead]:
    rows = await inv_repo.list_locations(db, active_only=active_only, kind=kind)
    return [_location_to_read(r) for r in rows]


@locations_router.get(
    "/{location_id}",
    response_model=LocationRead,
    summary="Get one location",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_location(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
) -> LocationRead:
    loc = await inv_repo.get_location(db, location_id)
    if loc is None:
        raise NotFoundError(f"Location {location_id} not found")
    return _location_to_read(loc)


@locations_router.post(
    "",
    response_model=LocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a storage location (admin master-data write)",
    # PATCH / DELETE deliberately omitted until audit module ships —
    # location renames cascade into every historical movement.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_location(
    db: DBSession,
    payload: LocationCreate,
) -> LocationRead:
    # Pre-check for a clean 409. The partial-unique index on lower(code)
    # is the authoritative guard (handled in the except).
    if (await inv_repo.get_location_by_code(db, payload.code)) is not None:
        raise ConflictError(
            f"Location with code '{payload.code}' already exists",
            code="location_code_conflict",
        )
    try:
        loc = await inv_repo.create_location(
            db,
            code=payload.code,
            name=payload.name,
            kind=payload.kind,
            temperature_c=payload.temperature_c,
            notes=payload.notes,
            is_active=payload.is_active,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_locations_code" in msg:
            raise ConflictError(
                f"Location with code '{payload.code}' already exists",
                code="location_code_conflict",
            ) from exc
        if "ck_locations_kind" in msg:
            raise ValidationError(
                f"invalid location kind: {payload.kind}",
                code="invalid_location_kind",
            ) from exc
        raise
    return _location_to_read(loc)


@locations_router.patch(
    "/{location_id}",
    response_model=LocationRead,
    summary="Update a storage location",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_location(
    db: DBSession,
    current: CurrentDbUserDep,
    location_id: Annotated[uuid.UUID, Path()],
    payload: LocationUpdate,
) -> LocationRead:
    """Partial location update + audit-log row."""
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    location = await inv_repo.get_location(db, location_id)
    if location is None:
        raise NotFoundError(f"Location {location_id} not found")

    if "code" in patch and isinstance(patch["code"], str):
        new_code = patch["code"].strip()
        if new_code.lower() != location.code.lower():
            existing = await inv_repo.get_location_by_code(db, new_code)
            if existing is not None and existing.id != location.id:
                raise ConflictError(
                    f"Location with code '{new_code}' already exists",
                    code="location_code_conflict",
                )

    before = inv_repo.location_to_audit_snapshot(location)
    try:
        updated = await inv_repo.apply_location_patch(
            db, location=location, patch=patch
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_locations_code" in msg:
            raise ConflictError(
                "Location code conflict",
                code="location_code_conflict",
            ) from exc
        if "ck_locations_kind" in msg:
            raise ValidationError(
                "Invalid location kind",
                code="invalid_location_kind",
            ) from exc
        raise
    after = inv_repo.location_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.locations",
        subject_id=updated.id,
        subject_label=f"{updated.code} · {updated.name}",
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _location_to_read(updated)
    await db.commit()
    return response


@locations_router.delete(
    "/{location_id}",
    response_model=LocationRead,
    summary="Deactivate a location (soft delete via is_active=false)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_location(
    db: DBSession,
    current: CurrentDbUserDep,
    location_id: Annotated[uuid.UUID, Path()],
) -> LocationRead:
    """Soft-delete a location by flipping ``is_active=false``."""
    location = await inv_repo.get_location(db, location_id)
    if location is None:
        raise NotFoundError(f"Location {location_id} not found")
    if not location.is_active:
        return _location_to_read(location)

    before = inv_repo.location_to_audit_snapshot(location)
    updated = await inv_repo.apply_location_patch(
        db, location=location, patch={"is_active": False}
    )
    after = inv_repo.location_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="meta.locations",
        subject_id=updated.id,
        subject_label=f"{updated.code} · {updated.name}",
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _location_to_read(updated)
    await db.commit()
    return response


# ── Lots ───────────────────────────────────────────────────────────────


@lots_router.get(
    "",
    response_model=list[LotRead],
    summary="List lots (global, paginated)",
    # Returns a *list* (not a paged envelope) for v1 — the table fits
    # comfortably under the default 100 cap. When we cross that, swap
    # to the ItemListResponse-style envelope used by /items.
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_lots(
    db: DBSession,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    status_filter: Annotated[
        LotStatus | None, Query(alias="status", description="Filter by lifecycle status")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[LotRead]:
    rows, _ = await inv_repo.list_lots(
        db,
        item_id=item_id,
        status=status_filter,
        limit=limit,
        offset=offset,
    )
    return [_lot_to_read(r) for r in rows]


@lots_router.get(
    "/{lot_id}",
    response_model=LotRead,
    summary="Get one lot",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_lot(
    db: DBSession,
    lot_id: Annotated[uuid.UUID, Path()],
) -> LotRead:
    lot = await inv_repo.get_lot(db, lot_id)
    if lot is None:
        raise NotFoundError(f"Lot {lot_id} not found")
    return _lot_to_read(lot)


@items_router.get(
    "/{item_id}/lots",
    response_model=list[LotRead],
    summary="List lots scoped to one item (for the lot picker)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_lots(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    status_filter: Annotated[
        LotStatus | None, Query(alias="status")
    ] = None,
) -> list[LotRead]:
    # 404 fast if the item doesn't exist so the UI gets a clean error
    # instead of an empty list (which is ambiguous).
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows, _ = await inv_repo.list_lots(db, item_id=item_id, status=status_filter)
    return [_lot_to_read(r) for r in rows]


@items_router.post(
    "/{item_id}/lots",
    response_model=LotRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a lot under one item",
    # Lot creation outside a receipt is an admin workflow — gated on
    # the same permission as item create. The receipt endpoint (future
    # chunk) will create lots inline as part of the movement.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    payload: LotCreate,
) -> LotRead:
    # Validate the parent item exists before we even look at the body.
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")

    # Optional vendor — validate the UUID + existence ourselves so the
    # caller gets a clean 4xx instead of an FK violation.
    vendor_uuid: uuid.UUID | None = None
    if payload.vendor_id is not None:
        try:
            vendor_uuid = uuid.UUID(payload.vendor_id)
        except ValueError as exc:
            raise ValidationError(
                "vendor_id is not a valid UUID",
                code="invalid_vendor_id",
            ) from exc
        if (await inv_repo.get_vendor(db, vendor_uuid)) is None:
            raise NotFoundError(f"Vendor {payload.vendor_id} not found")

    # Pre-check for a clean 409. The partial-unique index is authoritative.
    existing = await inv_repo.get_lot_by_item_and_number(
        db, item_id=item_id, lot_number=payload.lot_number
    )
    if existing is not None:
        raise ConflictError(
            f"lot_number '{payload.lot_number}' is already in use for this item",
            code="lot_number_conflict",
        )

    try:
        lot = await inv_repo.create_lot(
            db,
            item_id=item_id,
            lot_number=payload.lot_number,
            created_by_user_id=current.id,
            vendor_id=vendor_uuid,
            manufacture_date=payload.manufacture_date,
            expiration_date=payload.expiration_date,
            coa_url=payload.coa_url,
            status=payload.status,
            notes=payload.notes,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_lots_item_lot_number" in msg:
            raise ConflictError(
                f"lot_number '{payload.lot_number}' is already in use for this item",
                code="lot_number_conflict",
            ) from exc
        if "ck_lots_status" in msg:
            raise ValidationError(
                f"invalid lot status: {payload.status}",
                code="invalid_lot_status",
            ) from exc
        if "ck_lots_dates_ordered" in msg:
            raise ValidationError(
                "expiration_date must be on or after manufacture_date",
                code="lot_dates_inverted",
            ) from exc
        raise
    return _lot_to_read(lot)


@lots_router.patch(
    "/{lot_id}",
    response_model=LotRead,
    summary="Update a lot",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    lot_id: Annotated[uuid.UUID, Path()],
    payload: LotUpdate,
) -> LotRead:
    """Partial lot update + audit-log row.

    Editable: status, dates, vendor, CoA URL, notes. The DB CHECK on
    date ordering is the authoritative guard; the route surfaces the
    structured ``lot_dates_inverted`` code if the operator inverts them.
    """
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    lot = await inv_repo.get_lot(db, lot_id)
    if lot is None or lot.deleted_at is not None:
        raise NotFoundError(f"Lot {lot_id} not found")

    if "vendor_id" in patch:
        v = patch["vendor_id"]
        if v is None:
            patch["vendor_id"] = None
        elif isinstance(v, str):
            try:
                vendor_uuid = uuid.UUID(v)
            except ValueError as exc:
                raise ValidationError(
                    "vendor_id is not a valid UUID",
                    code="invalid_vendor_id",
                ) from exc
            if (await inv_repo.get_vendor(db, vendor_uuid)) is None:
                raise NotFoundError(f"Vendor {v} not found")
            patch["vendor_id"] = vendor_uuid

    before = inv_repo.lot_to_audit_snapshot(lot)
    try:
        updated = await inv_repo.apply_lot_patch(
            db, lot=lot, patch=patch, updated_by_user_id=current.id
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "ck_lots_dates_ordered" in msg:
            raise ValidationError(
                "expiration_date must be on or after manufacture_date",
                code="lot_dates_inverted",
            ) from exc
        if "ck_lots_status" in msg:
            raise ValidationError(
                "Invalid lot status",
                code="invalid_lot_status",
            ) from exc
        raise
    after = inv_repo.lot_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.lots",
        subject_id=updated.id,
        subject_label=updated.lot_number,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _lot_to_read(updated)
    await db.commit()
    return response


@lots_router.delete(
    "/{lot_id}",
    response_model=LotRead,
    summary="Soft-delete a lot",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    lot_id: Annotated[uuid.UUID, Path()],
) -> LotRead:
    """Soft-delete a lot.

    Refused if any ``stock_movements`` row references this lot — the
    movement carries lot_number/expiration on read via the joined
    relationship and we don't want it to lose those values.
    """
    lot = await inv_repo.get_lot(db, lot_id)
    if lot is None:
        raise NotFoundError(f"Lot {lot_id} not found")
    if lot.deleted_at is not None:
        return _lot_to_read(lot)

    if await inv_repo.lot_has_movements(db, lot.id):
        raise ValidationError(
            (
                "Cannot delete a lot that has movement history. "
                "Mark the lot as recalled or expired instead."
            ),
            code="lot_has_movements",
        )

    before = inv_repo.lot_to_audit_snapshot(lot)
    deleted = await inv_repo.soft_delete_lot(
        db, lot=lot, deleted_by_user_id=current.id
    )
    after = inv_repo.lot_to_audit_snapshot(deleted)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.lots",
        subject_id=deleted.id,
        subject_label=deleted.lot_number,
        before=before,
        after=after,
    )

    await db.refresh(deleted)
    response = _lot_to_read(deleted)
    await db.commit()
    return response


# ── Stock movements (read-only in Chunk 2) ─────────────────────────────


@movements_router.get(
    "",
    response_model=MovementListResponse,
    summary="List stock movements (global ledger, paginated)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_movements(
    db: DBSession,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    lot_id: Annotated[uuid.UUID | None, Query()] = None,
    location_id: Annotated[
        uuid.UUID | None,
        Query(description="Matches from_location_id OR to_location_id"),
    ] = None,
    movement_type: Annotated[
        MovementType | None,
        Query(alias="type", description="Filter by movement type"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> MovementListResponse:
    rows, total = await inv_repo.list_movements(
        db,
        item_id=item_id,
        lot_id=lot_id,
        location_id=location_id,
        movement_type=movement_type,
        limit=limit,
        offset=offset,
    )
    return MovementListResponse(
        items=[_movement_to_read(m) for m in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@items_router.get(
    "/{item_id}/ledger",
    response_model=MovementListResponse,
    summary="Per-item stock ledger (newest first)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_ledger(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> MovementListResponse:
    # 404 fast when the item doesn't exist so the UI gets a clean error
    # instead of an empty page (which is ambiguous).
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows, total = await inv_repo.list_item_ledger(
        db, item_id=item_id, limit=limit, offset=offset
    )
    return MovementListResponse(
        items=[_movement_to_read(m) for m in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


# ── Receipt (first write path) ─────────────────────────────────────────


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    """Convert a body-provided string UUID into ``uuid.UUID`` with a
    clean 422. Pydantic validates *shape* (string); this validates *content*.
    """
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"{field} is not a valid UUID",
            code=f"invalid_{field}",
        ) from exc


def _whole_units_or_422(qty: Decimal) -> int:
    """Coerce a movement qty to whole vials for rack-mapped storage.

    A storage position holds exactly one vial, so a unit-in / unit-out against
    a location that has racks must be an integer number of units.
    """
    units = int(qty)
    if Decimal(units) != qty:
        raise ValidationError(
            "Whole units are required when the location has racks",
            code="fractional_units_in_rack",
        )
    return units


@movements_router.post(
    "/receipt",
    response_model=MovementRead,
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Record a unit in (vendor → inventory). Requires a fresh "
        "reauth evidence id for action='movement.receipt'."
    ),
    # ``sign`` permission — this is a GxP-significant action requiring
    # an e-signature, not the routine ``create`` permission for master data.
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_receipt(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ReceiptRequest,
) -> MovementRead:
    """Atomic receipt: validate → (create lot if inline) → insert
    movement → consume evidence → commit. Any failure rolls back the
    whole transaction so a half-applied receipt can't exist."""

    # 1) Parse UUIDs from the body. Pydantic only checked they're
    #    non-empty strings; we surface bad UUIDs as 422 with structured codes.
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    location_uuid = _parse_uuid_or_422(payload.location_id, field="location_id")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    # 2) Validate the domain objects.
    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")
    location = await inv_repo.get_location(db, location_uuid)
    if location is None:
        raise NotFoundError(f"Location {payload.location_id} not found")
    if not location.is_active:
        raise ValidationError(
            "Location is inactive; cannot receive stock here",
            code="location_inactive",
        )

    # 3) Resolve the lot — existing reference or inline create.
    if payload.new_lot is not None:
        new_lot = payload.new_lot
        # Vendor defaults to the item's vendor; explicit override allowed.
        vendor_uuid: uuid.UUID | None = item.vendor_id
        if new_lot.vendor_id is not None:
            vendor_uuid = _parse_uuid_or_422(new_lot.vendor_id, field="vendor_id")
            if (await inv_repo.get_vendor(db, vendor_uuid)) is None:
                raise NotFoundError(f"Vendor {new_lot.vendor_id} not found")
        # Pre-check for clean 409 (auth index is the real guard).
        if (
            await inv_repo.get_lot_by_item_and_number(
                db, item_id=item_uuid, lot_number=new_lot.lot_number
            )
        ) is not None:
            raise ConflictError(
                f"lot_number '{new_lot.lot_number}' already exists for this item; "
                "pass lot_id instead to top it up",
                code="lot_number_conflict",
            )
        try:
            lot = await inv_repo.create_lot(
                db,
                item_id=item_uuid,
                lot_number=new_lot.lot_number,
                created_by_user_id=current.id,
                vendor_id=vendor_uuid,
                manufacture_date=new_lot.manufacture_date,
                expiration_date=new_lot.expiration_date,
                coa_url=new_lot.coa_url,
                status="released",
                notes=new_lot.notes,
            )
        except IntegrityError as exc:
            await db.rollback()
            msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
            if "uq_lots_item_lot_number" in msg:
                raise ConflictError(
                    f"lot_number '{new_lot.lot_number}' already exists for this item",
                    code="lot_number_conflict",
                ) from exc
            if "ck_lots_dates_ordered" in msg:
                raise ValidationError(
                    "expiration_date must be on or after manufacture_date",
                    code="lot_dates_inverted",
                ) from exc
            raise
        lot_uuid = lot.id
    else:
        # XOR validated at the schema layer; this branch must have lot_id.
        assert payload.lot_id is not None
        lot_uuid = _parse_uuid_or_422(payload.lot_id, field="lot_id")
        existing_lot = await inv_repo.get_lot(db, lot_uuid)
        if existing_lot is None:
            raise NotFoundError(f"Lot {payload.lot_id} not found")
        if existing_lot.item_id != item_uuid:
            raise ValidationError(
                "Lot does not belong to this item",
                code="lot_item_mismatch",
            )
        if existing_lot.status not in ("released", "quarantined"):
            raise ValidationError(
                f"Lot is '{existing_lot.status}' and cannot receive new stock",
                code="lot_status_blocked",
            )

    # 4) Insert the movement first so we know its id, then consume
    #    the evidence pointing at that exact movement. Both inside the
    #    same transaction so a replay-detection rollback also undoes
    #    the movement.
    movement = await inv_repo.create_receipt_movement(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        to_location_id=location_uuid,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
    )

    # 4b) Couple to LN2: if the destination has racks, fill that many empty
    #     positions with this lot so the /ln2 grid mirrors the ledger. One
    #     unit = one vial = one position. Rack-less locations stay ledger-only.
    if await inv_repo.location_has_racks(db, location_uuid):
        units = _whole_units_or_422(payload.qty)
        empty = await inv_repo.count_empty_positions(db, location_uuid)
        if empty < units:
            raise ConflictError(
                f"Location has only {empty} empty position(s); cannot place "
                f"{units} unit(s). Add a rack or pick another location.",
                code="not_enough_empty_positions",
            )
        await inv_repo.fill_positions_for_lot(
            db,
            location_id=location_uuid,
            lot_id=lot_uuid,
            n=units,
            actor_id=current.id,
        )

    # 5) Consume the evidence (replay-detected via PK conflict).
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.receipt",
        target_table="app.stock_movements",
        target_id=movement.id,
    )

    # 6) Commit everything together.
    await db.commit()

    return _movement_to_read(movement)


# ── Dispense (second write path) ───────────────────────────────────────


@movements_router.post(
    "/dispense",
    response_model=MovementRead,
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Record a unit out (inventory → consumed). "
        "Requires a fresh reauth evidence id for "
        "action='movement.dispense'."
    ),
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_dispense(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: DispenseRequest,
) -> MovementRead:
    """Atomic dispense: validate → check available → insert movement →
    consume evidence → commit. Overdraws are rejected with a
    structured ``dispense_exceeds_available`` 422 *before* the movement
    is inserted, so the DB never sees the partial state.
    """
    # 1) Parse UUIDs from the body.
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    location_uuid = _parse_uuid_or_422(payload.location_id, field="location_id")
    lot_uuid = _parse_uuid_or_422(payload.lot_id, field="lot_id")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    # 2) Validate the domain objects.
    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")
    location = await inv_repo.get_location(db, location_uuid)
    if location is None:
        raise NotFoundError(f"Location {payload.location_id} not found")
    # ``is_active`` isn't required for dispense — you might be cleaning
    # out a deactivated freezer. The check that matters is "is there
    # stock here?" which happens below.

    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")
    if lot.item_id != item_uuid:
        raise ValidationError(
            "Lot does not belong to this item",
            code="lot_item_mismatch",
        )
    # Expired / recalled lots can still be dispensed — but the reason
    # code should reflect that (e.g. ``expired``). We don't second-guess
    # the operator here.

    # 3) Check available qty BEFORE inserting the movement. This is the
    #    canonical "you can't take more than you have" guard.
    available = await inv_repo.get_lot_location_available(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        location_id=location_uuid,
    )
    if payload.qty > available:
        raise ValidationError(
            (
                f"Requested {payload.qty} exceeds available {available} "
                f"for this lot at this location"
            ),
            code="dispense_exceeds_available",
        )

    # 4) Insert the movement, then consume the evidence pointing at it.
    movement = await inv_repo.create_dispense_movement(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        from_location_id=location_uuid,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        destination=payload.destination,
    )

    # 4b) Couple to LN2: if the source has racks, free that many of the lot's
    #     occupied positions so the /ln2 grid mirrors the ledger.
    if await inv_repo.location_has_racks(db, location_uuid):
        units = _whole_units_or_422(payload.qty)
        mapped = await inv_repo.count_occupied_positions_for_lot(
            db, location_uuid, lot_uuid
        )
        if mapped < units:
            raise ConflictError(
                f"Only {mapped} vial(s) of this lot are mapped at this location; "
                f"cannot remove {units}.",
                code="not_enough_mapped_positions",
            )
        await inv_repo.empty_positions_for_lot(
            db,
            location_id=location_uuid,
            lot_id=lot_uuid,
            n=units,
            actor_id=current.id,
        )

    # 5) Consume the evidence (replay-detected via PK conflict).
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.dispense",
        target_table="app.stock_movements",
        target_id=movement.id,
    )

    # 6) Commit everything together.
    await db.commit()

    return _movement_to_read(movement)


# ── Discard (third write path) ─────────────────────────────────────────


@movements_router.post(
    "/discard",
    response_model=MovementRead,
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Record a stock discard (expired / damaged / contaminated). "
        "Distinct movement_type from dispense so audit reports can "
        "separate \"used\" from \"thrown away\" without parsing reasons."
    ),
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_discard(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: DiscardRequest,
) -> MovementRead:
    """Atomic discard. Mirrors dispense but writes ``movement_type='discard'``
    so the variance reports can distinguish the two categories.
    """
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    location_uuid = _parse_uuid_or_422(payload.location_id, field="location_id")
    lot_uuid = _parse_uuid_or_422(payload.lot_id, field="lot_id")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")
    location = await inv_repo.get_location(db, location_uuid)
    if location is None:
        raise NotFoundError(f"Location {payload.location_id} not found")

    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")
    if lot.item_id != item_uuid:
        raise ValidationError(
            "Lot does not belong to this item",
            code="lot_item_mismatch",
        )

    available = await inv_repo.get_lot_location_available(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        location_id=location_uuid,
    )
    if payload.qty > available:
        raise ValidationError(
            (
                f"Requested {payload.qty} exceeds available {available} "
                f"for this lot at this location"
            ),
            code="discard_exceeds_available",
        )

    movement = await inv_repo.create_discard_movement(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        from_location_id=location_uuid,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        reason_code=payload.reason_code,
        notes=payload.notes,
        reference=payload.reference,
    )

    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.discard",
        target_table="app.stock_movements",
        target_id=movement.id,
    )

    await db.commit()
    return _movement_to_read(movement)


# ── Adjustment (fourth write path) ─────────────────────────────────────


@movements_router.post(
    "/adjustment",
    response_model=MovementRead,
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Record a signed adjustment to the (lot, location) balance. "
        "Use after a physical count or to back-fill opening balances. "
        "Requires action='movement.adjustment' evidence."
    ),
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_adjustment(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: AdjustmentRequest,
) -> MovementRead:
    """Atomic signed correction. ``qty_delta = 0`` is rejected (no-op
    audit rows are confusing); negative deltas can't exceed the
    current balance.
    """
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    location_uuid = _parse_uuid_or_422(payload.location_id, field="location_id")
    lot_uuid = _parse_uuid_or_422(payload.lot_id, field="lot_id")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    if payload.qty_delta == 0:
        raise ValidationError(
            "qty_delta must be non-zero",
            code="adjustment_zero_delta",
        )

    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")
    location = await inv_repo.get_location(db, location_uuid)
    if location is None:
        raise NotFoundError(f"Location {payload.location_id} not found")

    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")
    if lot.item_id != item_uuid:
        raise ValidationError(
            "Lot does not belong to this item",
            code="lot_item_mismatch",
        )

    # Overdraw guard — only for negative adjustments.
    if payload.qty_delta < 0:
        available = await inv_repo.get_lot_location_available(
            db,
            item_id=item_uuid,
            lot_id=lot_uuid,
            location_id=location_uuid,
        )
        if abs(payload.qty_delta) > available:
            raise ValidationError(
                (
                    f"Negative adjustment {payload.qty_delta} would push "
                    f"the balance below zero (available {available})"
                ),
                code="adjustment_exceeds_available",
            )

    movement = await inv_repo.create_adjustment_movement(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        location_id=location_uuid,
        qty_delta=payload.qty_delta,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        reason_code=payload.reason_code,
        notes=payload.notes,
        reference=payload.reference,
    )

    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.adjustment",
        target_table="app.stock_movements",
        target_id=movement.id,
    )

    await db.commit()
    return _movement_to_read(movement)


# ── Transfer (two-leg write path) ──────────────────────────────────────


@movements_router.post(
    "/transfer",
    response_model=TransferResponse,
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Transfer units between two locations atomically. Writes both "
        "the ``transfer_out`` and the ``transfer_in`` leg in one tx. "
        "Requires action='movement.transfer' evidence."
    ),
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_transfer(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferRequest,
) -> TransferResponse:
    """Atomic two-leg transfer."""
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    lot_uuid = _parse_uuid_or_422(payload.lot_id, field="lot_id")
    from_uuid = _parse_uuid_or_422(payload.from_location_id, field="from_location_id")
    to_uuid = _parse_uuid_or_422(payload.to_location_id, field="to_location_id")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    if from_uuid == to_uuid:
        raise ValidationError(
            "from_location_id and to_location_id must differ",
            code="transfer_same_location",
        )

    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")
    from_loc = await inv_repo.get_location(db, from_uuid)
    if from_loc is None:
        raise NotFoundError(f"Location {payload.from_location_id} not found")
    to_loc = await inv_repo.get_location(db, to_uuid)
    if to_loc is None:
        raise NotFoundError(f"Location {payload.to_location_id} not found")
    if not to_loc.is_active:
        # Source can be deactivated (cleanup workflow), destination can't.
        raise ValidationError(
            "Destination location is inactive; cannot receive stock",
            code="location_inactive",
        )

    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")
    if lot.item_id != item_uuid:
        raise ValidationError(
            "Lot does not belong to this item",
            code="lot_item_mismatch",
        )

    # Overdraw check against the source side.
    available = await inv_repo.get_lot_location_available(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        location_id=from_uuid,
    )
    if payload.qty > available:
        raise ValidationError(
            (
                f"Requested {payload.qty} exceeds available {available} "
                f"at the source location"
            ),
            code="transfer_exceeds_available",
        )

    out_leg, in_leg = await inv_repo.create_transfer_pair(
        db,
        item_id=item_uuid,
        lot_id=lot_uuid,
        from_location_id=from_uuid,
        to_location_id=to_uuid,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
    )

    # Couple to LN2: keep the rack grids in sync with the transfer. If both
    # ends have racks, move that many of the lot's vials (paired move_out /
    # move_in); if only one end does, free / fill there. Rack-less ends are
    # ledger-only.
    src_has = await inv_repo.location_has_racks(db, from_uuid)
    dst_has = await inv_repo.location_has_racks(db, to_uuid)
    if src_has or dst_has:
        units = _whole_units_or_422(payload.qty)
        if src_has:
            mapped = await inv_repo.count_occupied_positions_for_lot(
                db, from_uuid, lot_uuid
            )
            if mapped < units:
                raise ConflictError(
                    f"Only {mapped} vial(s) of this lot are mapped at the source; "
                    f"cannot transfer {units}.",
                    code="not_enough_mapped_positions",
                )
        if dst_has:
            empty = await inv_repo.count_empty_positions(db, to_uuid)
            if empty < units:
                raise ConflictError(
                    f"Destination has only {empty} empty position(s); cannot place "
                    f"{units} unit(s).",
                    code="not_enough_empty_positions",
                )
        if src_has and dst_has:
            await inv_repo.transfer_positions_for_lot(
                db,
                from_location_id=from_uuid,
                to_location_id=to_uuid,
                lot_id=lot_uuid,
                n=units,
                actor_id=current.id,
            )
        elif src_has:
            await inv_repo.empty_positions_for_lot(
                db, location_id=from_uuid, lot_id=lot_uuid, n=units, actor_id=current.id
            )
        else:
            await inv_repo.fill_positions_for_lot(
                db, location_id=to_uuid, lot_id=lot_uuid, n=units, actor_id=current.id
            )

    # One evidence covers both legs. We bind it to the OUT leg row id
    # so the consumption record points at the canonical "source" leg.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.transfer",
        target_table="app.stock_movements",
        target_id=out_leg.id,
    )

    await db.commit()
    return TransferResponse(
        transfer_out=_movement_to_read(out_leg),
        transfer_in=_movement_to_read(in_leg),
    )


# ── Reverse (counter-movement) ─────────────────────────────────────────


@movements_router.post(
    "/{movement_id}/reverse",
    response_model=list[MovementRead],
    status_code=status.HTTP_201_CREATED,
    summary=(
        "Reverse a single ledger entry by writing a counter-movement. "
        "Transfer legs reverse both halves atomically. Requires "
        "action='movement.reverse' evidence."
    ),
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def reverse_movement(
    db: DBSession,
    current: CurrentDbUserDep,
    movement_id: Annotated[uuid.UUID, Path()],
    payload: ReverseRequest,
) -> list[MovementRead]:
    """Atomic counter-movement.

    Returns the inserted counter rows (one row for non-transfer
    originals, two for transfer pairs). Originals can only be reversed
    once — a second attempt returns ``movement_already_reversed`` 422.
    A reversal row itself cannot be reversed (use a fresh receipt /
    adjustment instead) — guarded by ``reversal_already_a_reversal``.
    """
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    original = await inv_repo.get_movement(db, movement_id)
    if original is None:
        raise NotFoundError(f"Movement {movement_id} not found")
    if original.reversal_of_id is not None:
        raise ValidationError(
            "This row is itself a reversal; you cannot reverse a reversal",
            code="reversal_already_a_reversal",
        )

    existing = await inv_repo.get_existing_reversal(db, original.id)
    if existing is not None:
        raise ValidationError(
            (
                f"Movement {original.id} has already been reversed by "
                f"{existing.id}"
            ),
            code="movement_already_reversed",
        )

    # Transfer pairs: both legs reverse together. Pick the partner and
    # also block if the partner is already reversed (shouldn't happen
    # since pairs must reverse together, but be defensive).
    counter_rows: list[StockMovement] = []
    if original.movement_type in ("transfer_in", "transfer_out"):
        partner = await inv_repo.get_transfer_partner(db, original)
        if partner is None:
            raise ValidationError(
                "Transfer partner leg not found; cannot reverse",
                code="transfer_partner_missing",
            )
        if (await inv_repo.get_existing_reversal(db, partner.id)) is not None:
            raise ValidationError(
                "Partner leg of this transfer has already been reversed",
                code="movement_already_reversed",
            )
        # Reverse the OUT first so the resulting transfer_in (into the
        # original source) precedes the transfer_out (out of the
        # original destination). Order doesn't change correctness — both
        # land in the same tx — but it keeps the ledger readable.
        out_original = original if original.movement_type == "transfer_out" else partner
        in_original = original if original.movement_type == "transfer_in" else partner
        counter_out = await inv_repo.create_reversal_movement(
            db,
            original=out_original,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            reason_code=payload.reason_code,
            notes=payload.notes,
        )
        counter_in = await inv_repo.create_reversal_movement(
            db,
            original=in_original,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            reason_code=payload.reason_code,
            notes=payload.notes,
        )
        counter_rows = [counter_out, counter_in]
    else:
        # Non-transfer: also block reversals that would push the
        # destination balance negative. Reversing a ``receipt`` of 10
        # vials that have since been mostly dispensed would create a
        # negative balance on the source side; flag rather than allow.
        if original.movement_type in ("receipt", "transfer_in"):
            # Counter dispense from original.to_location.
            assert original.to_location_id is not None
            available = await inv_repo.get_lot_location_available(
                db,
                item_id=original.item_id,
                lot_id=original.lot_id,  # type: ignore[arg-type]
                location_id=original.to_location_id,
            )
            if original.qty_abs > available:
                raise ValidationError(
                    (
                        f"Reversing this receipt would require removing "
                        f"{original.qty_abs} but only {available} remain at "
                        f"the destination; dispense the difference first"
                    ),
                    code="reversal_exceeds_available",
                )
        counter = await inv_repo.create_reversal_movement(
            db,
            original=original,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            reason_code=payload.reason_code,
            notes=payload.notes,
        )
        counter_rows = [counter]

    # Bind evidence to the FIRST counter row.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.reverse",
        target_table="app.stock_movements",
        target_id=counter_rows[0].id,
    )

    await db.commit()
    return [_movement_to_read(m) for m in counter_rows]


# ── Stock-by-lot (read, for the dispense wizard's lot picker) ──────────


@items_router.get(
    "/{item_id}/stock-by-lot",
    response_model=list[StockByLotEntry],
    summary=(
        "Per-lot, per-location available quantity for one item. "
        "Used by the dispense wizard to show 'L-123 at LN2-A — "
        "25 vials available'."
    ),
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_stock_by_lot(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    location_id: Annotated[
        uuid.UUID | None,
        Query(description="Narrow to a single location"),
    ] = None,
    include_empty: Annotated[
        bool,
        Query(description="Include (lot, location) pairs with qty_available <= 0"),
    ] = False,
) -> list[StockByLotEntry]:
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows = await inv_repo.list_stock_by_lot(
        db,
        item_id=item_id,
        location_id=location_id,
        only_positive=not include_empty,
    )
    return [StockByLotEntry(**r) for r in rows]


# ── Storage (racks + positions) ────────────────────────────────────────
#
# The LN2 / Storage grid. See ``docs/modules/storage.md``. Reads require
# ``inventory:view``; creating racks requires ``inventory:create``;
# assign / empty / move require ``inventory:edit``.


def _position_to_read(p: StoragePosition) -> PositionRead:
    lot = p.lot
    item = lot.item if lot is not None else None
    return PositionRead(
        id=str(p.id),
        index=p.seq,
        row_idx=p.row_idx,
        col_idx=p.col_idx,
        label=p.label,
        status=p.status,  # type: ignore[arg-type]
        lot_id=str(p.lot_id) if p.lot_id else None,
        lot_number=lot.lot_number if lot is not None else None,
        item_id=item.item_number if item is not None else None,
        item_uuid=str(item.id) if item is not None else None,
        item_description=item.description if item is not None else None,
        vendor_name=(item.vendor.name if item is not None and item.vendor else None),
        assigned_at=p.assigned_at,
    )


def _rack_to_read(r: StorageRack) -> RackRead:
    return RackRead(
        id=str(r.id),
        name=r.name,
        rows=r.rows,
        cols=r.cols,
        position_order=r.position_order,
        positions=[_position_to_read(p) for p in r.positions],
    )


def _storage_location_to_read(
    loc: Location, racks: list[StorageRack]
) -> StorageLocationRead:
    return StorageLocationRead(
        id=str(loc.id),
        name=loc.name,
        kind=loc.kind,  # type: ignore[arg-type]
        detail=loc.notes or "",
        racks=[_rack_to_read(r) for r in racks],
    )


@storage_router.get(
    "/locations",
    response_model=list[StorageLocationRead],
    summary="List storage locations with their racks + positions",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_storage(
    db: DBSession,
    active_only: bool = Query(default=True, description="Hide deactivated locations"),
) -> list[StorageLocationRead]:
    rows = await inv_repo.list_storage_locations(db, active_only=active_only)
    return [_storage_location_to_read(loc, racks) for loc, racks in rows]


@storage_router.post(
    "/locations",
    response_model=StorageLocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a storage location with one or more racks",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_storage_location(
    db: DBSession,
    payload: StorageLocationCreate,
) -> StorageLocationRead:
    loc = await inv_repo.create_storage_location(
        db,
        name=payload.name,
        kind=payload.kind,
        detail=payload.detail,
        racks=payload.racks,
    )
    loaded = await inv_repo.get_storage_location(db, loc.id)
    assert loaded is not None
    result = _storage_location_to_read(*loaded)
    await db.commit()
    return result


@storage_router.post(
    "/locations/{location_id}/racks",
    response_model=RackRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a rack to an existing location",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def add_storage_rack(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
    payload: RackInput,
) -> RackRead:
    if (await inv_repo.get_location(db, location_id)) is None:
        raise NotFoundError(f"Location {location_id} not found")
    rack = await inv_repo.add_storage_rack(
        db,
        location_id=location_id,
        name=payload.name,
        rows=payload.rows,
        cols=payload.cols,
    )
    loaded = await inv_repo.get_storage_rack(db, rack.id)
    assert loaded is not None
    result = _rack_to_read(loaded)
    await db.commit()
    return result


@storage_router.post(
    "/positions/{position_id}/assign",
    response_model=PositionRead,
    summary="Assign a lot (one vial) to an empty position",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def assign_position(
    db: DBSession,
    current: CurrentDbUserDep,
    position_id: Annotated[uuid.UUID, Path()],
    payload: AssignPositionRequest,
) -> PositionRead:
    position = await inv_repo.get_storage_position(db, position_id)
    if position is None:
        raise NotFoundError(f"Position {position_id} not found")
    if position.status != "empty":
        raise ConflictError("Position is already occupied", code="position_occupied")
    try:
        lot_uuid = uuid.UUID(payload.lot_id)
    except ValueError as exc:
        raise ValidationError("lot_id must be a UUID", code="invalid_lot_id") from exc
    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None or lot.deleted_at is not None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    await inv_repo.assign_storage_position(
        db, position=position, lot_id=lot_uuid, actor_id=current.id
    )
    # Keep inventory in sync: placing one vial in a slot is a +1 receipt for
    # this lot at the position's location, signed with the operator's
    # e-signature (same 21 CFR Part 11 ceremony as a unit-in).
    location_id = await inv_repo.position_location_id(db, position)
    movement = await inv_repo.create_receipt_movement(
        db,
        item_id=lot.item_id,
        lot_id=lot_uuid,
        to_location_id=location_id,
        qty=Decimal(1),
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.receipt",
        target_table="app.stock_movements",
        target_id=movement.id,
    )
    await db.commit()
    fresh = await inv_repo.get_storage_position(db, position_id, refresh=True)
    assert fresh is not None
    return _position_to_read(fresh)


@storage_router.post(
    "/positions/{position_id}/empty",
    response_model=PositionRead,
    summary="Empty a position (reversible unmap)",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def empty_position(
    db: DBSession,
    current: CurrentDbUserDep,
    position_id: Annotated[uuid.UUID, Path()],
    payload: EmptyPositionRequest,
) -> PositionRead:
    position = await inv_repo.get_storage_position(db, position_id)
    if position is None:
        raise NotFoundError(f"Position {position_id} not found")
    if position.status == "empty":
        return _position_to_read(position)  # idempotent
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    # Capture the occupant before we clear it so we can post the matching -1.
    prev_lot_id = position.lot_id
    prev_item_id = position.lot.item_id if position.lot is not None else None
    location_id = await inv_repo.position_location_id(db, position)
    await inv_repo.empty_storage_position(db, position=position, actor_id=current.id)
    # Emptying a slot removes one vial — record a signed -1 dispense so
    # inventory stays in sync with the grid.
    if prev_lot_id is not None and prev_item_id is not None:
        movement = await inv_repo.create_dispense_movement(
            db,
            item_id=prev_item_id,
            lot_id=prev_lot_id,
            from_location_id=location_id,
            qty=Decimal(1),
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            destination=payload.destination,
        )
        await consume_reauth_evidence(
            db,
            evidence_id=evidence_uuid,
            user_id=current.id,
            expected_action="movement.dispense",
            target_table="app.stock_movements",
            target_id=movement.id,
        )
    await db.commit()
    fresh = await inv_repo.get_storage_position(db, position_id, refresh=True)
    assert fresh is not None
    return _position_to_read(fresh)


@storage_router.post(
    "/positions/{position_id}/move",
    response_model=MovePositionResult,
    summary="Move an occupant to another free position (any location)",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def move_position(
    db: DBSession,
    current: CurrentDbUserDep,
    position_id: Annotated[uuid.UUID, Path()],
    payload: MovePositionRequest,
) -> MovePositionResult:
    source = await inv_repo.get_storage_position(db, position_id)
    if source is None:
        raise NotFoundError(f"Position {position_id} not found")
    if source.status != "occupied":
        raise ConflictError("Source position is empty", code="source_empty")
    try:
        dest_uuid = uuid.UUID(payload.dest_position_id)
    except ValueError as exc:
        raise ValidationError(
            "dest_position_id must be a UUID", code="invalid_dest_position_id"
        ) from exc
    if dest_uuid == position_id:
        raise ValidationError(
            "Source and destination are the same", code="same_position"
        )
    dest = await inv_repo.get_storage_position(db, dest_uuid)
    if dest is None:
        raise NotFoundError(f"Position {payload.dest_position_id} not found")
    if dest.status != "empty":
        raise ConflictError("Destination is occupied", code="dest_occupied")
    # Capture source occupant + both locations before the move.
    moved_lot_id = source.lot_id
    moved_item_id = source.lot.item_id if source.lot is not None else None
    src_loc = await inv_repo.position_location_id(db, source)
    dst_loc = await inv_repo.position_location_id(db, dest)
    await inv_repo.move_storage_position(
        db, source=source, dest=dest, actor_id=current.id
    )
    # A cross-location move is a transfer in the ledger; a move within the same
    # location is a pure slot relocation (no quantity change).
    if src_loc != dst_loc and moved_lot_id is not None and moved_item_id is not None:
        await inv_repo.create_transfer_pair(
            db,
            item_id=moved_item_id,
            lot_id=moved_lot_id,
            from_location_id=src_loc,
            to_location_id=dst_loc,
            qty=Decimal(1),
            performed_by_user_id=current.id,
        )
    await db.commit()
    fresh_source = await inv_repo.get_storage_position(db, position_id, refresh=True)
    fresh_dest = await inv_repo.get_storage_position(db, dest_uuid, refresh=True)
    assert fresh_source is not None and fresh_dest is not None
    return MovePositionResult(
        source=_position_to_read(fresh_source),
        dest=_position_to_read(fresh_dest),
    )


@storage_router.get(
    "/positions/{position_id}/history",
    response_model=list[PositionEventRead],
    summary="Event history for one position (unit in / out / move)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def position_history(
    db: DBSession,
    position_id: Annotated[uuid.UUID, Path()],
) -> list[PositionEventRead]:
    if (await inv_repo.get_storage_position(db, position_id)) is None:
        raise NotFoundError(f"Position {position_id} not found")
    rows = await inv_repo.list_position_events(db, position_id)
    return [PositionEventRead(**r) for r in rows]
