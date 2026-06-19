"""Location system routes — hierarchy engine, flat locations, allocations.

Strict validation (Requirements v2 §5–§13): the LN2 parent-type rules are
enforced here on every create; only ``sub_slot`` / ``flat`` nodes can hold
lots; sub-slots are single-occupancy (override-gated); deletion is blocked
when a node has children, active lots, or movement history.

Place / transfer / consume are *logged* (append-only
``app.allocation_movements``) but not e-signed — §11 treats cross-location
transfers as "log only, no structural change".
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.locations import repository as loc_repo
from app.locations.schemas import (
    AllocationRead,
    ConsumeRequest,
    MovementRead,
    NodeCreate,
    NodeRead,
    NodeTreeRead,
    PlaceRequest,
    TransferRequest,
)
from app.models.locations import (
    PARENT_OF,
    AllocationMovement,
    LocationNode,
    LotAllocation,
    can_store,
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
    node: LocationNode, *, child_count: int = 0, alloc_count: int = 0
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
        qty=a.qty,
        is_active=a.is_active,
        created_at=a.created_at,
    )


def _movement_to_read(
    m: AllocationMovement, names: dict[uuid.UUID, str]
) -> MovementRead:
    return MovementRead(
        id=str(m.id),
        lot_id=str(m.lot_id),
        lot_number=m.lot.lot_number if m.lot else None,
        movement_kind=m.movement_kind,  # type: ignore[arg-type]
        from_node_id=str(m.from_node_id) if m.from_node_id else None,
        from_node_name=names.get(m.from_node_id) if m.from_node_id else None,
        to_node_id=str(m.to_node_id) if m.to_node_id else None,
        to_node_name=names.get(m.to_node_id) if m.to_node_id else None,
        qty=m.qty,
        notes=m.notes,
        performed_by_user_id=str(m.performed_by_user_id),
        performed_at=m.performed_at,
    )


def _build_tree(nodes: list[LocationNode]) -> list[NodeTreeRead]:
    """Nest a flat node list into trees keyed by parent_id (roots returned)."""
    by_parent: dict[uuid.UUID | None, list[LocationNode]] = {}
    for n in nodes:
        by_parent.setdefault(n.parent_id, []).append(n)

    def build(node: LocationNode) -> NodeTreeRead:
        kids = by_parent.get(node.id, [])
        base = _node_to_read(node, child_count=len(kids))
        return NodeTreeRead(**base.model_dump(), children=[build(k) for k in kids])

    roots = by_parent.get(None, [])
    return [build(r) for r in roots]


# ── Node reads ──────────────────────────────────────────────────────────


@nodes_router.get(
    "/ln2-tree",
    response_model=list[NodeTreeRead],
    summary="LN2 hierarchy as nested trees (tank_quadrant → … → sub_slot)",
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
    summary="All nodes that can hold a lot (sub_slots + flat) — for placement",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_storage_targets(db: DBSession) -> list[NodeRead]:
    rows = await loc_repo.list_nodes_by_types(db, ("sub_slot", "flat"), active_only=True)
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
    return _node_to_read(node, child_count=children, alloc_count=allocs)


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
    summary="Active lot allocations stored at a node",
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
    required_parent = PARENT_OF[node_type]

    # ── Strict hierarchy validation — fail fast, never auto-correct (§6) ──
    parent_uuid: uuid.UUID | None = None
    if required_parent is None:
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
        if node_type == "tank_quadrant" and payload.flat_category is not None:
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
            raise ValidationError(
                f"A '{node_type}' requires a parent of type '{required_parent}'",
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
        if parent.node_type != required_parent:
            raise ValidationError(
                f"A '{node_type}' must hang under a '{required_parent}', "
                f"not a '{parent.node_type}'",
                code="invalid_parent_type",
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

    # Block rules (§10) — strict, no cascade.
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
            "Cannot delete a node with transfer history", code="node_has_history"
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
            f"A '{node.node_type}' cannot store lots — only sub_slots and "
            "flat locations can",
            code="node_not_storable",
        )
    return node


async def _check_subslot_capacity(
    db: DBSession,
    *,
    node: LocationNode,
    qty: Decimal,
    override: bool,
    role: str,
) -> None:
    """Enforce single-occupancy on a sub_slot (§11 full-slot rule)."""
    if node.node_type != "sub_slot":
        return
    if qty != Decimal("1"):
        raise ValidationError(
            "An LN2 sub-slot holds exactly one unit", code="subslot_qty_not_one"
        )
    occupied = await loc_repo.node_has_any_allocations(db, node.id)
    if occupied:
        if not override:
            raise ConflictError(
                "Sub-slot is already occupied", code="subslot_occupied"
            )
        # Override requires the elevated permission.
        if not has_permission(role, "inventory", "sign"):
            raise ValidationError(
                "Overriding an occupied sub-slot requires elevated permission",
                code="override_not_permitted",
            )


@alloc_router.post(
    "/place",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Place (map) a lot into a destination node (§8 destination mapping)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def place_lot(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: PlaceRequest,
) -> AllocationRead:
    lot_uuid = _parse_uuid(payload.lot_id, field="lot_id")
    lot = await inv_repo.get_lot(db, lot_uuid)
    if lot is None:
        raise NotFoundError(f"Lot {payload.lot_id} not found")

    node = await _resolve_storage_node(db, payload.node_id)
    await _check_subslot_capacity(
        db, node=node, qty=payload.qty, override=payload.override, role=current.role
    )

    alloc = await loc_repo.create_allocation(
        db,
        lot_id=lot_uuid,
        location_node_id=node.id,
        qty=payload.qty,
        created_by_user_id=current.id,
        notes=payload.notes,
    )
    await loc_repo.record_movement(
        db,
        lot_id=lot_uuid,
        movement_kind="place",
        qty=payload.qty,
        performed_by_user_id=current.id,
        to_node_id=node.id,
        notes=payload.notes,
    )
    response = _alloc_to_read(alloc)
    await db.commit()
    return response


@alloc_router.post(
    "/transfer",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Transfer a quantity from one allocation to another node (§9)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def transfer_allocation(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferRequest,
) -> AllocationRead:
    alloc_uuid = _parse_uuid(payload.allocation_id, field="allocation_id")
    alloc = await loc_repo.get_allocation(db, alloc_uuid)
    if alloc is None or not alloc.is_active:
        raise NotFoundError(f"Active allocation {payload.allocation_id} not found")

    to_node = await _resolve_storage_node(db, payload.to_node_id)
    if to_node.id == alloc.location_node_id:
        raise ValidationError(
            "Source and destination are the same location",
            code="transfer_same_location",
        )
    if payload.qty > alloc.qty:
        raise ValidationError(
            f"Requested {payload.qty} exceeds allocated {alloc.qty}",
            code="transfer_exceeds_allocation",
        )
    await _check_subslot_capacity(
        db, node=to_node, qty=payload.qty, override=payload.override, role=current.role
    )

    from_node_id = alloc.location_node_id
    await loc_repo.reduce_allocation(db, allocation=alloc, qty=payload.qty)
    dest = await loc_repo.create_allocation(
        db,
        lot_id=alloc.lot_id,
        location_node_id=to_node.id,
        qty=payload.qty,
        created_by_user_id=current.id,
        notes=payload.notes,
    )
    await loc_repo.record_movement(
        db,
        lot_id=alloc.lot_id,
        movement_kind="transfer",
        qty=payload.qty,
        performed_by_user_id=current.id,
        from_node_id=from_node_id,
        to_node_id=to_node.id,
        notes=payload.notes,
    )
    response = _alloc_to_read(dest)
    await db.commit()
    return response


@alloc_router.post(
    "/consume",
    response_model=AllocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Consume a quantity out of an allocation (location → OUT, §9)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def consume_allocation(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ConsumeRequest,
) -> AllocationRead:
    alloc_uuid = _parse_uuid(payload.allocation_id, field="allocation_id")
    alloc = await loc_repo.get_allocation(db, alloc_uuid)
    if alloc is None or not alloc.is_active:
        raise NotFoundError(f"Active allocation {payload.allocation_id} not found")
    if payload.qty > alloc.qty:
        raise ValidationError(
            f"Requested {payload.qty} exceeds allocated {alloc.qty}",
            code="consume_exceeds_allocation",
        )
    from_node_id = alloc.location_node_id
    updated = await loc_repo.reduce_allocation(db, allocation=alloc, qty=payload.qty)
    await loc_repo.record_movement(
        db,
        lot_id=alloc.lot_id,
        movement_kind="consume",
        qty=payload.qty,
        performed_by_user_id=current.id,
        from_node_id=from_node_id,
        notes=payload.notes,
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
    response_model=list[MovementRead],
    summary="Place/transfer/consume history (filter by lot or node)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_allocation_movements(
    db: DBSession,
    lot_id: Annotated[uuid.UUID | None, Query()] = None,
    node_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MovementRead]:
    rows = await loc_repo.list_movements(
        db, lot_id=lot_id, node_id=node_id, limit=limit, offset=offset
    )
    # Resolve node names in one pass for the from/to columns.
    node_ids = {m.from_node_id for m in rows if m.from_node_id} | {
        m.to_node_id for m in rows if m.to_node_id
    }
    names: dict[uuid.UUID, str] = {}
    for nid in node_ids:
        n = await loc_repo.get_node(db, nid)
        if n is not None:
            names[nid] = n.name
    return [_movement_to_read(m, names) for m in rows]
