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
    ApprovedVendorCreate,
    ApprovedVendorRead,
    ItemCreate,
    ItemListResponse,
    ItemRead,
    ItemUpdate,
    LotCreate,
    LotRead,
    LotStatus,
    LotUpdate,
    MovementListResponse,
    MovementRead,
    MovementType,
    ReceiptIntakeRequest,
    ReceiptTransactionListResponse,
    ReceiptTransactionRead,
    ReceiveRequest,
    UnitOfMeasureRead,
    VendorCreate,
    VendorRead,
    VendorUpdate,
)
from app.locations import repository as loc_repo
from app.models.inventory import (
    Item,
    ItemApprovedVendor,
    Lot,
    ReceiptTransaction,
    StockMovement,
    UnitOfMeasure,
    Vendor,
)
from app.security.permissions import RequirePermission

items_router = APIRouter(prefix="/items", tags=["items"])
vendors_router = APIRouter(prefix="/vendors", tags=["vendors"])
uoms_router = APIRouter(prefix="/uoms", tags=["uoms"])
lots_router = APIRouter(prefix="/lots", tags=["lots"])
movements_router = APIRouter(prefix="/movements", tags=["movements"])
receiving_router = APIRouter(prefix="/receiving", tags=["receiving"])


# ── Serialisers ────────────────────────────────────────────────────────


def _uom_to_read(u: UnitOfMeasure) -> UnitOfMeasureRead:
    return UnitOfMeasureRead(code=u.code, label=u.label, is_discrete=u.is_discrete)


