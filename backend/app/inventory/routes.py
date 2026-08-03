"""``/v1/items`` and ``/v1/suppliers`` routes.

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
from app.core.search import MAX_SEARCH_LENGTH
from app.inventory import repository as inv_repo
from app.inventory.schemas import (
    ItemCreate,
    ItemListResponse,
    ItemRead,
    ItemSupplierRead,
    ItemUpdate,
    LotCreate,
    LotNumberAvailability,
    LotRead,
    LotStatus,
    LotUpdate,
    MovementListResponse,
    MovementRead,
    MovementType,
    OrderActionRequest,
    OrderCreateRequest,
    OrderLineRead,
    OrderUpdateRequest,
    ReceiptEventLineRead,
    ReceiptEventRead,
    ReceiptTransactionListResponse,
    ReceiptTransactionRead,
    ReceiveEventRequest,
    ReceivePlacement,
    SupplierCreate,
    SupplierRead,
    SupplierUpdate,
)
from app.locations import repository as loc_repo
from app.models.inventory import (
    BUILT_TIER_TYPES,
    Item,
    Lot,
    ReceiptTransaction,
    StockMovement,
    Supplier,
)
from app.models.locations import can_store, is_grid_node
from app.security.permissions import RequirePermission

items_router = APIRouter(prefix="/items", tags=["items"])
suppliers_router = APIRouter(prefix="/suppliers", tags=["suppliers"])
lots_router = APIRouter(prefix="/lots", tags=["lots"])
movements_router = APIRouter(prefix="/movements", tags=["movements"])
receiving_router = APIRouter(prefix="/receiving", tags=["receiving"])


# ── Serialisers ────────────────────────────────────────────────────────


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
        kit_id=str(m.kit_id) if m.kit_id else None,
        kit_number=m.kit.kit_number if m.kit else None,
        # Reuses the same node-label map the from/to ends resolve through, so
        # this costs no extra query.
        kit_production_location_node_id=(
            str(m.kit.production_location_node_id)
            if m.kit and m.kit.production_location_node_id
            else None
        ),
        kit_production_location_name=(
            prod_label[0]
            if (
                prod_label := (
                    labels.get(m.kit.production_location_node_id)
                    if m.kit and m.kit.production_location_node_id
                    else None
                )
            )
            else None
        ),
        customer_id=str(m.customer_id) if m.customer_id else None,
        customer_name=m.customer.name if m.customer else None,
        reference_number=m.reference_number,
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
        supplier_id=str(lot.supplier_id) if lot.supplier_id else None,
        supplier_name=lot.supplier.name if lot.supplier else None,
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


def _supplier_to_read(v: Supplier) -> SupplierRead:
    return SupplierRead(
        id=str(v.id),
        name=v.name,
        contact_email=v.contact_email,
        phone=v.phone,
        is_active=v.is_active,
        notes=v.notes,
        created_at=v.created_at,
        updated_at=v.updated_at,
    )


def _item_to_read(
    item: Item,
    valuation: tuple[Decimal, Decimal, Decimal] | None = None,
    bom_line_count: int = 0,
) -> ItemRead:
    # The eager ``Item.stock`` relationship joins ``app.v_item_stock``,
    # which is LEFT-joined on the items query so newly-created items
    # without movements still resolve (``qty_on_hand = 0``,
    # ``status_code = 'out_of_stock'``).
    stock = item.stock
    qty_on_hand = stock.qty_on_hand if stock else Decimal("0")
    qty_available = stock.qty_available if stock else Decimal("0")
    status_code = stock.status_code if stock else "out_of_stock"
    last_movement_at = stock.last_movement_at if stock else None
    # Valuation comes from the lots' unit prices (see
    # ``inv_repo.compute_item_valuations``): inv_value from on-hand units ×
    # their lot price, po_value / qty_on_order from ON_ORDER lots. Items not
    # in the precomputed map default to zero.
    inv_value_amount, po_value_amount, qty_on_order = valuation or (
        Decimal("0"),
        Decimal("0"),
        Decimal("0"),
    )
    tier = item.tier
    prefix = item.prefix
    return ItemRead(
        id=str(item.id),
        item_number=item.item_number,
        sku_suffix=item.sku_suffix,
        description=item.description,
        uom=item.uom,
        is_consumable=item.is_consumable,
        tier_id=str(item.tier_id),
        tier_name=tier.name if tier else "",
        tier_type=tier.type if tier else "raw_material",  # type: ignore[arg-type]
        tier_tone=tier.tone if tier else "neutral",
        prefix_id=str(item.prefix_id),
        prefix_code=prefix.code if prefix else "",
        prefix_label=prefix.label if prefix else None,
        suppliers=[
            ItemSupplierRead(
                supplier_id=str(iv.supplier_id),
                supplier_name=iv.supplier.name if iv.supplier else "",
            )
            for iv in item.suppliers
        ],
        avg_lead_days=item.avg_lead_days,
        reorder_threshold=item.reorder_threshold,
        near_expiry_threshold_days=item.near_expiry_threshold_days,
        must_order_flag=item.must_order_flag,
        last_updated_on=item.last_updated_on,
        created_at=item.created_at,
        updated_at=item.updated_at,
        created_by_user_id=str(item.created_by_user_id),
        updated_by_user_id=str(item.updated_by_user_id),
        # Derived from the ledger view + lot valuations.
        qty_on_hand=qty_on_hand,
        qty_available=qty_available,
        qty_on_order=qty_on_order,
        inv_value_amount=inv_value_amount,
        po_value_amount=po_value_amount,
        status_code=status_code,  # type: ignore[arg-type]
        last_movement_at=last_movement_at,
        bom_line_count=bom_line_count,
    )


async def _item_read_with_valuation(db: DBSession, item: Item) -> ItemRead:
    """Serialise a single item, computing its lot-derived valuation."""
    valuations = await inv_repo.compute_item_valuations(db, [item.id])
    counts = await inv_repo.bom_line_counts(db, [item.id])
    return _item_to_read(item, valuations.get(item.id), counts.get(item.id, 0))


async def _resolve_item_supplier_ids(
    db: DBSession, supplier_ids: list[str]
) -> list[uuid.UUID]:
    """Parse + validate an item's assigned-supplier id list.

    Each entry must be a valid UUID referencing an existing supplier. Returns
    the de-duplicated UUIDs in input order. 404s on an unknown supplier, 422s
    on a malformed id.
    """
    resolved: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for raw in supplier_ids:
        supplier_uuid = _parse_uuid_or_422(raw, field="supplier_id")
        if supplier_uuid in seen:
            continue
        if (await inv_repo.get_supplier(db, supplier_uuid)) is None:
            raise NotFoundError(f"Supplier {raw} not found")
        seen.add(supplier_uuid)
        resolved.append(supplier_uuid)
    return resolved


# ── Suppliers ────────────────────────────────────────────────────────────


@suppliers_router.get(
    "",
    response_model=list[SupplierRead],
    summary="List suppliers",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_suppliers(
    db: DBSession,
    active_only: bool = Query(default=True, description="Hide suppliers with is_active=false"),
) -> list[SupplierRead]:
    suppliers = await inv_repo.list_suppliers(db, active_only=active_only)
    return [_supplier_to_read(v) for v in suppliers]


@suppliers_router.get(
    "/{supplier_id}",
    response_model=SupplierRead,
    summary="Get one supplier",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_supplier(
    db: DBSession,
    supplier_id: Annotated[uuid.UUID, Path()],
) -> SupplierRead:
    supplier = await inv_repo.get_supplier(db, supplier_id)
    if supplier is None:
        raise NotFoundError(f"Supplier {supplier_id} not found")
    return _supplier_to_read(supplier)


@suppliers_router.post(
    "",
    response_model=SupplierRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a supplier (admin master-data write)",
    # Suppliers are master data — same gate as item create. PATCH / DELETE
    # now ship (Chunk A); every edit + soft-delete writes to
    # ``audit.audit_events`` via the recorder helper.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_supplier(
    db: DBSession,
    payload: SupplierCreate,
) -> SupplierRead:
    # Pre-check for a clean 409. The partial-unique index on lower(name)
    # is the authoritative guard (handled in the except).
    if (await inv_repo.get_supplier_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"Supplier with name '{payload.name}' already exists",
            code="supplier_name_conflict",
        )
    try:
        supplier = await inv_repo.create_supplier(
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
        if "uq_suppliers_name" in msg:
            raise ConflictError(
                f"Supplier with name '{payload.name}' already exists",
                code="supplier_name_conflict",
            ) from exc
        raise
    return _supplier_to_read(supplier)


@suppliers_router.patch(
    "/{supplier_id}",
    response_model=SupplierRead,
    summary="Update a supplier (admin master-data write)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_supplier(
    db: DBSession,
    current: CurrentDbUserDep,
    supplier_id: Annotated[uuid.UUID, Path()],
    payload: SupplierUpdate,
) -> SupplierRead:
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

    supplier = await inv_repo.get_supplier(db, supplier_id)
    if supplier is None:
        raise NotFoundError(f"Supplier {supplier_id} not found")

    # Name-collision pre-check when renaming.
    if "name" in patch and isinstance(patch["name"], str):
        if patch["name"].strip().lower() != supplier.name.lower():
            existing = await inv_repo.get_supplier_by_name(db, patch["name"])
            if existing is not None and existing.id != supplier.id:
                raise ConflictError(
                    f"Supplier with name '{patch['name']}' already exists",
                    code="supplier_name_conflict",
                )

    before = inv_repo.supplier_to_audit_snapshot(supplier)
    try:
        updated = await inv_repo.apply_supplier_patch(db, supplier=supplier, patch=patch)
    except IntegrityError as exc:
        await db.rollback()
        msg = (str(exc.orig).lower() if exc.orig else str(exc).lower())
        if "uq_suppliers_name" in msg:
            raise ConflictError(
                "Supplier name conflict",
                code="supplier_name_conflict",
            ) from exc
        raise
    after = inv_repo.supplier_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.suppliers",
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
    response = _supplier_to_read(updated)
    await db.commit()
    return response


@suppliers_router.delete(
    "/{supplier_id}",
    response_model=SupplierRead,
    summary="Deactivate a supplier (soft delete via is_active=false)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_supplier(
    db: DBSession,
    current: CurrentDbUserDep,
    supplier_id: Annotated[uuid.UUID, Path()],
) -> SupplierRead:
    """Soft-delete a supplier by flipping ``is_active=false``.

    Hard deletion is forbidden — items and lots FK to this supplier and
    the audit trail wants to keep resolving the supplier name historic.
    A deactivated supplier stops appearing in pickers but stays visible
    on past records.
    """
    supplier = await inv_repo.get_supplier(db, supplier_id)
    if supplier is None:
        raise NotFoundError(f"Supplier {supplier_id} not found")
    if not supplier.is_active:
        # Idempotent — second DELETE on an already-deactivated supplier
        # returns the current state without an extra audit row.
        return _supplier_to_read(supplier)

    before = inv_repo.supplier_to_audit_snapshot(supplier)
    updated = await inv_repo.apply_supplier_patch(
        db, supplier=supplier, patch={"is_active": False}
    )
    after = inv_repo.supplier_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="meta.suppliers",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _supplier_to_read(updated)
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
    q: Annotated[
        str | None,
        Query(
            description="Search description + item_number",
            max_length=MAX_SEARCH_LENGTH,
        ),
    ] = None,
    supplier_id: Annotated[uuid.UUID | None, Query()] = None,
    tier_id: Annotated[
        uuid.UUID | None, Query(description="Filter by item tier")
    ] = None,
    prefix_id: Annotated[
        uuid.UUID | None, Query(description="Filter by item prefix")
    ] = None,
    status_filter: Annotated[
        Literal["available", "low_stock", "out_of_stock"] | None,
        Query(
            alias="status",
            description="Filter by computed stock status from v_item_stock",
        ),
    ] = None,
    is_consumable: Annotated[
        bool | None,
        Query(description="Filter to consumables (true) or non-consumables (false)"),
    ] = None,
    has_bom: Annotated[
        bool | None,
        Query(
            description=(
                "Filter to items that have (true) or lack (false) a bill of "
                "materials. ``false`` is the 'missing BOM' view."
            )
        ),
    ] = None,
    min_bom_lines: Annotated[
        int | None,
        Query(
            ge=1,
            description=(
                "Filter to items whose BOM has at least this many distinct "
                "components. Kitting passes 2: every composition rule in the "
                "Transaction Spec is two-input, so a one-line BOM is an "
                "incomplete recipe rather than something you can kit."
            ),
        ),
    ] = None,
    below_reorder: Annotated[
        bool | None,
        Query(
            description=(
                "Filter to items at or below their reorder threshold — i.e. "
                "needing reorder. Broader than status=low_stock, which "
                "excludes zero-stock items."
            )
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
        supplier_id=supplier_id,
        status=status_filter,
        tier_id=tier_id,
        prefix_id=prefix_id,
        is_consumable=is_consumable,
        has_bom=has_bom,
        min_bom_lines=min_bom_lines,
        below_reorder=below_reorder,
        sort=sort,
        direction=direction,
        limit=limit,
        offset=offset,
    )
    ids = [i.id for i in items]
    valuations = await inv_repo.compute_item_valuations(db, ids)
    # One grouped count for the page, not one query per row.
    bom_counts = await inv_repo.bom_line_counts(db, ids)
    return ItemListResponse(
        items=[
            _item_to_read(i, valuations.get(i.id), bom_counts.get(i.id, 0))
            for i in items
        ],
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
    return await _item_read_with_valuation(db, item)


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
    return await _item_read_with_valuation(db, item)


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
    # Validate the assigned-supplier list (each must be an existing supplier).
    supplier_uuids = await _resolve_item_supplier_ids(db, payload.supplier_ids)

    # Validate the prefix (the tier is derived from it).
    prefix_uuid = _parse_uuid_or_422(payload.prefix_id, field="prefix_id")
    prefix = await inv_repo.get_prefix(db, prefix_uuid)
    if prefix is None:
        raise NotFoundError(f"Prefix {payload.prefix_id} not found")

    # The derived number is ``<code>-<suffix>``; uniqueness is per (prefix,
    # suffix). Pre-check for a clean 409 (the partial-unique index is the
    # authoritative guard, handled in the except).
    full_number = f"{prefix.code}-{payload.sku_suffix}"
    existing = await inv_repo.get_item_by_prefix_suffix(
        db, prefix_uuid, payload.sku_suffix
    )
    if existing is not None:
        raise ConflictError(
            f"item {full_number} is already in use",
            code="item_number_conflict",
        )

    try:
        item = await inv_repo.create_item(
            db,
            sku_suffix=payload.sku_suffix,
            description=payload.description,
            prefix_id=prefix_uuid,
            created_by_user_id=current.id,
            uom=payload.uom,
            is_consumable=payload.is_consumable,
            avg_lead_days=payload.avg_lead_days,
            reorder_threshold=payload.reorder_threshold,
            near_expiry_threshold_days=payload.near_expiry_threshold_days,
        )
    except IntegrityError as exc:
        # Race lost on the partial-unique index.
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_items_prefix_suffix" in msg:
            raise ConflictError(
                f"item {full_number} is already in use",
                code="item_number_conflict",
            ) from exc
        raise

    if supplier_uuids:
        await inv_repo.replace_item_suppliers(
            db,
            item_id=item.id,
            supplier_ids=supplier_uuids,
            created_by_user_id=current.id,
        )
        # ``item.suppliers`` was loaded empty at create; reload it (awaited) so
        # the response carries the just-assigned suppliers.
        await db.refresh(item, attribute_names=["suppliers"])

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

    ``supplier_ids``, when present, **replaces** the item's whole assigned-supplier
    list (each id is FK-validated, 404 on unknown). Omit it to leave suppliers
    unchanged; send ``[]`` to clear them.
    """
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    item = await inv_repo.get_item(db, item_id)
    if item is None or item.deleted_at is not None:
        raise NotFoundError(f"Item {item_id} not found")

    # Pull supplier_ids out of the scalar patch — it's a relationship, not a
    # column. ``None`` (omitted) leaves the list untouched.
    supplier_ids = patch.pop("supplier_ids", None)
    supplier_uuids: list[uuid.UUID] | None = None
    if supplier_ids is not None:
        supplier_uuids = await _resolve_item_supplier_ids(db, supplier_ids)

    # Re-assign prefix: validate the target prefix, derive its tier, and apply
    # the same guards as before against the derived tier's type. Changing the
    # prefix also updates ``tier_id`` so the composite FK stays consistent.
    if "prefix_id" in patch:
        prefix_uuid = _parse_uuid_or_422(
            str(patch["prefix_id"]), field="prefix_id"
        )
        target_prefix = await inv_repo.get_prefix(db, prefix_uuid)
        if target_prefix is None:
            raise NotFoundError(f"Prefix {patch['prefix_id']} not found")
        target_tier = await inv_repo.get_tier(db, target_prefix.tier_id)
        if target_tier is None:
            raise NotFoundError(f"Tier {target_prefix.tier_id} not found")
        if target_tier.type == "raw_material":
            # A built item with a BOM can't become a raw material (would orphan
            # its BOM).
            if item.id in await inv_repo.items_with_bom(db, [item.id]):
                raise ConflictError(
                    "Remove this item's bill of materials before moving it to "
                    "the raw-material tier",
                    code="bom_present",
                )
        elif target_tier.type in BUILT_TIER_TYPES:
            # A received (stocked) item can't become built — built items are
            # manufactured, not received.
            if await inv_repo.item_has_lots(db, item.id):
                raise ConflictError(
                    "This item has received stock (lots) and can't be changed "
                    "to a sub-assembly or finished-good tier. Built items are "
                    "manufactured, not received.",
                    code="item_received",
                )
        patch["prefix_id"] = prefix_uuid

    if not patch and supplier_uuids is None:
        raise ValidationError("No fields to update", code="empty_patch")

    before = inv_repo.item_to_audit_snapshot(item)

    if supplier_uuids is not None:
        await inv_repo.replace_item_suppliers(
            db,
            item_id=item.id,
            supplier_ids=supplier_uuids,
            created_by_user_id=current.id,
        )

    if patch:
        updated = await inv_repo.apply_item_patch(
            db,
            item=item,
            patch=patch,
            updated_by_user_id=current.id,
        )
    else:
        # Suppliers-only change — still bump the updater for the audit trail.
        item.updated_by_user_id = current.id
        await db.flush()
        updated = item

    if supplier_uuids is not None:
        # The eager ``suppliers`` collection was materialised for the
        # before-snapshot; reload it (awaited) so the after-snapshot / read
        # reflect the new list rather than the cached one.
        await db.refresh(updated, attribute_names=["suppliers"])

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

    response = await _item_read_with_valuation(db, updated)
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
        return await _item_read_with_valuation(db, item)

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
    response = await _item_read_with_valuation(db, deleted)
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
    "/number-available",
    response_model=LotNumberAvailability,
    summary="Is this lot number still free? (advisory pre-check)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def lot_number_available(
    db: DBSession,
    lot_number: Annotated[str, Query(min_length=1, max_length=128)],
) -> LotNumberAvailability:
    """Pre-flight for the operator-typed produced-batch lot number (kitting
    close-out). Uniqueness is global across live lots — the same rule
    ``_resolve_output_lot_number`` enforces at produce / close-out, which remains
    the authority; this only moves the feedback earlier.

    MUST stay declared above ``/{lot_id}`` — that route's path param is a UUID,
    so a later declaration would swallow this path and 422.
    """
    trimmed = lot_number.strip()
    if not trimmed:
        return LotNumberAvailability(lot_number=trimmed, available=False)
    taken = await inv_repo.lot_number_exists(db, lot_number=trimmed)
    return LotNumberAvailability(lot_number=trimmed, available=not taken)


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

    # Optional supplier — validate the UUID + existence ourselves so the
    # caller gets a clean 4xx instead of an FK violation.
    supplier_uuid: uuid.UUID | None = None
    if payload.supplier_id is not None:
        try:
            supplier_uuid = uuid.UUID(payload.supplier_id)
        except ValueError as exc:
            raise ValidationError(
                "supplier_id is not a valid UUID",
                code="invalid_supplier_id",
            ) from exc
        if (await inv_repo.get_supplier(db, supplier_uuid)) is None:
            raise NotFoundError(f"Supplier {payload.supplier_id} not found")

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
            supplier_id=supplier_uuid,
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

    Editable: status, dates, supplier, CoA URL, notes (``lot_number`` and
    the parent item are immutable identity). Every edit consumes a fresh
    reauth ticket minted for action='lot.update' and writes an audit row
    that links the signature (``signature_id``) and records the
    mandatory reason for change. The DB CHECK on date ordering is the
    authoritative guard; the route surfaces the structured
    ``lot_dates_inverted`` code if the operator inverts them.
    """
    patch = payload.model_dump(exclude_unset=True)
    # The signing fields ride on the same body but aren't lot columns —
    # pull them out before the patch touches the ORM row. ``evidence_id`` is
    # always present (required by the schema); ``reason`` is optional.
    evidence_str = patch.pop("evidence_id")
    # ``reason`` is optional (no e-sign requires a comment); default to None
    # when the operator signed without one.
    reason = patch.pop("reason", None)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    evidence_uuid = _parse_uuid_or_422(evidence_str, field="evidence_id")

    lot = await inv_repo.get_lot(db, lot_id)
    if lot is None or lot.deleted_at is not None:
        raise NotFoundError(f"Lot {lot_id} not found")

    # Quantity may be corrected post-receipt, but never below what is already
    # physically placed in locations — the operator must unplace first.
    new_qty: int | None = None
    if "ordered_qty" in patch:
        new_qty = patch["ordered_qty"]
        placed = int(await loc_repo.sum_active_alloc_qty_for_lot(db, lot.id))
        if new_qty < placed:
            raise ConflictError(
                f"This lot has {placed} unit(s) placed in location(s). Please "
                f"remove it from its location(s) first, or set the quantity to "
                f"at least {placed}.",
                code="qty_below_placed",
            )

    if "supplier_id" in patch:
        v = patch["supplier_id"]
        if v is None:
            patch["supplier_id"] = None
        elif isinstance(v, str):
            try:
                supplier_uuid = uuid.UUID(v)
            except ValueError as exc:
                raise ValidationError(
                    "supplier_id is not a valid UUID",
                    code="invalid_supplier_id",
                ) from exc
            if (await inv_repo.get_supplier(db, supplier_uuid)) is None:
                raise NotFoundError(f"Supplier {v} not found")
            # A lot's supplier must be one of its item's assigned suppliers —
            # same rule as intake / receive (no off-list suppliers).
            if supplier_uuid not in await inv_repo.item_supplier_ids(db, lot.item_id):
                raise ValidationError(
                    "Supplier is not one of this item's assigned suppliers; add it "
                    "to the item first",
                    code="supplier_not_assigned_to_item",
                )
            patch["supplier_id"] = supplier_uuid

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

    # A qty correction re-syncs the Order line's received total (the lot maps
    # one-to-one to a receive-event draw) and re-derives the Order status
    # (e.g. dropping below ordered flips received → partially_received).
    if new_qty is not None:
        event_line = await inv_repo.get_event_line_by_lot(db, updated.id)
        if event_line is not None:
            event_line.qty_received = new_qty
            await db.flush()
            if updated.receipt_transaction_id is not None:
                order = await inv_repo.get_order(db, updated.receipt_transaction_id)
                if order is not None:
                    recd = await inv_repo.received_qty_by_line(
                        db, [ln.id for ln in order.lines]
                    )
                    new_status = inv_repo.derive_order_status(
                        list(order.lines), recd
                    )
                    if new_status != order.status:
                        await inv_repo.set_order_status(
                            db,
                            txn=order,
                            status=new_status,
                            received_by_user_id=current.id,
                        )

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
# The two-step intake (ON_ORDER) → physical receipt (AVAILABLE, with
# splitting). Intake suppliers are restricted to the item's assigned suppliers
# (``meta.item_suppliers``). See docs/modules/receipt-admin.md.


def _order_to_read(
    txn: ReceiptTransaction, received: dict[uuid.UUID, int]
) -> ReceiptTransactionRead:
    """Serialise an Order (header + lines + events) with derived quantities.

    ``received`` maps each line id → its Σ received qty (from
    ``received_qty_by_line``).
    """
    lines_read: list[OrderLineRead] = []
    total_ordered = 0
    total_received = 0
    for line in txn.lines:
        recd = received.get(line.id, 0)
        outstanding = max(0, line.ordered_qty - recd)
        total_ordered += line.ordered_qty
        total_received += recd
        lines_read.append(
            OrderLineRead(
                id=str(line.id),
                line_no=line.line_no,
                item_id=str(line.item_id),
                item_number=line.item.item_number if line.item else None,
                item_description=line.item.description if line.item else None,
                supplier_id=str(line.supplier_id),
                supplier_name=line.supplier.name if line.supplier else None,
                ordered_qty=line.ordered_qty,
                unit_price_amount=line.unit_price_amount,
                received_qty=recd,
                outstanding_qty=outstanding,
            )
        )

    events_read: list[ReceiptEventRead] = []
    for ev in txn.events:
        ev_lines = [
            ReceiptEventLineRead(
                id=str(el.id),
                line_id=str(el.receipt_transaction_line_id),
                qty_received=el.qty_received,
                over_receipt_reason=el.over_receipt_reason,
                lot_id=str(el.lot_id),
                lot_number=el.lot.lot_number if el.lot else None,
            )
            for el in ev.lines
        ]
        events_read.append(
            ReceiptEventRead(
                id=str(ev.id),
                received_at=ev.received_at,
                received_by_user_id=str(ev.received_by_user_id),
                received_by_user_name=ev.received_by.full_name if ev.received_by else None,
                notes=ev.notes,
                created_at=ev.created_at,
                lines=ev_lines,
            )
        )

    return ReceiptTransactionRead(
        id=str(txn.id),
        po_reference=txn.po_reference,
        status=txn.status,  # type: ignore[arg-type]
        is_blanket=txn.is_blanket,
        valid_from=txn.valid_from,
        valid_to=txn.valid_to,
        notes=txn.notes,
        created_by_user_id=str(txn.created_by_user_id),
        received_by_user_id=(
            str(txn.received_by_user_id) if txn.received_by_user_id else None
        ),
        received_at=txn.received_at,
        created_at=txn.created_at,
        updated_at=txn.updated_at,
        lines=lines_read,
        events=events_read,
        total_ordered_qty=total_ordered,
        total_received_qty=total_received,
    )


async def _order_read(
    db: DBSession, txn: ReceiptTransaction
) -> ReceiptTransactionRead:
    """Compute received-by-line then serialise one Order."""
    received = await inv_repo.received_qty_by_line(
        db, [line.id for line in txn.lines]
    )
    return _order_to_read(txn, received)


async def _orders_read(
    db: DBSession, txns: list[ReceiptTransaction]
) -> list[ReceiptTransactionRead]:
    """Batch the received-by-line lookup across all listed Orders."""
    all_line_ids = [line.id for txn in txns for line in txn.lines]
    received = await inv_repo.received_qty_by_line(db, all_line_ids)
    return [_order_to_read(txn, received) for txn in txns]


async def _resolve_item_supplier(
    db: DBSession,
    *,
    item_id: uuid.UUID,
    supplier_id: str,
) -> Supplier:
    """Resolve a supplier that must be one of the item's assigned suppliers.

    Intake / receive can only use suppliers already on the item's list
    (``meta.item_suppliers``) — there is no on-the-fly supplier creation. 422s
    if the supplier isn't assigned to the item or is inactive.
    """
    supplier_uuid = _parse_uuid_or_422(supplier_id, field="supplier_id")
    if supplier_uuid not in await inv_repo.item_supplier_ids(db, item_id):
        raise ValidationError(
            "Supplier is not one of this item's assigned suppliers; add it to the "
            "item first",
            code="supplier_not_assigned_to_item",
        )
    supplier = await inv_repo.get_supplier(db, supplier_uuid)
    if supplier is None:
        raise NotFoundError(f"Supplier {supplier_id} not found")
    if not supplier.is_active:
        raise ValidationError(
            "Supplier is inactive; pick an active supplier",
            code="supplier_inactive",
        )
    return supplier


# ── Item suppliers (per item) ────────────────────────────────────────────


@items_router.get(
    "/{item_id}/suppliers",
    response_model=list[ItemSupplierRead],
    summary="List an item's assigned suppliers",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_suppliers(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
) -> list[ItemSupplierRead]:
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows = await inv_repo.list_item_suppliers(db, item_id)
    return [
        ItemSupplierRead(
            supplier_id=str(iv.supplier_id),
            supplier_name=iv.supplier.name if iv.supplier else "",
        )
        for iv in rows
    ]


# ── Orders (Receipt Admin v3 — intake / edit / receive / delete) ───────
#
# An "Order" (``app.receipt_transactions``) has one-or-more item lines and
# zero-or-more dated receive events. Lots are created at receive (one lot per
# line × event), never at intake. Suppliers per line are restricted to the
# item's assigned suppliers. See docs/modules/receipt-admin.md (v3).


async def _build_order_lines(
    db: DBSession,
    *,
    txn_id: uuid.UUID,
    lines_input: list,
    actor_user_id: uuid.UUID,
) -> list:
    """Resolve item + per-line supplier and insert the Order's lines (1-based
    ``line_no`` in payload order). Used by create + edit.
    """
    created = []
    for idx, line in enumerate(lines_input, start=1):
        item_uuid = _parse_uuid_or_422(line.item_id, field="item_id")
        item = await inv_repo.get_item(db, item_uuid)
        if item is None:
            raise NotFoundError(f"Item {line.item_id} not found")
        supplier = await _resolve_item_supplier(
            db, item_id=item_uuid, supplier_id=line.supplier_id
        )
        row = await inv_repo.add_order_line(
            db,
            txn_id=txn_id,
            line_no=idx,
            item_id=item_uuid,
            supplier_id=supplier.id,
            ordered_qty=line.ordered_qty,
            unit_price_amount=line.unit_price,
        )
        await record_entity_change(
            db,
            actor_user_id=actor_user_id,
            action="created",
            subject_table="app.receipt_transaction_lines",
            subject_id=row.id,
            subject_label=f"{item.item_number} × {line.ordered_qty}",
            before=None,
            after=inv_repo.order_line_to_audit_snapshot(row),
            context={"receipt_transaction_id": str(txn_id)},
        )
        created.append(row)
    return created


@receiving_router.get(
    "/transactions",
    response_model=ReceiptTransactionListResponse,
    summary="List Orders (newest first)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_orders(
    db: DBSession,
    status_filter: Annotated[
        Literal["open", "partially_received", "received", "cancelled"] | None,
        Query(alias="status", description="Filter by Order status"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReceiptTransactionListResponse:
    rows, total = await inv_repo.list_orders(
        db, status=status_filter, limit=limit, offset=offset
    )
    return ReceiptTransactionListResponse(
        items=await _orders_read(db, rows),
        total=total,
        limit=limit,
        offset=offset,
    )


@receiving_router.get(
    "/transactions/{txn_id}",
    response_model=ReceiptTransactionRead,
    summary="Get one Order (lines + receive events)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_order(
    db: DBSession,
    txn_id: Annotated[uuid.UUID, Path()],
) -> ReceiptTransactionRead:
    txn = await inv_repo.get_order(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Order {txn_id} not found")
    return await _order_read(db, txn)


@receiving_router.post(
    "/transactions",
    response_model=ReceiptTransactionRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create an Order — multi-item, no lots yet (Receipt Admin v3)",
    # Intake places an order; no stock moves yet, so it's the routine
    # ``create`` gate (the e-signed ``sign`` path is the physical receive).
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_order(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: OrderCreateRequest,
) -> ReceiptTransactionRead:
    """Create an Order header + its item lines. Atomic; no ledger movement
    (goods aren't in yet). The same item may appear on multiple lines."""
    if (
        payload.valid_from is not None
        and payload.valid_to is not None
        and payload.valid_to < payload.valid_from
    ):
        raise ValidationError(
            "valid_to must be on or after valid_from",
            code="invalid_valid_window",
        )
    try:
        txn = await inv_repo.create_order(
            db,
            created_by_user_id=current.id,
            po_reference=payload.po_reference,
            is_blanket=payload.is_blanket,
            valid_from=payload.valid_from,
            valid_to=payload.valid_to,
            notes=payload.notes,
        )
        await _build_order_lines(
            db,
            txn_id=txn.id,
            lines_input=payload.lines,
            actor_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_receipt_transactions_po_reference" in msg:
            raise ConflictError(
                f"Order number '{payload.po_reference}' is already in use",
                code="po_reference_conflict",
            ) from exc
        raise

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.receipt_transactions",
        subject_id=txn.id,
        subject_label=f"{payload.po_reference} ({len(payload.lines)} item(s))",
        before=None,
        after=inv_repo.order_to_audit_snapshot(txn),
    )

    refreshed = await inv_repo.get_order(db, txn.id)
    assert refreshed is not None
    response = await _order_read(db, refreshed)
    await db.commit()
    return response


@receiving_router.patch(
    "/transactions/{txn_id}",
    response_model=ReceiptTransactionRead,
    summary="Edit an un-received Order (header + lines). Not e-signed.",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_order(
    db: DBSession,
    current: CurrentDbUserDep,
    txn_id: Annotated[uuid.UUID, Path()],
    payload: OrderUpdateRequest,
) -> ReceiptTransactionRead:
    """Edit an Order while it is still ``open`` (no receive events). Header
    fields patch in place; ``lines``, when supplied, replaces the whole set."""
    txn = await inv_repo.get_order(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Order {txn_id} not found")
    if txn.status != "open":
        raise ValidationError(
            f"Order is '{txn.status}'; only un-received (open) Orders can be edited",
            code="order_not_editable",
        )

    before = inv_repo.order_to_audit_snapshot(txn)
    fields_set = payload.model_fields_set

    if "po_reference" in fields_set and payload.po_reference is not None:
        txn.po_reference = payload.po_reference
    if "is_blanket" in fields_set and payload.is_blanket is not None:
        txn.is_blanket = payload.is_blanket
    if "valid_from" in fields_set:
        txn.valid_from = payload.valid_from
    if "valid_to" in fields_set:
        txn.valid_to = payload.valid_to
    if "notes" in fields_set:
        txn.notes = payload.notes

    if (
        txn.valid_from is not None
        and txn.valid_to is not None
        and txn.valid_to < txn.valid_from
    ):
        raise ValidationError(
            "valid_to must be on or after valid_from",
            code="invalid_valid_window",
        )

    try:
        await db.flush()
        if "lines" in fields_set and payload.lines is not None:
            if len(payload.lines) == 0:
                raise ValidationError(
                    "An Order must have at least one line",
                    code="order_no_lines",
                )
            await inv_repo.delete_order_lines(db, txn_id=txn.id)
            await _build_order_lines(
                db,
                txn_id=txn.id,
                lines_input=payload.lines,
                actor_user_id=current.id,
            )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_receipt_transactions_po_reference" in msg:
            raise ConflictError(
                f"Order number '{txn.po_reference}' is already in use",
                code="po_reference_conflict",
            ) from exc
        raise

    refreshed = await inv_repo.get_order(db, txn.id)
    assert refreshed is not None
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.receipt_transactions",
        subject_id=txn.id,
        subject_label=refreshed.po_reference,
        before=before,
        after=inv_repo.order_to_audit_snapshot(refreshed),
    )
    response = await _order_read(db, refreshed)
    await db.commit()
    return response


@receiving_router.post(
    "/transactions/{txn_id}/delete",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete an un-received Order (e-signed)",
    # E-signed: a fresh reauth ticket for action='order.delete', consumed once.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_order(
    db: DBSession,
    current: CurrentDbUserDep,
    txn_id: Annotated[uuid.UUID, Path()],
    payload: OrderActionRequest,
) -> None:
    """Soft-delete an Order — only while it has no receive events (preserves
    the GxP ledger; received stock can never be orphaned). E-signed."""
    txn = await inv_repo.get_order(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Order {txn_id} not found")
    if txn.events:
        raise ValidationError(
            "Cannot delete an Order that has receive events",
            code="order_has_receipts",
        )
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    before = inv_repo.order_to_audit_snapshot(txn)
    await inv_repo.soft_delete_order(db, txn=txn, deleted_by_user_id=current.id)
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="order.delete",
        target_table="app.receipt_transactions",
        target_id=txn.id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.receipt_transactions",
        subject_id=txn.id,
        subject_label=txn.po_reference,
        before=before,
        after=inv_repo.order_to_audit_snapshot(txn),
        signature_id=evidence_uuid,
    )
    await db.commit()


@receiving_router.post(
    "/transactions/{txn_id}/cancel",
    response_model=ReceiptTransactionRead,
    summary="Cancel an un-received Order (keeps the record). E-signed.",
    # E-signed: a fresh reauth ticket for action='order.cancel', consumed once.
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def cancel_order(
    db: DBSession,
    current: CurrentDbUserDep,
    txn_id: Annotated[uuid.UUID, Path()],
    payload: OrderActionRequest,
) -> ReceiptTransactionRead:
    txn = await inv_repo.get_order(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Order {txn_id} not found")
    if txn.events:
        raise ValidationError(
            "Cannot cancel an Order that has receive events",
            code="order_has_receipts",
        )
    if txn.status == "cancelled":
        raise ValidationError("Order is already cancelled", code="order_cancelled")

    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    before = inv_repo.order_to_audit_snapshot(txn)
    await inv_repo.set_order_status(db, txn=txn, status="cancelled")
    refreshed = await inv_repo.get_order(db, txn.id)
    assert refreshed is not None
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="order.cancel",
        target_table="app.receipt_transactions",
        target_id=txn.id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.receipt_transactions",
        subject_id=txn.id,
        subject_label=f"{txn.po_reference} cancelled",
        before=before,
        after=inv_repo.order_to_audit_snapshot(refreshed),
        signature_id=evidence_uuid,
    )
    response = await _order_read(db, refreshed)
    await db.commit()
    return response


async def _place_received_lot(
    db: DBSession,
    *,
    lot: Lot,
    qty_received: int,
    placement: ReceivePlacement,
    evidence_uuid: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """Unit-IN the freshly-received lot into its chosen destination.

    Single destination, exactly ``qty_received`` units — one box (N distinct
    empty cells) or one free leaf (freezer sub-location / warehouse shelf, N
    units). Writes the allocations + a single ``+N`` receipt movement under the
    receive's e-signature (``evidence_uuid``). Caller commits.
    """
    node_uuid = _parse_uuid_or_422(placement.node_id, field="node_id")
    node = await loc_repo.get_node(db, node_uuid)
    if node is None:
        raise NotFoundError(f"Location node {placement.node_id} not found")
    if not node.is_active:
        raise ValidationError("Selected location is inactive", code="node_inactive")
    if not can_store(node.node_type):
        raise ValidationError(
            "Selected location can't hold stock — pick a box, freezer "
            "sub-location, or warehouse shelf",
            code="node_not_storable",
        )

    if is_grid_node(node.node_type):
        cells = placement.cells
        if len(cells) != qty_received:
            raise ValidationError(
                f"Select exactly {qty_received} cell(s) for the received quantity "
                f"(got {len(cells)})",
                code="placement_qty_mismatch",
            )
        if node.grid_rows is None or node.grid_cols is None:
            raise ValidationError("Box has no grid configured", code="box_grid_missing")
        for c in cells:
            if c.grid_row > node.grid_rows or c.grid_col > node.grid_cols:
                raise ValidationError(
                    f"Cell ({c.grid_row},{c.grid_col}) is outside the "
                    f"{node.grid_rows}×{node.grid_cols} grid",
                    code="cell_out_of_bounds",
                )
            occupant = await loc_repo.get_active_cell_occupant(
                db, node_id=node.id, grid_row=c.grid_row, grid_col=c.grid_col
            )
            if occupant is not None:
                raise ConflictError(
                    f"Cell ({c.grid_row},{c.grid_col}) is already occupied",
                    code="cell_occupied",
                )
        for c in cells:
            await loc_repo.create_allocation(
                db,
                lot_id=lot.id,
                location_node_id=node.id,
                qty=Decimal("1"),
                grid_row=c.grid_row,
                grid_col=c.grid_col,
                created_by_user_id=user_id,
            )
    else:
        # Free-storage leaf (freezer sub-location / warehouse shelf) — all N units.
        if placement.cells:
            raise ValidationError(
                "This location has no grid; don't send cells", code="cells_not_allowed"
            )
        await loc_repo.create_allocation(
            db,
            lot_id=lot.id,
            location_node_id=node.id,
            qty=Decimal(qty_received),
            created_by_user_id=user_id,
        )

    # One +N receipt movement for the whole placement (on-hand becomes derived).
    await loc_repo.create_node_receipt_movement(
        db,
        item_id=lot.item_id,
        lot_id=lot.id,
        to_location_node_id=node.id,
        qty=Decimal(qty_received),
        performed_by_user_id=user_id,
        reauth_evidence_id=evidence_uuid,
    )


@receiving_router.post(
    "/transactions/{txn_id}/receive",
    response_model=ReceiptTransactionRead,
    status_code=status.HTTP_201_CREATED,
    summary="Record a dated receive event (partial / blanket). E-signed.",
    # Creates lots, so it's GxP-significant: ``sign`` permission + a fresh
    # reauth ticket for action='receipt.confirm' (consumed once vs the Order).
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def receive_order(
    db: DBSession,
    current: CurrentDbUserDep,
    txn_id: Annotated[uuid.UUID, Path()],
    payload: ReceiveEventRequest,
) -> ReceiptTransactionRead:
    """One dated receive event: per submitted line, create one ``available``
    lot (lot number + dates entered now) and a ``receipt_event_lines`` draw.
    No ledger movement — quantity flows through the Location System ``place``
    (unit-IN). One e-signature covers the whole event; commits atomically.
    Recomputes the Order status (open → partially_received → received)."""
    txn = await inv_repo.get_order(db, txn_id)
    if txn is None:
        raise NotFoundError(f"Order {txn_id} not found")
    if txn.status not in ("open", "partially_received"):
        raise ValidationError(
            f"Order is '{txn.status}'; only open / partially_received Orders "
            "can be received",
            code="order_not_receivable",
        )

    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    lines_by_id = {line.id: line for line in txn.lines}

    event = await inv_repo.create_receipt_event(
        db,
        txn_id=txn.id,
        received_at=payload.received_at,
        received_by_user_id=current.id,
        reauth_event_id=evidence_uuid,
        notes=payload.notes,
    )

    seen_lines: set[uuid.UUID] = set()
    seen_lot_numbers: set[tuple[uuid.UUID, str]] = set()

    for line_in in payload.lines:
        line_uuid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        line = lines_by_id.get(line_uuid)
        if line is None:
            raise ValidationError(
                f"Line {line_in.line_id} is not part of this Order",
                code="line_not_in_order",
            )
        if line_uuid in seen_lines:
            raise ValidationError(
                f"Line {line_in.line_id} appears more than once in this receive",
                code="duplicate_line_in_receive",
            )
        seen_lines.add(line_uuid)

        # Over-receipt (qty > the line's outstanding) is allowed with no reason.

        # Lot number is unique per item (within this request + against the DB).
        lot_key = (line.item_id, line_in.lot_number.strip().lower())
        if lot_key in seen_lot_numbers:
            raise ValidationError(
                f"Duplicate lot_number '{line_in.lot_number}' for the same item "
                "in this receive",
                code="duplicate_lot_number_in_request",
            )
        seen_lot_numbers.add(lot_key)
        if (
            await inv_repo.get_lot_by_item_and_number(
                db, item_id=line.item_id, lot_number=line_in.lot_number
            )
        ) is not None:
            raise ConflictError(
                f"lot_number '{line_in.lot_number}' already exists for this item",
                code="lot_number_conflict",
            )

        try:
            lot = await inv_repo.create_lot(
                db,
                item_id=line.item_id,
                lot_number=line_in.lot_number,
                created_by_user_id=current.id,
                supplier_id=line.supplier_id,
                manufacture_date=line_in.manufacture_date,
                expiration_date=line_in.expiration_date,
                status="available",
                unit_price_amount=(
                    line_in.unit_price_amount
                    if line_in.unit_price_amount is not None
                    else line.unit_price_amount
                ),
                po_reference=txn.po_reference,
                # Lot holds the units that arrived in this draw (caps placement).
                ordered_qty=line_in.qty_received,
                receipt_transaction_id=txn.id,
                receipt_transaction_line_id=line.id,
            )
        except IntegrityError as exc:
            await db.rollback()
            msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
            if "uq_lots_item_lot_number" in msg:
                raise ConflictError(
                    f"lot_number '{line_in.lot_number}' already exists for this item",
                    code="lot_number_conflict",
                ) from exc
            if "ck_lots_dates_ordered" in msg:
                raise ValidationError(
                    "expiration_date must be on or after manufacture_date",
                    code="lot_dates_inverted",
                ) from exc
            raise

        await inv_repo.add_receipt_event_line(
            db,
            event_id=event.id,
            line_id=line.id,
            qty_received=line_in.qty_received,
            lot_id=lot.id,
            over_receipt_reason=None,
        )
        # Unit-IN the received units into their chosen destination, under this
        # same receive signature (atomic; unit-in happens only here).
        await _place_received_lot(
            db,
            lot=lot,
            qty_received=line_in.qty_received,
            placement=line_in.placement,
            evidence_uuid=evidence_uuid,
            user_id=current.id,
        )
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
                "receipt_event_id": str(event.id),
                "receipt_transaction_id": str(txn.id),
                "receipt_transaction_line_id": str(line.id),
            },
            signature_id=evidence_uuid,
        )

    # One e-signature for the whole event, consumed against the Order.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="receipt.confirm",
        target_table="app.receipt_transactions",
        target_id=txn.id,
    )

    # Recompute the Order status from the new fulfilment picture.
    received_after = await inv_repo.received_qty_by_line(db, list(lines_by_id))
    new_status = inv_repo.derive_order_status(list(txn.lines), received_after)
    status_before = txn.status
    await inv_repo.set_order_status(
        db, txn=txn, status=new_status, received_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.receipt_events",
        subject_id=event.id,
        subject_label=f"receive {payload.received_at.isoformat()}",
        before={"status": status_before},
        after={
            "received_at": payload.received_at.isoformat(),
            "status": new_status,
            "lines_received": len(payload.lines),
        },
        signature_id=evidence_uuid,
    )

    refreshed = await inv_repo.get_order(db, txn.id)
    assert refreshed is not None
    response = await _order_read(db, refreshed)
    await db.commit()
    return response
