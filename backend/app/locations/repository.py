"""Persistence + engine for the location system.

Routes orchestrate and validate; this module owns the queries and the
small amount of structural logic (sibling lookups, occupancy checks,
subtree walks). The strict parent-type rules themselves live as data in
:data:`app.models.locations.PARENT_OF` and are enforced by the route layer
using :func:`get_node` + :data:`PARENT_OF`.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.locations import (
    AllocationMovement,
    LocationNode,
    LotAllocation,
)

# ── Nodes ───────────────────────────────────────────────────────────────


async def get_node(session: AsyncSession, node_id: uuid.UUID) -> LocationNode | None:
    return (
        await session.execute(
            select(LocationNode).where(LocationNode.id == node_id)
        )
    ).scalar_one_or_none()


async def get_sibling_by_code(
    session: AsyncSession, *, parent_id: uuid.UUID | None, code: str
) -> LocationNode | None:
    """Find a sibling (same parent) with the same code, case-insensitive.

    Mirrors the ``uq_location_nodes_parent_code`` constraint and also
    covers the root case (parent_id IS NULL), which the unique constraint
    can't (NULLs are distinct).
    """
    stmt = select(LocationNode).where(func.lower(LocationNode.code) == code.lower())
    if parent_id is None:
        stmt = stmt.where(LocationNode.parent_id.is_(None))
    else:
        stmt = stmt.where(LocationNode.parent_id == parent_id)
    return (await session.execute(stmt)).scalars().first()


async def create_node(
    session: AsyncSession,
    *,
    node_type: str,
    code: str,
    name: str,
    created_by_user_id: uuid.UUID,
    parent_id: uuid.UUID | None = None,
    flat_category: str | None = None,
    notes: str | None = None,
) -> LocationNode:
    """Insert a node. Caller has already validated the hierarchy. Commits."""
    node = LocationNode(
        node_type=node_type,
        code=code.strip(),
        name=name.strip(),
        parent_id=parent_id,
        flat_category=flat_category,
        notes=notes,
        created_by_user_id=created_by_user_id,
    )
    session.add(node)
    await session.flush()
    refreshed = await get_node(session, node.id)
    assert refreshed is not None
    return refreshed


async def list_roots(
    session: AsyncSession,
    *,
    node_type: str | None = None,
    active_only: bool = True,
) -> list[LocationNode]:
    """Top-level nodes (tank_quadrant + flat). Optionally filter by type."""
    stmt = select(LocationNode).where(LocationNode.parent_id.is_(None))
    if node_type is not None:
        stmt = stmt.where(LocationNode.node_type == node_type)
    if active_only:
        stmt = stmt.where(LocationNode.is_active.is_(True))
    stmt = stmt.order_by(LocationNode.node_type, func.lower(LocationNode.name))
    return list((await session.execute(stmt)).scalars().all())


async def list_nodes_by_types(
    session: AsyncSession, types: tuple[str, ...], *, active_only: bool = True
) -> list[LocationNode]:
    """All nodes whose ``node_type`` is in ``types`` (one query, for tree build)."""
    stmt = select(LocationNode).where(LocationNode.node_type.in_(types))
    if active_only:
        stmt = stmt.where(LocationNode.is_active.is_(True))
    stmt = stmt.order_by(func.lower(LocationNode.code))
    return list((await session.execute(stmt)).scalars().all())


async def count_children(session: AsyncSession, node_id: uuid.UUID) -> int:
    n = (
        await session.execute(
            select(func.count())
            .select_from(LocationNode)
            .where(LocationNode.parent_id == node_id)
        )
    ).scalar_one()
    return int(n)


async def count_active_allocations(session: AsyncSession, node_id: uuid.UUID) -> int:
    n = (
        await session.execute(
            select(func.count())
            .select_from(LotAllocation)
            .where(
                LotAllocation.location_node_id == node_id,
                LotAllocation.is_active.is_(True),
            )
        )
    ).scalar_one()
    return int(n)


async def list_children(
    session: AsyncSession, parent_id: uuid.UUID, *, active_only: bool = True
) -> list[LocationNode]:
    stmt = select(LocationNode).where(LocationNode.parent_id == parent_id)
    if active_only:
        stmt = stmt.where(LocationNode.is_active.is_(True))
    stmt = stmt.order_by(func.lower(LocationNode.code))
    return list((await session.execute(stmt)).scalars().all())


async def list_flat(
    session: AsyncSession,
    *,
    flat_category: str | None = None,
    active_only: bool = True,
) -> list[LocationNode]:
    stmt = select(LocationNode).where(LocationNode.node_type == "flat")
    if flat_category is not None:
        stmt = stmt.where(LocationNode.flat_category == flat_category)
    if active_only:
        stmt = stmt.where(LocationNode.is_active.is_(True))
    stmt = stmt.order_by(LocationNode.flat_category, func.lower(LocationNode.name))
    return list((await session.execute(stmt)).scalars().all())


async def node_has_children(session: AsyncSession, node_id: uuid.UUID) -> bool:
    stmt = select(LocationNode.id).where(LocationNode.parent_id == node_id).limit(1)
    return (await session.execute(stmt)).first() is not None


async def soft_delete_node(session: AsyncSession, *, node: LocationNode) -> LocationNode:
    """Soft delete via ``is_active=false``. Caller enforces block rules. Commits."""
    node.is_active = False
    await session.flush()
    return node


def node_to_audit_snapshot(node: LocationNode) -> dict[str, object | None]:
    return {
        "node_type": node.node_type,
        "code": node.code,
        "name": node.name,
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "flat_category": node.flat_category,
        "is_active": node.is_active,
    }


# ── Allocations ─────────────────────────────────────────────────────────


async def get_allocation(
    session: AsyncSession, allocation_id: uuid.UUID
) -> LotAllocation | None:
    return (
        await session.execute(
            select(LotAllocation).where(LotAllocation.id == allocation_id)
        )
    ).scalar_one_or_none()


async def active_allocations_at_node(
    session: AsyncSession, node_id: uuid.UUID
) -> list[LotAllocation]:
    stmt = select(LotAllocation).where(
        LotAllocation.location_node_id == node_id,
        LotAllocation.is_active.is_(True),
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def node_has_any_allocations(session: AsyncSession, node_id: uuid.UUID) -> bool:
    stmt = (
        select(LotAllocation.id)
        .where(
            LotAllocation.location_node_id == node_id,
            LotAllocation.is_active.is_(True),
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def node_has_movement_history(
    session: AsyncSession, node_id: uuid.UUID
) -> bool:
    stmt = (
        select(AllocationMovement.id)
        .where(
            or_(
                AllocationMovement.from_node_id == node_id,
                AllocationMovement.to_node_id == node_id,
            )
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def list_lot_allocations(
    session: AsyncSession, lot_id: uuid.UUID, *, active_only: bool = True
) -> list[LotAllocation]:
    stmt = select(LotAllocation).where(LotAllocation.lot_id == lot_id)
    if active_only:
        stmt = stmt.where(LotAllocation.is_active.is_(True))
    stmt = stmt.order_by(LotAllocation.created_at)
    return list((await session.execute(stmt)).scalars().unique().all())


async def create_allocation(
    session: AsyncSession,
    *,
    lot_id: uuid.UUID,
    location_node_id: uuid.UUID,
    qty: Decimal,
    created_by_user_id: uuid.UUID,
    notes: str | None = None,
) -> LotAllocation:
    alloc = LotAllocation(
        lot_id=lot_id,
        location_node_id=location_node_id,
        qty=qty,
        created_by_user_id=created_by_user_id,
        notes=notes,
    )
    session.add(alloc)
    await session.flush()
    refreshed = await get_allocation(session, alloc.id)
    assert refreshed is not None
    return refreshed


async def reduce_allocation(
    session: AsyncSession, *, allocation: LotAllocation, qty: Decimal
) -> LotAllocation:
    """Subtract ``qty`` from an allocation, deactivating it when it hits 0.

    The 0-qty deactivated row is kept (CHECK is ``qty >= 0``) so the split
    history survives; the append-only movement log records the operation.
    """
    allocation.qty = allocation.qty - qty
    if allocation.qty <= 0:
        allocation.qty = Decimal("0")
        allocation.is_active = False
    await session.flush()
    return allocation


async def record_movement(
    session: AsyncSession,
    *,
    lot_id: uuid.UUID,
    movement_kind: str,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    from_node_id: uuid.UUID | None = None,
    to_node_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> AllocationMovement:
    """Append one immutable place/transfer/consume row. Caller commits."""
    mv = AllocationMovement(
        lot_id=lot_id,
        movement_kind=movement_kind,
        qty=qty,
        from_node_id=from_node_id,
        to_node_id=to_node_id,
        notes=notes,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(mv)
    await session.flush()
    return mv


async def list_movements(
    session: AsyncSession,
    *,
    lot_id: uuid.UUID | None = None,
    node_id: uuid.UUID | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[AllocationMovement]:
    stmt = select(AllocationMovement)
    if lot_id is not None:
        stmt = stmt.where(AllocationMovement.lot_id == lot_id)
    if node_id is not None:
        stmt = stmt.where(
            or_(
                AllocationMovement.from_node_id == node_id,
                AllocationMovement.to_node_id == node_id,
            )
        )
    stmt = (
        stmt.order_by(AllocationMovement.performed_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list((await session.execute(stmt)).scalars().unique().all())
