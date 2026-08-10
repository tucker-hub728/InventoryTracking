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
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from app.inventory import repository as inv_repo
from app.kitting import repository as kit_repo
from app.locations import repository as loc_repo
from app.locations.schemas import (
    AllocationRead,
    BatchCell,
    ConsumeBatchRequest,
    ConsumeRequest,
    DedicationUpdateRequest,
    GridUpdateRequest,
    KanbanCreate,
    LotAvailabilityRead,
    NodeCreate,
    NodeMovementRead,
    NodeMoveRequest,
    NodeRead,
    NodeTreeRead,
    NodeUpdateRequest,
    PlaceBatchRequest,
    PlaceRequest,
    ProductionAreaCreate,
    TransferBatchRequest,
    TransferMultiRequest,
    TransferRequest,
)
from app.models.inventory import StockMovement
from app.models.locations import (
    MAX_QUADRANTS_PER_TANK,
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
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


# ── Serialisers ─────────────────────────────────────────────────────────


def _node_to_read(
    node: LocationNode,
    *,
    child_count: int = 0,
    alloc_count: int = 0,
    inherited_customer_id: uuid.UUID | None = None,
    inherited_product_id: uuid.UUID | None = None,
    path: str | None = None,
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
        inherited_customer_id=(str(inherited_customer_id) if inherited_customer_id else None),
        inherited_product_id=(str(inherited_product_id) if inherited_product_id else None),
        can_store=can_store(node.node_type),
        child_count=child_count,
        active_allocation_count=alloc_count,
        path=path,
        created_at=node.created_at,
        updated_at=node.updated_at,
    )


def _alloc_to_read(a: LotAllocation) -> AllocationRead:
    return AllocationRead(
        id=str(a.id),
        lot_id=str(a.lot_id),
        lot_number=a.lot.lot_number if a.lot else None,
        item_id=str(a.lot.item.id) if a.lot and a.lot.item else None,
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
        item_id=str(m.item.id) if m.item else None,
        item_number=m.item.item_number if m.item else None,
        movement_type=m.movement_type,  # type: ignore[arg-type]
        from_location_node_id=(str(m.from_location_node_id) if m.from_location_node_id else None),
        to_location_node_id=(str(m.to_location_node_id) if m.to_location_node_id else None),
        qty_delta=m.qty_delta,
        notes=m.notes,
        performed_by_user_id=str(m.performed_by_user_id),
        performed_at=m.performed_at,
    )


def _build_tree(
    nodes: list[LocationNode],
    alloc_counts: dict[uuid.UUID, int] | None = None,
) -> list[NodeTreeRead]:
    """Nest a flat node list into trees keyed by parent_id (roots returned).

    A node is a root OF THIS FOREST when it has no parent *or* its parent is not
    in ``nodes``. The second half matters because the callers fetch one area's
    node types at a time: since LOC-005 put Warehouse One inside the Materials
    Management room, ``/warehouse-tree`` fetches only ``warehouse``/``shelf`` and
    the parent room is absent — keying strictly on ``parent_id IS NULL`` would
    return an empty forest and the Warehouse page would silently go blank.

    Dedication is resolved by walking each node up to its quadrant within the
    same flat list (no extra queries). ``alloc_counts`` (node_id → active
    allocation count) populates each node's ``active_allocation_count`` so the
    UI can aggregate Occupied / Utilisation across the subtree.
    """
    counts = alloc_counts or {}
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
            alloc_count=counts.get(node.id, 0),
            inherited_customer_id=cust,
            inherited_product_id=prod,
        )
        return NodeTreeRead(**base.model_dump(), children=[build(k) for k in kids])

    # Preserve the incoming order (the repository sorts) rather than grouping by
    # parent, so siblings stay in the order the caller chose.
    roots = [n for n in nodes if n.parent_id is None or n.parent_id not in by_id]
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
    alloc_counts = await loc_repo.active_allocation_counts_by_node(db)
    return _build_tree(nodes, alloc_counts)


@nodes_router.get(
    "/freezer-tree",
    response_model=list[NodeTreeRead],
    summary="Freezer hierarchy as nested trees (room → location → sub-location)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_freezer_tree(
    db: DBSession,
    active_only: Annotated[bool, Query()] = True,
) -> list[NodeTreeRead]:
    from app.models.locations import FREEZER_LEVELS

    nodes = await loc_repo.list_nodes_by_types(db, FREEZER_LEVELS, active_only=active_only)
    # Free-storage leaves hold units (SUM qty), not one-per-cell — occupancy is
    # the unit total.
    units = await loc_repo.active_allocation_units_by_node(db)
    return _build_tree(nodes, units)


@nodes_router.get(
    "/warehouse-tree",
    response_model=list[NodeTreeRead],
    summary="Warehouse hierarchy as nested trees (warehouse → shelf)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_warehouse_tree(
    db: DBSession,
    active_only: Annotated[bool, Query()] = True,
) -> list[NodeTreeRead]:
    from app.models.locations import WAREHOUSE_LEVELS

    nodes = await loc_repo.list_nodes_by_types(db, WAREHOUSE_LEVELS, active_only=active_only)
    units = await loc_repo.active_allocation_units_by_node(db)
    return _build_tree(nodes, units)


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
    rows = await loc_repo.list_flat(db, flat_category=flat_category, active_only=active_only)
    # Flat occupancy = units held (SUM qty), since one allocation may carry many.
    units = await loc_repo.active_allocation_units_by_node(db)
    return [_node_to_read(n, alloc_count=units.get(n.id, 0)) for n in rows]