def _movement_to_read(
    m: StockMovement,
    labels: dict[uuid.UUID, tuple[str, str]] | None = None,
) -> MovementRead:
    labels = labels or {}
    from_label = labels.get(m.from_location_node_id) if m.from_location_node_id else None
    to_label = labels.get(m.to_location_node_id) if m.to_location_node_id else None
    return MovementRead(
        id=str(m.id),
        item_id=str(m.item_id),
        item_number=m.item.item_number if m.item else None,
        item_description=m.item.description if m.item else None,
        lot_id=str(m.lot_id) if m.lot_id else None,
        lot_number=m.lot.lot_number if m.lot else None,
        lot_expiration_date=m.lot.expiration_date if m.lot else None,
        from_location_node_id=(
            str(m.from_location_node_id) if m.from_location_node_id else None
        ),
        from_location_node_name=from_label[0] if from_label else None,
        from_location_node_path=from_label[1] if from_label else None,
        to_location_node_id=(
            str(m.to_location_node_id) if m.to_location_node_id else None
        ),
        to_location_node_name=to_label[0] if to_label else None,
        to_location_node_path=to_label[1] if to_label else None,
        movement_type=m.movement_type,  # type: ignore[arg-type]
        qty_delta=m.qty_delta,
        qty_abs=m.qty_abs,
        notes=m.notes,
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
        status=lot.status,  # type: ignore[arg-type]
        notes=lot.notes,
        unit_price_amount=lot.unit_price_amount,
        po_reference=lot.po_reference,
        receipt_transaction_id=(
            str(lot.receipt_transaction_id) if lot.receipt_transaction_id else None
        ),
        parent_lot_id=str(lot.parent_lot_id) if lot.parent_lot_id else None,
        ordered_qty=lot.ordered_qty,
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
    qty_available = stock.qty_available if stock else Decimal("0")
    status_code = stock.status_code if stock else "out_of_stock"
    last_movement_at = stock.last_movement_at if stock else None
    # ``inv_value_amount`` is qty × unit_price when both are known.
    # Pricing module / FX / per-package math comes later; this is the
    # straight-line cost projection for the inventory tile. Kept on
    # *physical* on-hand — expired stock is still a held asset until it's
    # scrapped, so it shouldn't vanish from the inventory value.
    inv_value_amount = (
        qty_on_hand * item.unit_price_amount
        if item.unit_price_amount is not None
        else Decimal("0")
    )
    return ItemRead(
        id=str(item.id),
        item_number=item.item_number,
        description=item.description,
        category=item.category,
        vendor_id=str(item.vendor_id) if item.vendor_id else None,
        vendor_name=item.vendor.name if item.vendor else None,
        avg_lead_days=item.avg_lead_days,
        reorder_threshold=item.reorder_threshold,
        near_expiry_threshold_days=item.near_expiry_threshold_days,
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
        qty_available=qty_available,
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
    "/by-number/{item_number}",
    response_model=ItemRead,
    summary="Get one inventory item by its human-readable number (e.g. CM-0001)",
    # Registered *before* the UUID route so ``by-number`` isn't swallowed
    # by FastAPI's UUID Path validator on ``/items/{item_id}``.
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_item_by_number(
    db: DBSession,
    # item_number is free-form (§3.1) — treat it as an opaque key here and
    # let the repository 404 on miss, rather than constraining the shape.
    item_number: Annotated[str, Path(min_length=1, max_length=64)],
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
            category=payload.category,
            vendor_id=vendor_uuid,
            avg_lead_days=payload.avg_lead_days,
            reorder_threshold=payload.reorder_threshold,
            near_expiry_threshold_days=payload.near_expiry_threshold_days,
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
    summary="Update a lot (e-signed; all changes audited)",
    # Editing a lot after entry is a GxP-significant correction (e.g.
    # fixing a wrong expiration date), so it requires an e-signature —
    # the ``sign`` permission plus a fresh reauth ticket — not the
    # routine ``create`` gate used for un-signed master-data writes.
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def update_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    lot_id: Annotated[uuid.UUID, Path()],
    payload: LotUpdate,
) -> LotRead:
    """Partial lot update under an electronic signature.

    Editable: status, dates, vendor, CoA URL, notes (``lot_number`` and
    the parent item are immutable identity). Every edit consumes a fresh
    reauth ticket minted for action='lot.update' and writes an audit row
    that links the signature (``signature_id``) and records the
    mandatory reason for change. The DB CHECK on date ordering is the
    authoritative guard; the route surfaces the structured
    ``lot_dates_inverted`` code if the operator inverts them.
    """
    patch = payload.model_dump(exclude_unset=True)
    # The signing fields ride on the same body but aren't lot columns —
    # pull them out before the patch touches the ORM row. Both are
    # required by the schema, so they're always present here.
    evidence_str = patch.pop("evidence_id")
    reason = patch.pop("reason")
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    evidence_uuid = _parse_uuid_or_422(evidence_str, field="evidence_id")

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
        context={"reason": reason},
        signature_id=evidence_uuid,
    )

    # Consume the e-signature evidence last so a replay / expiry rolls
    # back the patch *and* the audit row together. ``expected_action``
    # must match the verb the ticket was minted for.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="lot.update",
        target_table="app.lots",
        target_id=updated.id,
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
    location_node_id: Annotated[
        uuid.UUID | None,
        Query(description="Matches from_location_node_id OR to_location_node_id"),
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
        location_node_id=location_node_id,
        movement_type=movement_type,
        limit=limit,
        offset=offset,
    )
    labels = await loc_repo.node_label_map(db)
    return MovementListResponse(
        items=[_movement_to_read(m, labels) for m in rows],
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
    labels = await loc_repo.node_label_map(db)
    return MovementListResponse(
        items=[_movement_to_read(m, labels) for m in rows],
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


# ── Receipt Admin v2 ───────────────────────────────────────────────────
#
# Approved-vendor mapping + the two-step intake (ON_ORDER) → physical
# receipt (AVAILABLE, with splitting). See docs/modules/receipt-admin.md.


def _approved_vendor_to_read(m: ItemApprovedVendor) -> ApprovedVendorRead:
    return ApprovedVendorRead(
        item_id=str(m.item_id),
        vendor_id=str(m.vendor_id),
        vendor_name=m.vendor.name if m.vendor else "",
        approval_status=m.approval_status,  # type: ignore[arg-type]
        created_at=m.created_at,
    )


def _receipt_txn_to_read(txn: ReceiptTransaction) -> ReceiptTransactionRead:
    # ``txn.lots`` is the eager (selectinload) relationship — newest last.
    # Soft-deleted lots are filtered here (the relationship has no WHERE).
    lots = [_lot_to_read(lot) for lot in txn.lots if lot.deleted_at is None]
    return ReceiptTransactionRead(
        id=str(txn.id),
        item_id=str(txn.item_id),
        item_number=txn.item.item_number if txn.item else None,
        item_description=txn.item.description if txn.item else None,
        status=txn.status,  # type: ignore[arg-type]
        po_reference=txn.po_reference,
        notes=txn.notes,
        created_by_user_id=str(txn.created_by_user_id),
        received_by_user_id=(
            str(txn.received_by_user_id) if txn.received_by_user_id else None
        ),
        received_at=txn.received_at,
        created_at=txn.created_at,
        updated_at=txn.updated_at,
        lots=lots,
    )


async def _resolve_vendor(
    db: DBSession,
    *,
    vendor_id: str | None,
    vendor_name: str | None,
) -> tuple[Vendor, bool]:
    """Resolve a (mandatory) vendor from an id or a free-text name.

    Returns ``(vendor, created)``. An ``id`` must reference an existing
    vendor (404 otherwise); a ``name`` reuses a case-insensitive match or
    creates a new vendor (edge case 2). Exactly one of the two is set —
    the schema validators already enforce the XOR.
    """
    if vendor_id is not None:
        vendor_uuid = _parse_uuid_or_422(vendor_id, field="vendor_id")
        vendor = await inv_repo.get_vendor(db, vendor_uuid)
        if vendor is None:
            raise NotFoundError(f"Vendor {vendor_id} not found")
        if not vendor.is_active:
            raise ValidationError(
                "Vendor is inactive; pick an active vendor",
                code="vendor_inactive",
            )
        return vendor, False
    assert vendor_name is not None
    return await inv_repo.get_or_create_vendor_by_name(db, name=vendor_name)


async def _ensure_item_vendor(
    db: DBSession,
    *,
    item_id: uuid.UUID,
    vendor_id: uuid.UUID,
    user_id: uuid.UUID,
) -> bool:
    """Idempotently attach a vendor to an item's vendor list.

    The item's vendor list IS its approved-vendor list — using a vendor on
    a receipt attaches it (approved). Returns True when a new mapping was
    created. The pre-check (plus ``add_approved_vendor``'s flush) makes this
    safe to call repeatedly within one request, including for two lot lines
    that share a vendor.
    """
    if (
        await inv_repo.get_approved_vendor(db, item_id=item_id, vendor_id=vendor_id)
    ) is not None:
        return False
    await inv_repo.add_approved_vendor(
        db,
        item_id=item_id,
        vendor_id=vendor_id,
        approval_status="approved",
        created_by_user_id=user_id,
    )
    return True


# ── Approved-vendor mapping (per item) ─────────────────────────────────


@items_router.get(
    "/{item_id}/approved-vendors",
    response_model=list[ApprovedVendorRead],
    summary="List an item's approved/pending vendors",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_approved_vendors(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
) -> list[ApprovedVendorRead]:
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows = await inv_repo.list_approved_vendors(db, item_id)
    return [_approved_vendor_to_read(m) for m in rows]


@items_router.post(
    "/{item_id}/approved-vendors",
    response_model=ApprovedVendorRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a vendor to an item's approved list",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def add_item_approved_vendor(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    payload: ApprovedVendorCreate,
) -> ApprovedVendorRead:
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")

    vendor, created = await _resolve_vendor(
        db, vendor_id=payload.vendor_id, vendor_name=payload.vendor_name
    )

    if (
        await inv_repo.get_approved_vendor(
            db, item_id=item_id, vendor_id=vendor.id
        )
    ) is not None:
        raise ConflictError(
            f"Vendor '{vendor.name}' is already mapped to this item",
            code="approved_vendor_exists",
        )

    try:
        mapping = await inv_repo.add_approved_vendor(
            db,
            item_id=item_id,
            vendor_id=vendor.id,
            approval_status=payload.approval_status,
            created_by_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_item_approved_vendors_item_vendor" in msg:
            raise ConflictError(
                f"Vendor '{vendor.name}' is already mapped to this item",
                code="approved_vendor_exists",
            ) from exc
        raise

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="meta.item_approved_vendors",
        subject_id=mapping.id,
        subject_label=f"{item.item_number} → {vendor.name}",
        before=None,
        after={
            "item_id": str(item_id),
            "vendor_id": str(vendor.id),
            "vendor_name": vendor.name,
            "approval_status": mapping.approval_status,
            "vendor_created": created,
        },
    )
    response = _approved_vendor_to_read(mapping)
    await db.commit()
    return response


@items_router.delete(
    "/{item_id}/approved-vendors/{vendor_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a vendor from an item's approved list",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def remove_item_approved_vendor(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    vendor_id: Annotated[uuid.UUID, Path()],
) -> None:
    mapping = await inv_repo.get_approved_vendor(
        db, item_id=item_id, vendor_id=vendor_id
    )
    if mapping is None:
        raise NotFoundError(
            f"Vendor {vendor_id} is not mapped to item {item_id}"
        )
    label = f"{item_id} → {mapping.vendor.name if mapping.vendor else vendor_id}"
    before = {
        "item_id": str(item_id),
        "vendor_id": str(vendor_id),
        "approval_status": mapping.approval_status,
    }
    await inv_repo.remove_approved_vendor(db, mapping=mapping)
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="meta.item_approved_vendors",
        subject_id=mapping.id,
        subject_label=label,
        before=before,
        after=None,
    )
    await db.commit()


# ── Receipt transactions (intake → receive) ────────────────────────────


@receiving_router.get(
    "/transactions",
    response_model=ReceiptTransactionListResponse,
    summary="List receipt transactions (newest first)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_receipt_transactions(
    db: DBSession,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    status_filter: Annotated[
        Literal["open", "received", "cancelled"] | None,
        Query(alias="status", description="Filter by transaction status"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReceiptTransactionListResponse:
    rows, total = await inv_repo.list_receipt_transactions(
        db, item_id=item_id, status=status_filter, limit=limit, offset=offset
    )
    return ReceiptTransactionListResponse(
        items=[_receipt_txn_to_read(t) for t in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@receiving_router.get(
    "/transactions/{txn_id}",
    response_model=ReceiptTransactionRead,
    summary="Get one receipt transaction + its lots",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_receipt_transaction(
    db: DBSession,
    txn_id: Annotated[uuid.UUID, Path()],
) -> ReceiptTransactionRead:
    txn = await inv_repo.get_receipt_transaction(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Receipt transaction {txn_id} not found")
    return _receipt_txn_to_read(txn)


@receiving_router.post(
    "/transactions",
    response_model=ReceiptTransactionRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a receipt intake — ON_ORDER lots (Receipt Admin §4)",
    # Intake places an order; no stock moves yet, so it's the routine
    # ``create`` gate (not the e-signed ``sign`` path the physical receipt uses).
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_receipt_intake(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ReceiptIntakeRequest,
) -> ReceiptTransactionRead:
    """Step 1–4: resolve item + vendors, create ON_ORDER lots under a new
    receipt-transaction header. Atomic — any failure rolls the whole
    intake back. No ledger movement is posted (goods aren't in yet)."""
    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")

    # Reject duplicate lot numbers within the same intake up-front.
    seen_numbers: set[str] = set()
    for line in payload.lots:
        key = line.lot_number.strip().lower()
        if key in seen_numbers:
            raise ValidationError(
                f"Duplicate lot_number '{line.lot_number}' in this intake",
                code="duplicate_lot_number_in_request",
            )
        seen_numbers.add(key)

    txn = await inv_repo.create_receipt_transaction(
        db,
        item_id=item_uuid,
        created_by_user_id=current.id,
        po_reference=payload.po_reference,
        notes=payload.notes,
    )

    for line in payload.lots:
        vendor, created = await _resolve_vendor(
            db, vendor_id=line.vendor_id, vendor_name=line.vendor_name
        )

        # Lot-number uniqueness pre-check (clean 409; index is the guard).
        if (
            await inv_repo.get_lot_by_item_and_number(
                db, item_id=item_uuid, lot_number=line.lot_number
            )
        ) is not None:
            raise ConflictError(
                f"lot_number '{line.lot_number}' already exists for this item",
                code="lot_number_conflict",
            )

        try:
            lot = await inv_repo.create_lot(
                db,
                item_id=item_uuid,
                lot_number=line.lot_number,
                created_by_user_id=current.id,
                vendor_id=vendor.id,
                manufacture_date=line.manufacture_date,
                expiration_date=line.expiration_date,
                status="on_order",
                notes=line.notes,
                unit_price_amount=line.unit_price,
                po_reference=line.po_reference or payload.po_reference,
                ordered_qty=line.quantity,
                receipt_transaction_id=txn.id,
            )
        except IntegrityError as exc:
            await db.rollback()
            msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
            if "uq_lots_item_lot_number" in msg:
                raise ConflictError(
                    f"lot_number '{line.lot_number}' already exists for this item",
                    code="lot_number_conflict",
                ) from exc
            if "ck_lots_dates_ordered" in msg:
                raise ValidationError(
                    "expiration_date must be on or after manufacture_date",
                    code="lot_dates_inverted",
                ) from exc
            raise

        # Attach the vendor to the item (idempotent). The item's vendor list
        # IS its approved-vendor list, so any vendor used here becomes one of
        # the item's vendors. ``created`` (a brand-new vendor record) is only
        # used for the audit context below.
        await _ensure_item_vendor(
            db, item_id=item_uuid, vendor_id=vendor.id, user_id=current.id
        )

        # Audit the vendor assignment + lot creation (v2 §8).
        await record_entity_change(
            db,
            actor_user_id=current.id,
            action="created",
            subject_table="app.lots",
            subject_id=lot.id,
            subject_label=lot.lot_number,
            before=None,
            after=inv_repo.lot_to_audit_snapshot(lot),
            context={
                "receipt_transaction_id": str(txn.id),
                "vendor_created": created,
            },
        )

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.receipt_transactions",
        subject_id=txn.id,
        subject_label=f"{item.item_number} intake ({len(payload.lots)} lot(s))",
        before=None,
        after=inv_repo.receipt_transaction_to_audit_snapshot(txn),
    )

    refreshed = await inv_repo.get_receipt_transaction(db, txn.id)
    assert refreshed is not None
    response = _receipt_txn_to_read(refreshed)
    await db.commit()
    return response


@receiving_router.post(
    "/transactions/{txn_id}/receive",
    response_model=ReceiptTransactionRead,
    status_code=status.HTTP_201_CREATED,
    summary="Physical receipt — ON_ORDER → AVAILABLE (+split). E-signed.",
    # Posts ledger movements, so it's GxP-significant: ``sign`` permission +
    # a fresh reauth ticket for action='receipt.confirm' (consumed once).
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def receive_transaction(
    db: DBSession,
    current: CurrentDbUserDep,
    txn_id: Annotated[uuid.UUID, Path()],
    payload: ReceiveRequest,
) -> ReceiptTransactionRead:
    """Step 5: confirm a physical receipt. Per ON_ORDER lot the operator
    submits one or more splits; the first receives into the original lot
    (flip → AVAILABLE), the rest create child lots (``parent_lot_id``).
    No ledger movement and no placement are recorded — receive is lifecycle
    only; quantity arrives later as a unit-IN (place) in the Location System.
    One e-signature covers the whole receipt; commits atomically."""
    txn = await inv_repo.get_receipt_transaction(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Receipt transaction {txn_id} not found")
    if txn.status != "open":
        raise ValidationError(
            f"Transaction is '{txn.status}'; only open transactions can be received",
            code="receipt_not_open",
        )

    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    # Receiving records NO quantity and NO placement — it only flips the lot
    # lifecycle (on_order → available), adjusts details, and optionally splits
    # the order into supplier lots. Quantity comes later as a unit-IN (place)
    # in the Location System.

    # Index the transaction's still-ON_ORDER lots for line resolution.
    lots_by_id = {
        lot.id: lot
        for lot in txn.lots
        if lot.deleted_at is None and lot.status == "on_order"
    }

    for line in payload.lines:
        lot_uuid = _parse_uuid_or_422(line.lot_id, field="lot_id")
        lot = lots_by_id.get(lot_uuid)
        if lot is None:
            raise ValidationError(
                f"Lot {line.lot_id} is not an open ON_ORDER lot in this transaction",
                code="lot_not_in_transaction",
            )

        child_numbers: set[str] = set()
        for idx, split in enumerate(line.splits):
            # Vendor: explicit override, else inherit the on-order lot's vendor
            # (which intake guaranteed is set).
            if split.vendor_id is not None or split.vendor_name is not None:
                vendor, _created = await _resolve_vendor(
                    db, vendor_id=split.vendor_id, vendor_name=split.vendor_name
                )
                vendor_id = vendor.id
            else:
                if lot.vendor_id is None:  # pragma: no cover — intake guarantees it
                    raise ValidationError(
                        "Lot has no vendor; supply a vendor for this split",
                        code="vendor_required",
                    )
                vendor_id = lot.vendor_id

            # Attach the (possibly overridden) vendor to the item — keeps the
            # item's vendor list complete as supplier lots are split out.
            await _ensure_item_vendor(
                db, item_id=txn.item_id, vendor_id=vendor_id, user_id=current.id
            )

            if idx == 0:
                # Receive into the original lot.
                if split.lot_number is not None:
                    raise ValidationError(
                        "The first split receives into the original lot and "
                        "must not set lot_number",
                        code="first_split_lot_number",
                    )
                patch: dict[str, object] = {"status": "available"}
                if split.unit_price is not None:
                    patch["unit_price_amount"] = split.unit_price
                if split.po_reference is not None:
                    patch["po_reference"] = split.po_reference
                if vendor_id != lot.vendor_id:
                    patch["vendor_id"] = vendor_id
                target_lot = await inv_repo.apply_lot_patch(
                    db, lot=lot, patch=patch, updated_by_user_id=current.id
                )
                # No ledger movement / placement — receive is lifecycle only.
                await record_entity_change(
                    db,
                    actor_user_id=current.id,
                    action="updated",
                    subject_table="app.lots",
                    subject_id=target_lot.id,
                    subject_label=target_lot.lot_number,
                    before={"status": "on_order"},
                    after={"status": "available"},
                    context={"receipt_transaction_id": str(txn.id)},
                    signature_id=evidence_uuid,
                )
            else:
                # Child lot (split). lot_number is required + unique.
                if split.lot_number is None:
                    raise ValidationError(
                        "Splits after the first must each set a distinct lot_number",
                        code="split_lot_number_required",
                    )
                ckey = split.lot_number.strip().lower()
                if ckey in child_numbers:
                    raise ValidationError(
                        f"Duplicate split lot_number '{split.lot_number}'",
                        code="duplicate_split_lot_number",
                    )
                child_numbers.add(ckey)
                if (
                    await inv_repo.get_lot_by_item_and_number(
                        db, item_id=txn.item_id, lot_number=split.lot_number
                    )
                ) is not None:
                    raise ConflictError(
                        f"lot_number '{split.lot_number}' already exists for this item",
                        code="lot_number_conflict",
                    )
                child = await inv_repo.create_lot(
                    db,
                    item_id=txn.item_id,
                    lot_number=split.lot_number,
                    created_by_user_id=current.id,
                    vendor_id=vendor_id,
                    manufacture_date=split.manufacture_date or lot.manufacture_date,
                    expiration_date=split.expiration_date or lot.expiration_date,
                    status="available",
                    notes=split.notes,
                    unit_price_amount=split.unit_price,
                    po_reference=split.po_reference or lot.po_reference,
                    receipt_transaction_id=txn.id,
                    parent_lot_id=lot.id,
                )
                # No ledger movement / placement — receive is lifecycle only.
                await record_entity_change(
                    db,
                    actor_user_id=current.id,
                    action="created",
                    subject_table="app.lots",
                    subject_id=child.id,
                    subject_label=child.lot_number,
                    before=None,
                    after=inv_repo.lot_to_audit_snapshot(child),
                    context={
                        "split_from_lot_id": str(lot.id),
                        "receipt_transaction_id": str(txn.id),
                    },
                    signature_id=evidence_uuid,
                )

    # One e-signature for the whole receipt, consumed against the txn.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="receipt.confirm",
        target_table="app.receipt_transactions",
        target_id=txn.id,
    )

    updated = await inv_repo.set_receipt_transaction_status(
        db, txn=txn, status="received", received_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.receipt_transactions",
        subject_id=updated.id,
        subject_label="receipt confirmed",
        before={"status": "open"},
        after=inv_repo.receipt_transaction_to_audit_snapshot(updated),
        signature_id=evidence_uuid,
    )

    response = _receipt_txn_to_read(updated)
    await db.commit()
    return response
