"""Location system routes — hierarchy engine, flat locations, allocations.

Strict validation (Requirements v2 §4.1): the LN2 parent-type rules are
enforced here on every create; only ``box`` (the grid-bearing leaf) and
``flat`` nodes can hold lots; a Box cell is single-occupancy (override-gated);
deletion is blocked when a node has children, active lots, or ledger history.

Quantity-changing allocation ops go to the GxP ledger (``app.stock_movements``):
``consume`` posts a dispense/discard and ``transfer`` a transfer pair — both
e-signed. ``place`` is quantity-neutral (the unit already exists from receipt),
so it only writes an allocation + an audit-trail entry.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.locations import repository as loc_repo
from app.locations.schemas import (
    AllocationRead,
    ConsumeRequest,
    DedicationUpdateRequest,
    GridUpdateRequest,
    NodeCreate,
    NodeMovementRead,
    NodeRead,
    NodeTreeRead,
    PlaceRequest,
    TransferRequest,
)
from app.models.inventory import StockMovement
from app.models.locations import (
    PARENT_OF,
    LocationNode,
    LotAllocation,
    can_store,
    is_grid_node,
)
from app.security.permissions import RequirePermission, has_permission

nodes_router = APIRouter(prefix="/location-nodes", tags=["locations"])
alloc_router = APIRouter(prefix="/allocations", tags=["locations"])


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"{field} is not a valid UUID", code=f"invalid_{field}"
        ) from exc


# ── Serialisers ─────────────────────────────────────────────────────────


def _node_to_read(
    node: LocationNode,
    *,
    child_count: int = 0,
    alloc_count: int = 0,
    inherited_customer_id: uuid.UUID | None = None,
    inherited_product_id: uuid.UUID | None = None,
) -> NodeRead:
    return NodeRead(
        id=str(node.id),
        parent_id=str(node.parent_id) if node.parent_id else None,
        node_type=node.node_type,  # type: ignore[arg-type]
        flat_category=node.flat_category,  # type: ignore[arg-type]
        code=node.code,
        name=node.name,
        is_active=node.is_active,
        notes=node.notes,
        grid_rows=node.grid_rows,
        grid_cols=node.grid_cols,
        dedicated_customer_id=(
            str(node.dedicated_customer_id) if node.dedicated_customer_id else None
        ),
        dedicated_product_id=(
            str(node.dedicated_product_id) if node.dedicated_product_id else None
        ),
        inherited_customer_id=(
            str(inherited_customer_id) if inherited_customer_id else None
        ),
        inherited_product_id=(
            str(inherited_product_id) if inherited_product_id else None
        ),
        can_store=can_store(node.node_type),
        child_count=child_count,
        active_allocation_count=alloc_count,
        created_at=node.created_at,
        updated_at=node.updated_at,
    )


def _alloc_to_read(a: LotAllocation) -> AllocationRead:
    return AllocationRead(
        id=str(a.id),
        lot_id=str(a.lot_id),
        lot_number=a.lot.lot_number if a.lot else None,
        item_number=a.lot.item.item_number if a.lot and a.lot.item else None,
        location_node_id=str(a.location_node_id),
        location_name=a.location_node.name if a.location_node else None,
        location_node_type=a.location_node.node_type if a.location_node else None,  # type: ignore[arg-type]
        grid_row=a.grid_row,
        grid_col=a.grid_col,
        qty=a.qty,
        is_active=a.is_active,
        created_at=a.created_at,
    )


def _ledger_to_read(m: StockMovement) -> NodeMovementRead:
    return NodeMovementRead(
        id=str(m.id),
        lot_id=str(m.lot_id) if m.lot_id else None,
        lot_number=m.lot.lot_number if m.lot else None,
        item_number=m.item.item_number if m.item else None,
        movement_type=m.movement_type,  # type: ignore[arg-type]
        from_location_node_id=(
            str(m.from_location_node_id) if m.from_location_node_id else None
        ),
        to_location_node_id=(
            str(m.to_location_node_id) if m.to_location_node_id else None
        ),
        qty_delta=m.qty_delta,
        notes=m.notes,
        performed_by_user_id=str(m.performed_by_user_id),
        performed_at=m.performed_at,
    )


def _build_tree(nodes: list[LocationNode]) -> list[NodeTreeRead]:
    """Nest a flat node list into trees keyed by parent_id (roots returned).

    Dedication is resolved by walking each node up to its quadrant within the
    same flat list (no extra queries).
    """
    by_id: dict[uuid.UUID, LocationNode] = {n.id: n for n in nodes}
    by_parent: dict[uuid.UUID | None, list[LocationNode]] = {}
    for n in nodes:
        by_parent.setdefault(n.parent_id, []).append(n)

    def inherited(node: LocationNode) -> tuple[uuid.UUID | None, uuid.UUID | None]:
        cur: LocationNode | None = node
        seen: set[uuid.UUID] = set()
        while cur is not None and cur.id not in seen:
            if cur.dedicated_customer_id or cur.dedicated_product_id:
                return cur.dedicated_customer_id, cur.dedicated_product_id
            seen.add(cur.id)
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        return None, None

    def build(node: LocationNode) -> NodeTreeRead:
        kids = by_parent.get(node.id, [])
        cust, prod = inherited(node)
        base = _node_to_read(
            node,
            child_count=len(kids),
            inherited_customer_id=cust,
            inherited_product_id=prod,
        )
        return NodeTreeRead(**base.model_dump(), children=[build(k) for k in kids])

    roots = by_parent.get(None, [])
    return [build(r) for r in roots]


# ── Node reads ──────────────────────────────────────────────────────────


@nodes_router.get(
    "/ln2-tree",
    response_model=list[NodeTreeRead],
    summary="LN2 hierarchy as nested trees (tank_quadrant → … → box)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_ln2_tree(
    db: DBSession,
    active_only: Annotated[bool, Query()] = True,
) -> list[NodeTreeRead]:
    from app.models.locations import LN2_LEVELS

    nodes = await loc_repo.list_nodes_by_types(db, LN2_LEVELS, active_only=active_only)
    return _build_tree(nodes)


@nodes_router.get(
    "/flat",
    response_model=list[NodeRead],
    summary="Flat operational locations (Kanban / Lab / QC / …)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_flat_locations(
    db: DBSession,
    flat_category: Annotated[str | None, Query()] = None,
    active_only: Annotated[bool, Query()] = True,
) -> list[NodeRead]:
    rows = await loc_repo.list_flat(
        db, flat_category=flat_category, active_only=active_only
    )
    return [_node_to_read(n) for n in rows]


@nodes_router.get(
    "/storage-targets",
    response_model=list[NodeRead],
    summary="All nodes that can hold a lot (boxes + flat) — for placement",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_storage_targets(db: DBSession) -> list[NodeRead]:
    rows = await loc_repo.list_nodes_by_types(db, ("box", "flat"), active_only=True)
    return [_node_to_read(n) for n in rows]


@nodes_router.get(
    "/{node_id}",
    response_model=NodeRead,
    summary="Get one node",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_node(
    db: DBSession,
    node_id: Annotated[uuid.UUID, Path()],
) -> NodeRead:
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    children = await loc_repo.count_children(db, node_id)
    allocs = await loc_repo.count_active_allocations(db, node_id)
    cust, prod = await loc_repo.resolve_inherited_dedication(db, node)
    return _node_to_read(
        node,
        child_count=children,
        alloc_count=allocs,
        inherited_customer_id=cust,
        inherited_product_id=prod,
    )


@nodes_router.get(
    "/{node_id}/children",
    response_model=list[NodeRead],
    summary="Direct children of a node",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_node_children(
    db: DBSession,
    node_id: Annotated[uuid.UUID, Path()],
    active_only: Annotated[bool, Query()] = True,
) -> list[NodeRead]:
    if (await loc_repo.get_node(db, node_id)) is None:
        raise NotFoundError(f"Location node {node_id} not found")
    rows = await loc_repo.list_children(db, node_id, active_only=active_only)
    return [_node_to_read(n) for n in rows]


@nodes_router.get(
    "/{node_id}/allocations",
    response_model=list[AllocationRead],
    summary="Active lot allocations stored at a node (a Box's cells)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_node_allocations(
    db: DBSession,
    node_id: Annotated[uuid.UUID, Path()],
) -> list[AllocationRead]:
    if (await loc_repo.get_node(db, node_id)) is None:
        raise NotFoundError(f"Location node {node_id} not found")
    rows = await loc_repo.active_allocations_at_node(db, node_id)
    return [_alloc_to_read(a) for a in rows]


# ── Node create / delete (strict hierarchy engine) ──────────────────────


@nodes_router.post(
    "",
    response_model=NodeRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a location node (strict parent-type validation)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_node(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: NodeCreate,
) -> NodeRead:
    node_type = payload.node_type
    required_parents = PARENT_OF[node_type]

    # ── Strict hierarchy validation — fail fast, never auto-correct (§4.1) ──
    parent_uuid: uuid.UUID | None = None
    parent: LocationNode | None = None
    if required_parents is None:
        # Roots: tank_quadrant / flat must have no parent.
        if payload.parent_id is not None:
            raise ValidationError(
                f"A '{node_type}' is a root and must not have a parent",
                code="invalid_hierarchy",
            )
        if node_type == "flat" and payload.flat_category is None:
            raise ValidationError(
                "A flat location requires a flat_category",
                code="flat_category_required",
            )
        if node_type != "flat" and payload.flat_category is not None:
            raise ValidationError(
                "flat_category is only valid for flat locations",
                code="invalid_flat_category",
            )
    else:
        if payload.flat_category is not None:
            raise ValidationError(
                "flat_category is only valid for flat locations",
                code="invalid_flat_category",
            )
        if payload.parent_id is None:
            allowed = " or ".join(f"'{p}'" for p in required_parents)
            raise ValidationError(
                f"A '{node_type}' requires a parent of type {allowed}",
                code="parent_required",
            )
        parent_uuid = _parse_uuid(payload.parent_id, field="parent_id")
        parent = await loc_repo.get_node(db, parent_uuid)
        if parent is None:
            raise NotFoundError(f"Parent node {payload.parent_id} not found")
        if not parent.is_active:
            raise ValidationError(
                "Parent node is inactive", code="parent_inactive"
            )
        if parent.node_type not in required_parents:
            allowed = " or ".join(f"'{p}'" for p in required_parents)
            raise ValidationError(
                f"A '{node_type}' must hang under {allowed}, "
                f"not a '{parent.node_type}'",
                code="invalid_parent_type",
            )

    # ── Grid dimensions — only on a Box; cassette boxes are single-column ──
    grid_rows: int | None = None
    grid_cols: int | None = None
    if is_grid_node(node_type):
        if payload.grid_rows is None or payload.grid_cols is None:
            raise ValidationError(
                "A box requires grid_rows and grid_cols", code="grid_required"
            )
        grid_rows, grid_cols = payload.grid_rows, payload.grid_cols
        if parent is not None and parent.node_type == "cassette" and grid_cols != 1:
            raise ValidationError(
                "A box under a cassette is single-column (grid_cols must be 1)",
                code="cassette_box_single_column",
            )
    elif payload.grid_rows is not None or payload.grid_cols is not None:
        raise ValidationError(
            "grid_rows / grid_cols are only valid for a box", code="grid_not_allowed"
        )

    # ── Quadrant dedication (advisory, customer XOR product) ──────────────
    ded_customer, ded_product = await _resolve_dedication_input(
        db,
        node_type=node_type,
        customer_id=payload.dedicated_customer_id,
        product_id=payload.dedicated_product_id,
    )

    # Sibling code uniqueness (covers the root case the unique index can't).
    if (
        await loc_repo.get_sibling_by_code(
            db, parent_id=parent_uuid, code=payload.code
        )
    ) is not None:
        raise ConflictError(
            f"A sibling with code '{payload.code}' already exists here",
            code="node_code_conflict",
        )

    node = await loc_repo.create_node(
        db,
        node_type=node_type,
        code=payload.code,
        name=payload.name,
        created_by_user_id=current.id,
        parent_id=parent_uuid,
        flat_category=payload.flat_category,
        grid_rows=grid_rows,
        grid_cols=grid_cols,
        dedicated_customer_id=ded_customer,
        dedicated_product_id=ded_product,
        notes=payload.notes,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="meta.location_nodes",
        subject_id=node.id,
        subject_label=f"{node.node_type}:{node.code}",
        before=None,
        after=loc_repo.node_to_audit_snapshot(node),
    )
    response = _node_to_read(node)
    await db.commit()
    return response


async def _resolve_dedication_input(
    db: DBSession,
    *,
    node_type: str,
    customer_id: str | None,
    product_id: str | None,
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """Validate a customer/product dedication pair for a quadrant."""
    if customer_id is None and product_id is None:
        return None, None
    if node_type != "tank_quadrant":
        raise ValidationError(
            "Only a tank_quadrant can be dedicated to a customer or product",
            code="dedication_not_a_quadrant",
        )
    if customer_id is not None and product_id is not None:
        raise ValidationError(
            "A quadrant may be dedicated to a customer OR a product, not both",
            code="dedication_not_exclusive",
        )
    if customer_id is not None:
        cust_uuid = _parse_uuid(customer_id, field="dedicated_customer_id")
        if not await loc_repo.customer_exists(db, cust_uuid):
            raise NotFoundError(f"Customer {customer_id} not found")
        return cust_uuid, None
    prod_uuid = _parse_uuid(product_id, field="dedicated_product_id")  # type: ignore[arg-type]
    if not await loc_repo.product_exists(db, prod_uuid):
        raise NotFoundError(f"Product {product_id} not found")
    return None, prod_uuid


@nodes_router.put(
    "/{node_id}/grid",
    response_model=NodeRead,
    summary="Resize a Box's grid (blocked below the highest occupied cell)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_node_grid(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
    payload: GridUpdateRequest,
) -> NodeRead:
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    if not is_grid_node(node.node_type):
        raise ValidationError(
            "Only a box has a resizable grid", code="grid_not_allowed"
        )
    # A box under a cassette stays single-column.
    if node.parent_id is not None:
        parent = await loc_repo.get_node(db, node.parent_id)
        if parent is not None and parent.node_type == "cassette" and payload.grid_cols != 1:
            raise ValidationError(
                "A box under a cassette is single-column (grid_cols must be 1)",
                code="cassette_box_single_column",
            )
    max_row, max_col = await loc_repo.max_occupied_cell(db, node_id)
    if payload.grid_rows < max_row or payload.grid_cols < max_col:
        raise ConflictError(
            f"Cannot shrink below the occupied area ({max_row}×{max_col})",
            code="grid_shrink_orphans_cells",
        )
    before = loc_repo.node_to_audit_snapshot(node)
    updated = await loc_repo.update_node_grid(
        db, node=node, grid_rows=payload.grid_rows, grid_cols=payload.grid_cols
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.location_nodes",
        subject_id=updated.id,
        subject_label=f"{updated.node_type}:{updated.code}",
        before=before,
        after=loc_repo.node_to_audit_snapshot(updated),
    )
    response = _node_to_read(updated)
    await db.commit()
    return response


@nodes_router.put(
    "/{node_id}/dedication",
    response_model=NodeRead,
    summary="Set / clear a quadrant's customer or product dedication",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_node_dedication(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
    payload: DedicationUpdateRequest,
) -> NodeRead:
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    ded_customer, ded_product = await _resolve_dedication_input(
        db,
        node_type=node.node_type,
        customer_id=payload.dedicated_customer_id,
        product_id=payload.dedicated_product_id,
    )
    before = loc_repo.node_to_audit_snapshot(node)
    updated = await loc_repo.update_node_dedication(
        db, node=node, customer_id=ded_customer, product_id=ded_product
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.location_nodes",
        subject_id=updated.id,
        subject_label=f"{updated.node_type}:{updated.code}",
        before=before,
        after=loc_repo.node_to_audit_snapshot(updated),
    )
    response = _node_to_read(updated)
    await db.commit()
    return response


@nodes_router.delete(
    "/{node_id}",
    response_model=NodeRead,
    summary="Soft-delete a node (blocked if it has children / lots / history)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_node(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
) -> NodeRead:
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    if not node.is_active:
        return _node_to_read(node)

    # Block rules (§4.1) — strict, no cascade.
    if await loc_repo.node_has_children(db, node_id):
        raise ValidationError(
            "Cannot delete a node that has child nodes", code="node_has_children"
        )
    if await loc_repo.node_has_any_allocations(db, node_id):
        raise ValidationError(
            "Cannot delete a node that holds active lots", code="node_has_active_lots"
        )
    if await loc_repo.node_has_movement_history(db, node_id):
        raise ValidationError(
            "Cannot delete a node with ledger history", code="node_has_history"
        )

    before = loc_repo.node_to_audit_snapshot(node)
    updated = await loc_repo.soft_delete_node(db, node=node)
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="meta.location_nodes",
        subject_id=updated.id,
        subject_label=f"{updated.node_type}:{updated.code}",
        before=before,
        after=loc_repo.node_to_audit_snapshot(updated),
    )
    response = _node_to_read(updated)
    await db.commit()
    return response


# ── Allocation operations (place / transfer / consume) ──────────────────


async def _resolve_storage_node(db: DBSession, node_id: str) -> LocationNode:
    node_uuid = _parse_uuid(node_id, field="node_id")
    node = await loc_repo.get_node(db, node_uuid)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    if not node.is_active:
        raise ValidationError("Location node is inactive", code="node_inactive")
    if not can_store(node.node_type):
        raise ValidationError(
            f"A '{node.node_type}' cannot store lots — only boxes and "
            "flat locations can",
            code="node_not_storable",
        )
    return node


async def _validate_cell_target(
    db: DBSession,
    *,
    node: LocationNode,
    grid_row: int | None,
    grid_col: int | None,
    qty: Decimal,
    override: bool,
    role: str,
) -> None:
    """Validate a placement/transfer target: cell bounds, single-occupancy,
    and one-unit-per-cell for grid (box) nodes; coordinates absent for flat.
    """
    if not is_grid_node(node.node_type):
        # Flat node — no grid.
        if grid_row is not None or grid_col is not None:
            raise ValidationError(
                "A flat location has no grid; omit grid_row / grid_col",
                code="cell_not_allowed",
            )
        return

    # Box (grid) node — cell required, bounded, single-unit, single-occupancy.
    if grid_row is None or grid_col is None:
        raise ValidationError(
            "A box placement requires grid_row and grid_col",
            code="cell_required",
        )
    if node.grid_rows is None or node.grid_cols is None:
        raise ValidationError("Box has no grid configured", code="box_grid_missing")
    if grid_row > node.grid_rows or grid_col > node.grid_cols:
        raise ValidationError(
            f"Cell ({grid_row},{grid_col}) is outside the "
            f"{node.grid_rows}×{node.grid_cols} grid",
            code="cell_out_of_bounds",
        )
    if qty != Decimal("1"):
        raise ValidationError(
            "A box cell holds exactly one unit (qty must be 1)",
            code="cell_qty_not_one",
        )
    occupant = await loc_repo.get_active_cell_occupant(
        db, node_id=node.id, grid_row=grid_row, grid_col=grid_col
    )
    if occupant is not None:
        if not override:
            raise ConflictError(
                f"Cell ({grid_row},{grid_col}) is already occupied",
                code="cell_occupied",
            )
        if not has_permission(role, "inventory", "sign"):
            raise ValidationError(
                "Overriding an occupied cell requires elevated permission",
                code="override_not_permitted",
            )


@alloc_router.post(
    "/place",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Place a lot into a node cell — the unit-IN (§3, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def place_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: PlaceRequest,
) -> AllocationRead:
    lot_uuid = _parse_uuid(payload.lot_id, field="lot_id")
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")

    node = await _resolve_storage_node(db, payload.node_id)
    await _validate_cell_target(
        db,
        node=node,
        grid_row=payload.grid_row,
        grid_col=payload.grid_col,
        qty=payload.qty,
        override=payload.override,
        role=current.role,
    )

    # Capacity: total placed for a lot may not exceed its ordered_qty (when set).
    # Placing IS the unit-in, so on-hand is created here, not checked against.
    if lot.ordered_qty is not None:
        already = await loc_repo.sum_active_alloc_qty_for_lot(db, lot_uuid)
        if already + payload.qty > lot.ordered_qty:
            raise ValidationError(
                f"Placing {payload.qty} would exceed the lot's ordered "
                f"{lot.ordered_qty} (already placed {already})",
                code="place_exceeds_ordered",
            )

    alloc = await loc_repo.create_allocation(
        db,
        lot_id=lot_uuid,
        location_node_id=node.id,
        qty=payload.qty,
        grid_row=payload.grid_row,
        grid_col=payload.grid_col,
        created_by_user_id=current.id,
        notes=payload.notes,
    )
    # Unit-IN: post a +qty receipt to the GxP ledger so on-hand reflects it.
    movement = await loc_repo.create_node_receipt_movement(
        db,
        item_id=lot.item_id,
        lot_id=lot_uuid,
        to_location_node_id=node.id,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        notes=payload.notes,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.receipt",
        target_table="app.stock_movements",
        target_id=movement.id,
    )
    response = _alloc_to_read(alloc)
    await db.commit()
    return response


@alloc_router.post(
    "/transfer",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Transfer a unit from one allocation to another cell (§3, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def transfer_allocation(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferRequest,
) -> AllocationRead:
    alloc_uuid = _parse_uuid(payload.allocation_id, field="allocation_id")
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    alloc = await loc_repo.get_allocation(db, alloc_uuid)
    if alloc is None or not alloc.is_active:
        raise NotFoundError(f"Active allocation {payload.allocation_id} not found")

    to_node = await _resolve_storage_node(db, payload.to_node_id)
    if to_node.id == alloc.location_node_id and (
        payload.to_grid_row == alloc.grid_row
        and payload.to_grid_col == alloc.grid_col
    ):
        raise ValidationError(
            "Source and destination cell are the same",
            code="transfer_same_cell",
        )
    if payload.qty > alloc.qty:
        raise ValidationError(
            f"Requested {payload.qty} exceeds allocated {alloc.qty}",
            code="transfer_exceeds_allocation",
        )
    await _validate_cell_target(
        db,
        node=to_node,
        grid_row=payload.to_grid_row,
        grid_col=payload.to_grid_col,
        qty=payload.qty,
        override=payload.override,
        role=current.role,
    )

    from_node_id = alloc.location_node_id
    lot_id = alloc.lot_id
    item_id = alloc.lot.item_id
    await loc_repo.reduce_allocation(db, allocation=alloc, qty=payload.qty)
    dest = await loc_repo.create_allocation(
        db,
        lot_id=lot_id,
        location_node_id=to_node.id,
        qty=payload.qty,
        grid_row=payload.to_grid_row,
        grid_col=payload.to_grid_col,
        created_by_user_id=current.id,
        notes=payload.notes,
    )
    out_leg, _in_leg = await loc_repo.create_node_transfer_pair(
        db,
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_node_id,
        to_location_node_id=to_node.id,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        notes=payload.notes,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.transfer",
        target_table="app.stock_movements",
        target_id=out_leg.id,
    )
    response = _alloc_to_read(dest)
    await db.commit()
    return response


@alloc_router.post(
    "/consume",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Consume a unit out of an allocation (location → OUT, §3, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def consume_allocation(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ConsumeRequest,
) -> AllocationRead:
    alloc_uuid = _parse_uuid(payload.allocation_id, field="allocation_id")
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    alloc = await loc_repo.get_allocation(db, alloc_uuid)
    if alloc is None or not alloc.is_active:
        raise NotFoundError(f"Active allocation {payload.allocation_id} not found")
    if payload.qty > alloc.qty:
        raise ValidationError(
            f"Requested {payload.qty} exceeds allocated {alloc.qty}",
            code="consume_exceeds_allocation",
        )

    # Consume records the Flat location that used the unit (where it went).
    to_node = await _resolve_storage_node(db, payload.to_node_id)
    if to_node.node_type != "flat":
        raise ValidationError(
            "Consume must target a flat location (lab / Kanban / Materials)",
            code="consume_target_not_flat",
        )

    from_node_id = alloc.location_node_id
    lot_id = alloc.lot_id
    item_id = alloc.lot.item_id
    updated = await loc_repo.reduce_allocation(db, allocation=alloc, qty=payload.qty)
    movement = await loc_repo.create_node_dispense_movement(
        db,
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_node_id,
        to_location_node_id=to_node.id,
        qty=payload.qty,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        notes=payload.notes,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.dispense",
        target_table="app.stock_movements",
        target_id=movement.id,
    )
    response = _alloc_to_read(updated)
    await db.commit()
    return response


@alloc_router.get(
    "/by-lot/{lot_id}",
    response_model=list[AllocationRead],
    summary="Active allocations for a lot (where it's stored, incl. splits)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_lot_allocations(
    db: DBSession,
    lot_id: Annotated[uuid.UUID, Path()],
    active_only: Annotated[bool, Query()] = True,
) -> list[AllocationRead]:
    rows = await loc_repo.list_lot_allocations(db, lot_id, active_only=active_only)
    return [_alloc_to_read(a) for a in rows]


@alloc_router.get(
    "/movements",
    response_model=list[NodeMovementRead],
    summary="Ledger movements touching a node or lot (click-through history)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_node_movements(
    db: DBSession,
    lot_id: Annotated[uuid.UUID | None, Query()] = None,
    node_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[NodeMovementRead]:
    rows = await loc_repo.list_node_ledger(
        db, lot_id=lot_id, node_id=node_id, limit=limit, offset=offset
    )
    return [_ledger_to_read(m) for m in rows]