@nodes_router.get(
    "/storage-targets",
    response_model=list[NodeRead],
    summary="All nodes that can hold a lot (box / freezer sub-location / shelf)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_storage_targets(db: DBSession) -> list[NodeRead]:
    # Every storage leaf across the areas — LN2 boxes (grid) plus the free
    # leaves (freezer sub-locations, warehouse shelves). Feeds the transfer
    # destination picker so stock can move LN2 ↔ Freezer ↔ Warehouse.
    rows = await loc_repo.list_nodes_by_types(
        db, ("box", "sub_location", "shelf"), active_only=True
    )
    # Attach the full breadcrumb so the UI can disambiguate same-named boxes.
    labels = await loc_repo.node_label_map(db)
    return [_node_to_read(n, path=labels.get(n.id, (n.name, n.name))[1]) for n in rows]


@nodes_router.get(
    "/kanbans",
    response_model=list[NodeRead],
    summary="Every Kanban station, with its production area in the path",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_all_kanbans(db: DBSession) -> list[NodeRead]:
    """Every Kanban across every production area (LOC-006).

    Feeds the issue dialog's destination picker as ONE breadcrumbed list
    ("Clean Room Four › Kanban 1") rather than an area select chained to a
    Kanban select — the tree is two levels deep and the second box was always
    a formality. Declared above ``/{node_id}`` or that route swallows it.
    """
    rows = await loc_repo.list_nodes_by_types(db, ("kanban",), active_only=True)
    labels = await loc_repo.node_label_map(db)
    return [_node_to_read(n, path=labels.get(n.id, (n.name, n.name))[1]) for n in rows]


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
    # Shelves and Cold Storage nodes are super-admin-only (LOC-003 / LOC-006).
    _require_super_admin_for_node_type(current, node_type)
    required_parents = PARENT_OF[node_type]

    # ── Strict hierarchy validation — fail fast, never auto-correct (§4.1) ──
    parent_uuid: uuid.UUID | None = None
    parent: LocationNode | None = None
    if required_parents is None:
        # Roots: tank_quadrant must have no parent.
        if payload.parent_id is not None:
            raise ValidationError(
                f"A '{node_type}' is a root and must not have a parent",
                code="invalid_hierarchy",
            )
    else:
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
            raise ValidationError("Parent node is inactive", code="parent_inactive")
        if parent.node_type not in required_parents:
            allowed = " or ".join(f"'{p}'" for p in required_parents)
            raise ValidationError(
                f"A '{node_type}' must hang under {allowed}, " f"not a '{parent.node_type}'",
                code="invalid_parent_type",
            )

    # ── Four quadrants per tank (REQ-2026-07-15-LOC-001) ──────────────────
    # A hard cap, the client's explicit choice. Counting siblings is why this
    # lives here and not in a CHECK constraint.
    if node_type == "tank_quadrant" and parent_uuid is not None:
        existing = await loc_repo.count_children_by_type(
            db, parent_id=parent_uuid, node_type="tank_quadrant"
        )
        if existing >= MAX_QUADRANTS_PER_TANK:
            raise ValidationError(
                f"A tank has {MAX_QUADRANTS_PER_TANK} quadrants; "
                f"'{parent.name if parent else 'this tank'}' already has all of them",
                code="quadrant_limit_reached",
                details={"limit": MAX_QUADRANTS_PER_TANK, "existing": existing},
            )

    # ── Grid dimensions — only on a Box ───────────────────────────────────
    grid_rows: int | None = None
    grid_cols: int | None = None
    if is_grid_node(node_type):
        if payload.grid_rows is None or payload.grid_cols is None:
            raise ValidationError("A box requires grid_rows and grid_cols", code="grid_required")
        grid_rows, grid_cols = payload.grid_rows, payload.grid_cols
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
        await loc_repo.get_sibling_by_code(db, parent_id=parent_uuid, code=payload.code)
    ) is not None:
        raise ConflictError(
            f"A sibling with code '{payload.code}' already exists here",
            code="node_code_conflict",
        )

    # …and sibling NAME uniqueness. The code is generated and rarely seen; the
    # name is what is written on the door, so two siblings sharing one are
    # indistinguishable to the operator choosing between them.
    await _require_unique_name(db, node_type=node_type, parent_id=parent_uuid, name=payload.name)

    node = await loc_repo.create_node(
        db,
        node_type=node_type,
        code=payload.code,
        name=payload.name,
        created_by_user_id=current.id,
        parent_id=parent_uuid,
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


@nodes_router.patch(
    "/{node_id}",
    response_model=NodeRead,
    summary="Rename a node (the user-facing label; type/code are immutable)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_node(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
    payload: NodeUpdateRequest,
) -> NodeRead:
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    # Renaming a PRODUCTION area is super-admin-only (client 2026-07-23), and so
    # is renaming a shelf or a Cold Storage node (LOC-003 says operators may not
    # create *or rename* shelves). LN2 nodes keep the inventory:create gate.
    if node.node_type == "flat" and node.flat_category == "production":
        _require_super_admin(current)
    else:
        _require_super_admin_for_node_type(current, node.node_type)
    # A rename can collide exactly as a create can — and it is the likelier of
    # the two, since the operator is usually correcting a name they already
    # believe belongs to something here.
    await _require_unique_name(
        db,
        node_type=node.node_type,
        parent_id=node.parent_id,
        name=payload.name,
        exclude_id=node.id,
    )
    before = loc_repo.node_to_audit_snapshot(node)
    updated = await loc_repo.update_node_name(db, node=node, name=payload.name)
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
    # Reload server-side onupdate columns (updated_at) in the async context —
    # accessing them lazily inside the sync serializer raises MissingGreenlet.
    await db.refresh(updated)
    response = _node_to_read(updated)
    await db.commit()
    return response


@nodes_router.patch(
    "/{node_id}/parent",
    response_model=NodeRead,
    summary="Re-hang a node under a different parent — super-admin only",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def move_node(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
    payload: NodeMoveRequest,
) -> NodeRead:
    """Move a node — and everything inside it — to a new parent (LOC-004).

    Only this node's ``parent_id`` changes. Children point at their parent and a
    lot allocation points at its box's *id*, never at a path, so a rack moved to
    another quadrant carries its boxes and their vials with it and every address
    beneath recomputes. Nothing is re-placed and no stock moves, so this is not
    a ledger event — it is a structural edit, recorded in the audit log.

    Ledger rows written BEFORE the move keep the address they were written with
    (``stock_movements.from/to_location_path``), so history still reads as it
    happened rather than following the node.
    """
    _require_super_admin(current, what="the location structure")

    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")

    required_parents = PARENT_OF.get(node.node_type)
    if required_parents is None:
        # Roots (a tank, a room) have nothing to hang under, and retired types
        # are absent from PARENT_OF entirely — neither can be moved.
        raise ValidationError(
            f"A '{node.node_type}' is a root and cannot be moved under a parent",
            code="node_not_movable",
        )

    new_parent_id = _parse_uuid(payload.parent_id, field="parent_id")
    if new_parent_id == node.id:
        raise ValidationError("A node cannot be its own parent", code="invalid_parent")
    if new_parent_id == node.parent_id:
        # Already there. Return unchanged rather than writing a no-op audit row.
        return _node_to_read(node)

    new_parent = await loc_repo.get_node(db, new_parent_id)
    if new_parent is None:
        raise NotFoundError(f"Parent node {payload.parent_id} not found")
    if not new_parent.is_active:
        raise ValidationError("Parent node is inactive", code="parent_inactive")
    if new_parent.node_type not in required_parents:
        allowed = " or ".join(f"'{p}'" for p in required_parents)
        raise ValidationError(
            f"A '{node.node_type}' must hang under {allowed}, " f"not a '{new_parent.node_type}'",
            code="invalid_parent_type",
        )

    # Dropping a node onto its own descendant would orphan the whole branch from
    # every root — it would still exist, but no tree walk could ever reach it.
    if await loc_repo.is_descendant_of(db, ancestor_id=node.id, candidate_id=new_parent_id):
        raise ValidationError(
            f"'{new_parent.name}' sits inside '{node.name}' — "
            "a node cannot be moved into its own contents",
            code="invalid_parent_cycle",
        )

    # The destination's own rules apply exactly as they would on create.
    clash = await loc_repo.get_sibling_by_code(db, parent_id=new_parent_id, code=node.code)
    if clash is not None:
        raise ConflictError(
            f"'{new_parent.name}' already contains something coded '{node.code}'",
            code="node_code_conflict",
        )
    if node.node_type == "tank_quadrant":
        existing = await loc_repo.count_children_by_type(
            db, parent_id=new_parent_id, node_type="tank_quadrant"
        )
        if existing >= MAX_QUADRANTS_PER_TANK:
            raise ValidationError(
                f"A tank has {MAX_QUADRANTS_PER_TANK} quadrants; "
                f"'{new_parent.name}' already has all of them",
                code="quadrant_limit_reached",
                details={"limit": MAX_QUADRANTS_PER_TANK, "existing": existing},
            )

    before = loc_repo.node_to_audit_snapshot(node)
    from_path = await loc_repo.node_path_text(db, node.id)
    moved = await loc_repo.move_node(db, node=node, new_parent_id=new_parent_id)
    to_path = await loc_repo.node_path_text(db, moved.id)

    # ``updated``, not a "moved" action: ``AuditAction`` is a closed set backed
    # by a CHECK on audit.audit_events, and a re-hang genuinely is an update to
    # the node's parentage. The before/after paths carry what actually changed.
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="meta.location_nodes",
        subject_id=moved.id,
        subject_label=f"{moved.node_type}:{moved.code}",
        before={**before, "path": from_path},
        after={**loc_repo.node_to_audit_snapshot(moved), "path": to_path},
    )
    response = _node_to_read(moved)
    await db.commit()
    return response


# Node types whose creation and renaming is super-admin-only:
#   * ``shelf`` — REQ-2026-07-15-LOC-003. Operators must not create or rename
#     shelves: duplicate or ad-hoc shelf names split one physical spot into two
#     and corrupt planning reorder points.
#   * ``room_location`` / ``sub_location`` — REQ-2026-07-15-LOC-006, "only Super
#     Admin may create Cold Storage locations". These are the cold locations
#     (Minus-20 Freezers) and the equipment units inside them.
#
# This deliberately overrides LOC-003's older sentence that "adding freezers,
# refrigerators, and LN2 tanks remains available to the appropriate admin role":
# LOC-006 is the later requirement and was signed off on 2026-07-29.
SUPER_ADMIN_NODE_TYPES: frozenset[str] = frozenset({"shelf", "room_location", "sub_location"})

# LN2 structure — the second, looser tier. LOC-003 draws an explicit contrast:
# shelves are "restricted to the Super Admin role", while freezers, refrigerators
# and LN2 tanks "remain available to the appropriate ADMIN role". Two thresholds,
# deliberately.
#
# These used to fall through to the bare ``inventory:create`` dependency, which
# OPERATORS also hold — so an operator could create and rename tanks, looser than
# the requirement allows. The rationale behind the shelf rule applies just as
# well here: ad-hoc duplicate tank names split one physical vessel into two.
ADMIN_NODE_TYPES: frozenset[str] = frozenset(
    {"tank", "tank_quadrant", "rack", "cassette", "cryo_box_rack", "box"}
)


def _require_super_admin(user, *, what: str = "production areas") -> None:
    """Super-admin-only guard for the restricted location writes.

    Covers production areas (client 2026-07-23) and, per LOC-003 / LOC-006,
    shelves and Cold Storage nodes. ``super_admin`` is told apart from ``admin``
    by the DB role, since both share the ``admin`` permission bucket."""
    if getattr(user, "role", None) != "super_admin":
        raise AuthorizationError(
            f"Only a super admin can manage {what}",
            code="permission_denied",
            details={"required_role": "super_admin"},
        )


def _require_admin(user, *, what: str) -> None:
    """Admin-or-above guard. Blocks operators and read-only.

    Checked against the DB role rather than the permission matrix because
    ``operator`` also holds ``inventory:create`` — the matrix cannot tell an
    admin from an operator for write purposes, only the role can.
    """
    if getattr(user, "role", None) not in ("super_admin", "admin"):
        raise AuthorizationError(
            f"Only an admin can manage {what}",
            code="permission_denied",
            details={"required_role": "admin"},
        )


def _require_super_admin_for_node_type(user, node_type: str) -> None:
    """Apply the LOC-003 / LOC-006 role gates to the restricted node types.

    Two tiers: shelves and Cold Storage are Super-Admin-only; LN2 structure is
    admin-or-above. Everything else stays on the plain ``inventory:create``
    dependency the route already declares.
    """
    if node_type in SUPER_ADMIN_NODE_TYPES:
        what = "shelves" if node_type == "shelf" else "Cold Storage locations"
        _require_super_admin(user, what=what)
    elif node_type in ADMIN_NODE_TYPES:
        _require_admin(user, what="LN2 storage")


@nodes_router.post(
    "/production-areas",
    response_model=NodeRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a Production area (a production-floor sub-location) — super-admin only",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def add_production_area(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ProductionAreaCreate,
) -> NodeRead:
    """Add one production area on top of the seeded set. Production is seeded to
    cover existing spaces; new areas are added by a SUPER ADMIN on request (SRS
    2026-07-22) — there is no open, per-user "add a floor". The area is a ``flat``
    node in the ``production`` category; its ``code`` is generated from the name.
    Rename it later via ``PATCH /location-nodes/{id}``."""
    _require_super_admin(current)
    # Production areas are flat nodes with no parent, so the sibling check runs
    # against the other roots — which is where a second "Clean Room One" would
    # land, and two of those are indistinguishable on a kit's destination list.
    await _require_unique_name(db, node_type="flat", parent_id=None, name=payload.name)
    node = await loc_repo.create_production_area(
        db, name=payload.name, created_by_user_id=current.id
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


@nodes_router.get(
    "/{node_id}/kanbans",
    response_model=list[NodeRead],
    summary="The Kanban stations inside a production area",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_kanbans(db: DBSession, node_id: Annotated[uuid.UUID, Path()]) -> list[NodeRead]:
    """Feeds the issue dialog's destination picker and the floor's Kanban tab.
    Returns an empty list for an area with no Kanban yet — the UI turns that
    into "ask a super admin to add one" rather than an error."""
    return [_node_to_read(n) for n in await loc_repo.list_kanbans(db, node_id)]


@nodes_router.post(
    "/{node_id}/kanbans",
    response_model=NodeRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a Kanban station inside a production area — super-admin only",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def add_kanban(
    db: DBSession,
    current: CurrentDbUserDep,
    node_id: Annotated[uuid.UUID, Path()],
    payload: KanbanCreate,
) -> NodeRead:
    """Add one Kanban to a production area (REQ-2026-07-01-LOC-006, "a Kanban
    shall be representable as a named location"; client 2026-08-10).

    A room may hold several — "Kanban 1", "Kanban 2" — and a consumable issue
    always targets one of them rather than the room itself, so two stations in
    one clean room stay separately countable.

    Super-admin only, on the same rationale as LOC-003's shelf restriction: an
    operator-created "Kanban1" alongside "Kanban 1" silently splits one physical
    bin's register in two.
    """
    _require_super_admin(current, what="Kanban stations")
    area = await loc_repo.get_node(db, node_id)
    if area is None:
        raise NotFoundError(f"Location node {node_id} not found")
    # ``flat`` alone would also match a legacy Lab / QC / Materials node, and a
    # Kanban belongs to a production area specifically.
    if area.node_type != "flat" or area.flat_category != "production":
        raise ValidationError(
            "A Kanban is added inside a production area.",
            code="parent_not_production_area",
        )
    if not area.is_active:
        raise ValidationError("That production area is inactive", code="node_inactive")
    await _require_unique_name(db, node_type="kanban", parent_id=area.id, name=payload.name)
    node = await loc_repo.create_kanban(
        db, area_node_id=area.id, name=payload.name, created_by_user_id=current.id
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
        raise ValidationError("Only a box has a resizable grid", code="grid_not_allowed")
    # The single-column rule for a box under a cassette is gone with the
    # cassette level itself (client 2026-07-29) — a box now hangs off a rack and
    # carries whatever grid it is given.
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
    # Reload server-side onupdate columns (updated_at) in the async context —
    # accessing them lazily inside the sync serializer raises MissingGreenlet.
    await db.refresh(updated)
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
    # Reload server-side onupdate columns (updated_at) in the async context —
    # accessing them lazily inside the sync serializer raises MissingGreenlet.
    await db.refresh(updated)
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
        raise ValidationError("Cannot delete a node that has child nodes", code="node_has_children")
    if await loc_repo.node_has_any_allocations(db, node_id):
        raise ValidationError(
            "Cannot delete a node that holds active lots", code="node_has_active_lots"
        )
    if await loc_repo.node_has_movement_history(db, node_id):
        raise ValidationError("Cannot delete a node with ledger history", code="node_has_history")

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
    # Reload server-side onupdate columns (updated_at) in the async context —
    # accessing them lazily inside the sync serializer raises MissingGreenlet.
    await db.refresh(updated)
    response = _node_to_read(updated)
    await db.commit()
    return response


# ── Allocation operations (place / transfer / consume) ──────────────────


#: Node types whose NAME is a physical identifier rather than a label relative
#: to a parent: a Cold Storage unit is named for the client's equipment T-number
#: (REQ-2026-07-15-LOC-006) and a Warehouse shelf for its letter (LOC-005).
#: One of these names one real object, so it may not appear twice ANYWHERE.
#:
#: Everything else is checked among siblings only — each room legitimately has
#: its own "Minus-20 Freezers" group and each rack its own "Box", and a global
#: rule would forbid the layout the rooms actually have (client 2026-08-05).
UNIT_NODE_TYPES = frozenset({"sub_location", "shelf"})


async def _require_unique_name(
    db: DBSession,
    *,
    node_type: str,
    parent_id: uuid.UUID | None,
    name: str,
    exclude_id: uuid.UUID | None = None,
) -> None:
    """Reject a duplicate location name (REQ-2026-07-15-LOC-003 / LOC-006).

    Enforced on create AND rename — a rename can collide just as easily as a
    create, and the two together are the only ways a name enters the tree.

    Messages stay short: the operator is looking at the field they just typed.
    The installation-wide case names where the clash is, because that one is
    off screen and otherwise unfindable.
    """
    if node_type in UNIT_NODE_TYPES:
        clash = await loc_repo.get_node_by_name_anywhere(
            db, node_type=node_type, name=name, exclude_id=exclude_id
        )
        if clash is not None:
            where = clash.parent.name if clash.parent is not None else None
            raise ConflictError(
                f"'{clash.name}' already exists" + (f" in {where}." if where else " elsewhere."),
                code="node_name_conflict",
                details={"existing_id": str(clash.id), "name": clash.name},
            )
        return

    clash = await loc_repo.get_sibling_by_name(
        db, parent_id=parent_id, name=name, exclude_id=exclude_id
    )
    if clash is not None:
        raise ConflictError(
            f"'{clash.name}' already exists here.",
            code="node_name_conflict",
            details={"existing_id": str(clash.id), "name": clash.name},
        )


async def _resolve_storage_node(db: DBSession, node_id: str) -> LocationNode:
    node_uuid = _parse_uuid(node_id, field="node_id")
    node = await loc_repo.get_node(db, node_uuid)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found")
    if not node.is_active:
        raise ValidationError("Location node is inactive", code="node_inactive")
    if not can_store(node.node_type):
        raise ValidationError(
            f"A '{node.node_type}' cannot store lots — only boxes and " "flat locations can",
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

    # Capacity: total *ever* placed for a lot may not exceed its ordered_qty
    # (when set). Placing IS the unit-in, so we measure against the append-only
    # receipt ledger — consumed units stay counted and can't free up capacity.
    if lot.ordered_qty is not None:
        already = await loc_repo.sum_received_qty_for_lot(db, lot_uuid)
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
        # The lot being placed — chosen on screen; the movement row below is the result.
        record_table="app.lots",
        record_id=lot_uuid,
    )
    response = _alloc_to_read(alloc)
    await db.commit()
    return response


@alloc_router.post(
    "/place-batch",
    response_model=list[AllocationRead],
    status_code=status.HTTP_201_CREATED,
    summary="Place a lot into several box cells in one e-signed action (§3)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def place_lot_batch(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: PlaceBatchRequest,
) -> list[AllocationRead]:
    lot_uuid = _parse_uuid(payload.lot_id, field="lot_id")
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")

    node = await _resolve_storage_node(db, payload.node_id)
    if not is_grid_node(node.node_type):
        raise ValidationError(
            "Batch placement targets a box grid; use /place for a flat location",
            code="batch_target_not_box",
        )

    # Each cell takes exactly one unit — validate every target up front.
    for cell in payload.cells:
        await _validate_cell_target(
            db,
            node=node,
            grid_row=cell.grid_row,
            grid_col=cell.grid_col,
            qty=Decimal("1"),
            override=payload.override,
            role=current.role,
        )

    # Lifetime cap: total placed for the lot (incl. consumed) may not exceed
    # ordered_qty — measured against the append-only receipt ledger.
    qty = len(payload.cells)
    if lot.ordered_qty is not None:
        already = await loc_repo.sum_received_qty_for_lot(db, lot_uuid)
        if already + qty > lot.ordered_qty:
            raise ValidationError(
                f"Placing {qty} would exceed the lot's ordered "
                f"{lot.ordered_qty} (already placed {already})",
                code="place_exceeds_ordered",
            )

    # One allocation per cell (each cell holds one unit) ...
    allocs: list[AllocationRead] = []
    for cell in payload.cells:
        alloc = await loc_repo.create_allocation(
            db,
            lot_id=lot_uuid,
            location_node_id=node.id,
            qty=Decimal("1"),
            grid_row=cell.grid_row,
            grid_col=cell.grid_col,
            created_by_user_id=current.id,
            notes=payload.notes,
        )
        allocs.append(_alloc_to_read(alloc))

    # ... but a SINGLE +N receipt for the whole batch (the unit-in is one
    # logical, singly-signed event — the ledger shows "units in N", not N×1).
    movement = await loc_repo.create_node_receipt_movement(
        db,
        item_id=lot.item_id,
        lot_id=lot_uuid,
        to_location_node_id=node.id,
        qty=Decimal(qty),
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence_uuid,
        notes=payload.notes,
    )
    # One signature authorises the whole batch — consume it once.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.receipt",
        target_table="app.stock_movements",
        target_id=movement.id,
        # The lot being placed — chosen on screen; the movement row below is the result.
        record_table="app.lots",
        record_id=lot_uuid,
    )
    await db.commit()
    return allocs


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
    alloc = await loc_repo.get_allocation(db, alloc_uuid, for_update=True)
    if alloc is None or not alloc.is_active:
        raise NotFoundError(f"Active allocation {payload.allocation_id} not found")

    to_node = await _resolve_storage_node(db, payload.to_node_id)
    if to_node.id == alloc.location_node_id and (
        payload.to_grid_row == alloc.grid_row and payload.to_grid_col == alloc.grid_col
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
        # The allocation the operator selected to move.
        record_table="app.lot_allocations",
        record_id=alloc.id,
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
    alloc = await loc_repo.get_allocation(db, alloc_uuid, for_update=True)
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
        # The allocation the operator selected to consume.
        record_table="app.lot_allocations",
        record_id=alloc.id,
    )
    response = _alloc_to_read(updated)
    await db.commit()
    return response


async def _load_batch_sources(
    db: DBSession, allocation_ids: list[str]
) -> tuple[list[LotAllocation], uuid.UUID, uuid.UUID]:
    """Fetch + validate the source allocations for a batch unit-out.

    Returns ``(allocations, lot_id, source_node_id)``. A batch must be a
    single lot and come from a single location (the box grid the user
    multi-selected, or one flat allocation).
    """
    allocs: list[LotAllocation] = []
    for raw in allocation_ids:
        au = _parse_uuid(raw, field="allocation_id")
        a = await loc_repo.get_allocation(db, au, for_update=True)
        if a is None or not a.is_active:
            raise NotFoundError(f"Active allocation {raw} not found")
        allocs.append(a)
    if len({a.lot_id for a in allocs}) != 1:
        raise ValidationError("A batch must be a single lot", code="batch_multi_lot")
    if len({a.location_node_id for a in allocs}) != 1:
        raise ValidationError("A batch must come from a single location", code="batch_multi_node")
    return allocs, allocs[0].lot_id, allocs[0].location_node_id


@alloc_router.post(
    "/consume-batch",
    response_model=list[AllocationRead],
    status_code=status.HTTP_201_CREATED,
    summary="Consume several cells of one lot in a single e-signed action (§3)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def consume_batch(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ConsumeBatchRequest,
) -> list[AllocationRead]:
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    allocs, lot_id, from_node_id = await _load_batch_sources(db, payload.allocation_ids)

    to_node = await _resolve_storage_node(db, payload.to_node_id)
    if to_node.node_type != "flat":
        raise ValidationError(
            "Consume must target a flat location (lab / Kanban / Materials)",
            code="consume_target_not_flat",
        )

    item_id = allocs[0].lot.item_id
    total = sum((a.qty for a in allocs), Decimal(0))
    results = [
        _alloc_to_read(await loc_repo.reduce_allocation(db, allocation=a, qty=a.qty))
        for a in allocs
    ]
    # One dispense for the whole batch — the ledger shows "units out N".
    movement = await loc_repo.create_node_dispense_movement(
        db,
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_node_id,
        to_location_node_id=to_node.id,
        qty=total,
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
        # Batch dispense: single-lot batch, so the lot is the subject.
        record_table="app.lots",
        record_id=lot_id,
    )
    await db.commit()
    return results


@alloc_router.post(
    "/transfer-batch",
    response_model=list[AllocationRead],
    status_code=status.HTTP_201_CREATED,
    summary="Transfer units of one lot to a flat or box, signed once (§3)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def transfer_batch(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferBatchRequest,
) -> list[AllocationRead]:
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    allocs, lot_id, from_node_id = await _load_batch_sources(db, payload.allocation_ids)
    item_id = allocs[0].lot.item_id
    available = sum((a.qty for a in allocs), Decimal(0))

    to_node = await _resolve_storage_node(db, payload.to_node_id)
    dest_is_box = is_grid_node(to_node.node_type)
    source_is_box = all(a.grid_row is not None for a in allocs)

    if dest_is_box:
        if not payload.to_cells:
            raise ValidationError(
                "A box destination needs target cells", code="dest_cells_required"
            )
        if payload.qty is not None:
            raise ValidationError(
                "Omit qty for a box destination (quantity = number of cells)",
                code="qty_not_allowed",
            )
        # Box→box moves every selected source cell (no partial); flat→box may
        # move fewer units than the flat holds.
        if source_is_box and len(payload.to_cells) != len(allocs):
            raise ValidationError(
                f"Select exactly {len(allocs)} destination cell(s)",
                code="dest_count_mismatch",
            )
        move_qty = Decimal(len(payload.to_cells))
        for cell in payload.to_cells:
            await _validate_cell_target(
                db,
                node=to_node,
                grid_row=cell.grid_row,
                grid_col=cell.grid_col,
                qty=Decimal("1"),
                override=payload.override,
                role=current.role,
            )
    else:
        if payload.to_cells:
            raise ValidationError("A flat destination takes no cells", code="cells_not_allowed")
        if payload.qty is None:
            raise ValidationError("A flat destination needs qty", code="qty_required")
        move_qty = Decimal(payload.qty)

    if move_qty > available:
        raise ValidationError(
            f"Requested {move_qty} exceeds available {available}",
            code="transfer_exceeds_available",
        )

    # Draw the moved quantity from the sources in order.
    remaining = move_qty
    for a in allocs:
        if remaining <= 0:
            break
        take = a.qty if a.qty <= remaining else remaining
        await loc_repo.reduce_allocation(db, allocation=a, qty=take)
        remaining -= take

    results: list[AllocationRead] = []
    if dest_is_box:
        for cell in payload.to_cells:
            dest = await loc_repo.create_allocation(
                db,
                lot_id=lot_id,
                location_node_id=to_node.id,
                qty=Decimal("1"),
                grid_row=cell.grid_row,
                grid_col=cell.grid_col,
                created_by_user_id=current.id,
                notes=payload.notes,
            )
            results.append(_alloc_to_read(dest))
    else:
        dest = await loc_repo.create_allocation(
            db,
            lot_id=lot_id,
            location_node_id=to_node.id,
            qty=move_qty,
            created_by_user_id=current.id,
            notes=payload.notes,
        )
        results.append(_alloc_to_read(dest))

    # One transfer pair for the whole batch.
    out_leg, _in_leg = await loc_repo.create_node_transfer_pair(
        db,
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_node_id,
        to_location_node_id=to_node.id,
        qty=move_qty,
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
        # Batch transfer: every source is one lot (enforced above), so the lot is the subject.
        record_table="app.lots",
        record_id=lot_id,
    )
    await db.commit()
    return results


@dataclass(slots=True)
class _TransferLeg:
    """One resolved leg of a multi-source transfer: which units move, and where
    to. Built during the validation pass so the write pass can run straight
    through without re-parsing or re-fetching anything."""

    line_no: int
    lot_id: uuid.UUID
    from_node_id: uuid.UUID
    qty: int
    #: Exact source vials for an LN2 box; None drains the lot FIFO.
    source_cells: list[str] | None
    to_node: LocationNode
    #: Exact destination cells for a box; empty for a flat destination.
    to_cells: list[BatchCell]


async def _draw_transfer_source(
    db: DBSession,
    *,
    item_id: uuid.UUID,
    lot_uuid: uuid.UUID,
    node_uuid: uuid.UUID,
    qty: int,
    cell_allocation_ids: list[str] | None,
    line_no: int,
) -> None:
    """Draw ``qty`` of one lot at one node — the exact vials for an LN2 box,
    else FIFO across that lot's allocations there. Reducing an allocation to
    zero deactivates it (incl. box cells), which is what frees the source cell.

    Mirrors the shipment source drain; the difference is only in the error
    codes, which name a transfer so the dialog can phrase its message.
    """
    allocs = [
        a
        for a in await kit_repo.allocations_for_item_at_node(
            db, item_id, node_uuid, for_update=True
        )
        if a.lot_id == lot_uuid
    ]
    available = sum(int(a.qty) for a in allocs)
    if available == 0:
        raise NotFoundError(
            f"Source {line_no}: that lot is no longer stored at that location",
            code="no_stock_at_location",
        )

    if cell_allocation_ids:
        wanted = [_parse_uuid(c, field="cell_allocation_ids") for c in cell_allocation_ids]
        if qty != len(set(wanted)):
            raise ValidationError(
                f"Source {line_no}: {len(set(wanted))} vials selected but qty is {qty} — "
                f"for a box the quantity is the number of vials.",
                code="cell_count_mismatch",
            )
        chosen = await kit_repo.allocations_by_ids(db, wanted)
        found = {a.id for a in chosen}
        if [str(w) for w in wanted if w not in found] or any(
            a.lot_id != lot_uuid or a.location_node_id != node_uuid for a in chosen
        ):
            raise ValidationError(
                f"Source {line_no}: one or more selected vials are no longer available.",
                code="invalid_cell",
            )
        for alloc in chosen:
            await loc_repo.reduce_allocation(db, allocation=alloc, qty=int(alloc.qty))
        return

    if qty > available:
        raise ValidationError(
            f"Source {line_no}: requested {qty} exceeds the {available} available for "
            f"this lot here",
            code="transfer_exceeds_available",
        )
    remaining = qty
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        remaining -= take


@alloc_router.post(
    "/transfer-multi",
    response_model=list[AllocationRead],
    status_code=status.HTTP_201_CREATED,
    summary="Transfer one item's stock from several lots/locations, signed once (TRX-001)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def transfer_multi(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferMultiRequest,
) -> list[AllocationRead]:
    """The inventory-workspace transfer (REQ-2026-07-15-TRX-001, refined
    2026-07-22): started from an item rather than from a location, so it draws
    from as many (lot × location) sources as the item is spread across — each
    to its own destination — and the operator signs once. ``/transfer`` and
    ``/transfer-batch`` still serve the within-location path, where the source
    allocation is already in hand.
    """
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")

    # Resolve + validate every leg up front: all must be the SAME item, so the
    # one signature covers one item's move and the ledger rows agree.
    item_id: uuid.UUID | None = None
    legs: list[_TransferLeg] = []
    for i, src in enumerate(payload.sources, start=1):
        lot_uuid = _parse_uuid(src.lot_id, field="lot_id")
        node_uuid = _parse_uuid(src.node_id, field="node_id")
        lot = await inv_repo.get_lot(db, lot_uuid)
        if lot is None:
            raise NotFoundError(f"Lot {src.lot_id} not found", code="lot_not_found")
        if item_id is None:
            item_id = lot.item_id
        elif lot.item_id != item_id:
            raise ValidationError("All sources must be for the same item", code="mixed_items")

        to_node = await _resolve_storage_node(db, src.to_node_id)
        # Moving inside one box / shelf is the single-allocation ``/transfer``
        # path, which can reason about one cell moving to another.
        if to_node.id == node_uuid:
            raise ValidationError(
                f"Source {i}: the destination is the location it is already in",
                code="transfer_same_location",
            )
        if is_grid_node(to_node.node_type):
            if not src.to_cells:
                raise ValidationError(
                    f"Source {i}: a box destination needs target cells",
                    code="dest_cells_required",
                )
            if len(src.to_cells) != src.qty:
                raise ValidationError(
                    f"Source {i}: select exactly {src.qty} destination cell(s)",
                    code="dest_count_mismatch",
                )
        elif src.to_cells:
            raise ValidationError(
                f"Source {i}: a flat destination takes no cells",
                code="cells_not_allowed",
            )
        legs.append(
            _TransferLeg(
                line_no=i,
                lot_id=lot_uuid,
                from_node_id=node_uuid,
                qty=src.qty,
                source_cells=src.cell_allocation_ids,
                to_node=to_node,
                to_cells=list(src.to_cells),
            )
        )

    assert item_id is not None  # sources has min_length 1

    # Draw EVERY source before validating a single destination cell: one leg may
    # be vacating the very cell another is aiming at (shuffling vials between
    # two boxes), and checking occupancy first would reject that as occupied.
    # Reducing an allocation to zero deactivates it, so the flush below is what
    # makes the freed cells visible to the occupancy check.
    for leg in legs:
        await _draw_transfer_source(
            db,
            item_id=item_id,
            lot_uuid=leg.lot_id,
            node_uuid=leg.from_node_id,
            qty=leg.qty,
            cell_allocation_ids=leg.source_cells,
            line_no=leg.line_no,
        )
    await db.flush()

    results: list[AllocationRead] = []
    first_out_leg: StockMovement | None = None
    # Flat destinations: one allocation per (destination, LOT), not per leg. Two
    # legs may carry the same lot to the same shelf, and landing that as two
    # rows would be a split with no meaning — every reader has to sum it back
    # up. A box is the opposite: one allocation per cell, by design.
    flat_by_dest_lot: dict[tuple[uuid.UUID, uuid.UUID], int] = {}
    for leg in legs:
        if leg.to_cells:
            for cell in leg.to_cells:
                await _validate_cell_target(
                    db,
                    node=leg.to_node,
                    grid_row=cell.grid_row,
                    grid_col=cell.grid_col,
                    qty=Decimal("1"),
                    override=payload.override,
                    role=current.role,
                )
                dest = await loc_repo.create_allocation(
                    db,
                    lot_id=leg.lot_id,
                    location_node_id=leg.to_node.id,
                    qty=Decimal("1"),
                    grid_row=cell.grid_row,
                    grid_col=cell.grid_col,
                    created_by_user_id=current.id,
                    notes=payload.notes,
                )
                results.append(_alloc_to_read(dest))
        else:
            key = (leg.to_node.id, leg.lot_id)
            flat_by_dest_lot[key] = flat_by_dest_lot.get(key, 0) + leg.qty

        # A transfer pair carries one lot, one source and one destination, so
        # the ledger gets a pair per leg — that is what makes each row say where
        # the material actually came from and went. Still one signature.
        out_leg, _in_leg = await loc_repo.create_node_transfer_pair(
            db,
            item_id=item_id,
            lot_id=leg.lot_id,
            from_location_node_id=leg.from_node_id,
            to_location_node_id=leg.to_node.id,
            qty=Decimal(leg.qty),
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            notes=payload.notes,
        )
        if first_out_leg is None:
            first_out_leg = out_leg

    # Distinct lots never merge — an allocation carries exactly one lot.
    for (dest_node_id, lot_uuid), lot_qty in flat_by_dest_lot.items():
        dest = await loc_repo.create_allocation(
            db,
            lot_id=lot_uuid,
            location_node_id=dest_node_id,
            qty=Decimal(lot_qty),
            created_by_user_id=current.id,
            notes=payload.notes,
        )
        results.append(_alloc_to_read(dest))

    assert first_out_leg is not None
    # Consumed LAST so a replayed signature rolls the whole transfer back. One
    # signature authorises the whole move; it targets its first ledger row.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="movement.transfer",
        target_table="app.stock_movements",
        target_id=first_out_leg.id,
        # Several lots may move at once, so the SUBJECT is the item — the record
        # the operator opened and signed about, not any one lot.
        record_table="app.items",
        record_id=item_id,
    )
    await db.commit()
    return results


@alloc_router.get(
    "/lot-availability/{lot_id}",
    response_model=LotAvailabilityRead,
    summary="How much of a lot may still be placed (ordered − lifetime placed)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def lot_availability(
    db: DBSession,
    lot_id: Annotated[uuid.UUID, Path()],
) -> LotAvailabilityRead:
    lot = await inv_repo.get_lot(db, lot_id)
    if lot is None:
        raise NotFoundError(f"Lot {lot_id} not found")
    placed = int(await loc_repo.sum_received_qty_for_lot(db, lot_id))
    remaining = None if lot.ordered_qty is None else lot.ordered_qty - placed
    return LotAvailabilityRead(
        lot_id=str(lot_id),
        ordered_qty=lot.ordered_qty,
        placed=placed,
        remaining=remaining,
    )


@alloc_router.get(
    "/search",
    response_model=list[AllocationRead],
    summary="Where stock is stored — search by lot number, item number or name",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def search_allocations(
    db: DBSession,
    q: Annotated[str, Query(min_length=1, max_length=120)],
    limit: Annotated[int, Query(ge=1, le=1000)] = 400,
) -> list[AllocationRead]:
    """Find where stock is, from a partial lot number, item number or item name.

    Declared ABOVE ``/by-lot/{lot_id}``: a literal path must be registered before
    any sibling that could capture it, or the dynamic route wins and ``/search``
    arrives as a lot id that fails to parse as a UUID.
    """
    rows = await loc_repo.search_stored_stock(db, query=q, limit=limit)
    return [_alloc_to_read(a) for a in rows]


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
