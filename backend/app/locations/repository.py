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

from app.models.inventory import StockMovement
from app.models.locations import (
    LocationNode,
    LotAllocation,
)
from app.models.products import Customer, Product

# ── Nodes ───────────────────────────────────────────────────────────────


async def get_node(session: AsyncSession, node_id: uuid.UUID) -> LocationNode | None:
    return (
        await session.execute(
            select(LocationNode).where(LocationNode.id == node_id)
        )
    ).scalar_one_or_none()


async def node_label_map(
    session: AsyncSession,
) -> dict[uuid.UUID, tuple[str, str]]:
    """``id → (name, path)`` for every node — for the ledger Location column.

    ``path`` is the human breadcrumb from the root to the node
    (``"Q1 › R01 › C01 › Box 01"``). The location tree is small, so one query
    + an in-memory parent walk is cheap and avoids per-row lookups.
    """
    nodes = list((await session.execute(select(LocationNode))).scalars().all())
    by_id = {n.id: n for n in nodes}

    def path_for(node: LocationNode) -> str:
        parts: list[str] = []
        cur: LocationNode | None = node
        seen: set[uuid.UUID] = set()
        while cur is not None and cur.id not in seen:
            parts.append(cur.name)
            seen.add(cur.id)
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        return " › ".join(reversed(parts))

    return {n.id: (n.name, path_for(n)) for n in nodes}


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
    grid_rows: int | None = None,
    grid_cols: int | None = None,
    dedicated_customer_id: uuid.UUID | None = None,
    dedicated_product_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> LocationNode:
    """Insert a node. Caller has already validated the hierarchy. Commits."""
    node = LocationNode(
        node_type=node_type,
        code=code.strip(),
        name=name.strip(),
        parent_id=parent_id,
        flat_category=flat_category,
        grid_rows=grid_rows,
        grid_cols=grid_cols,
        dedicated_customer_id=dedicated_customer_id,
        dedicated_product_id=dedicated_product_id,
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


async def active_allocation_counts_by_node(
    session: AsyncSession,
) -> dict[uuid.UUID, int]:
    """``node_id → active-allocation count`` for every storing node (one query).

    Used to populate ``active_allocation_count`` across the LN2 tree in a
    single pass — the per-node :func:`count_active_allocations` would be one
    query per node.
    """
    rows = await session.execute(
        select(LotAllocation.location_node_id, func.count())
        .where(LotAllocation.is_active.is_(True))
        .group_by(LotAllocation.location_node_id)
    )
    return {node_id: int(n) for node_id, n in rows.all()}


async def active_allocation_units_by_node(
    session: AsyncSession,
) -> dict[uuid.UUID, int]:
    """``node_id → total active units (SUM qty)`` for every storing node.

    For flat bins, occupancy is the number of units held (one allocation may
    carry many), not the row count — so this sums ``qty`` rather than counting
    rows.
    """
    rows = await session.execute(
        select(
            LotAllocation.location_node_id,
            func.coalesce(func.sum(LotAllocation.qty), 0),
        )
        .where(LotAllocation.is_active.is_(True))
        .group_by(LotAllocation.location_node_id)
    )
    return {node_id: int(total) for node_id, total in rows.all()}


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
        "grid_rows": node.grid_rows,
        "grid_cols": node.grid_cols,
        "dedicated_customer_id": (
            str(node.dedicated_customer_id) if node.dedicated_customer_id else None
        ),
        "dedicated_product_id": (
            str(node.dedicated_product_id) if node.dedicated_product_id else None
        ),
        "is_active": node.is_active,
    }


async def update_node_name(
    session: AsyncSession, *, node: LocationNode, name: str
) -> LocationNode:
    """Rename a node (the user-facing label; ``code`` identity is unchanged).
    Caller commits."""
    node.name = name
    await session.flush()
    return node


async def update_node_grid(
    session: AsyncSession, *, node: LocationNode, grid_rows: int, grid_cols: int
) -> LocationNode:
    """Set a Box's grid dimensions. Caller validates type / occupancy. Commits
    handled by caller."""
    node.grid_rows = grid_rows
    node.grid_cols = grid_cols
    await session.flush()
    return node


async def update_node_dedication(
    session: AsyncSession,
    *,
    node: LocationNode,
    customer_id: uuid.UUID | None,
    product_id: uuid.UUID | None,
) -> LocationNode:
    """Set / clear a quadrant's dedication. Caller validates the quadrant +
    exclusivity. Caller commits."""
    node.dedicated_customer_id = customer_id
    node.dedicated_product_id = product_id
    await session.flush()
    return node


async def resolve_inherited_dedication(
    session: AsyncSession, node: LocationNode
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """Walk to the root quadrant and return its (customer_id, product_id).

    Dedication lives only on a ``tank_quadrant``; descendants inherit it.
    Returns the node's own values if it is the quadrant.
    """
    current: LocationNode | None = node
    seen: set[uuid.UUID] = set()
    while current is not None:
        if current.dedicated_customer_id or current.dedicated_product_id:
            return current.dedicated_customer_id, current.dedicated_product_id
        if current.parent_id is None or current.id in seen:
            break
        seen.add(current.id)
        current = await get_node(session, current.parent_id)
    return None, None


async def max_occupied_cell(
    session: AsyncSession, node_id: uuid.UUID
) -> tuple[int, int]:
    """Highest occupied (row, col) among a Box's active allocations.

    Returns ``(0, 0)`` when the Box is empty. Used to reject a resize that
    would orphan a placed cell.
    """
    row = (
        await session.execute(
            select(func.coalesce(func.max(LotAllocation.grid_row), 0)).where(
                LotAllocation.location_node_id == node_id,
                LotAllocation.is_active.is_(True),
            )
        )
    ).scalar_one()
    col = (
        await session.execute(
            select(func.coalesce(func.max(LotAllocation.grid_col), 0)).where(
                LotAllocation.location_node_id == node_id,
                LotAllocation.is_active.is_(True),
            )
        )
    ).scalar_one()
    return int(row), int(col)


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
    """True iff the GxP ledger has a movement referencing this node.

    Movement history now lives in ``app.stock_movements`` (the location
    system no longer keeps a separate log); a node with ledger history can't
    be deleted, so its name still resolves on historical rows.
    """
    stmt = (
        select(StockMovement.id)
        .where(
            or_(
                StockMovement.from_location_node_id == node_id,
                StockMovement.to_location_node_id == node_id,
            )
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def get_active_cell_occupant(
    session: AsyncSession,
    *,
    node_id: uuid.UUID,
    grid_row: int,
    grid_col: int,
) -> LotAllocation | None:
    """The active allocation in a specific Box cell, if any (occupancy check)."""
    stmt = select(LotAllocation).where(
        LotAllocation.location_node_id == node_id,
        LotAllocation.grid_row == grid_row,
        LotAllocation.grid_col == grid_col,
        LotAllocation.is_active.is_(True),
    )
    return (await session.execute(stmt)).scalars().first()


async def sum_active_alloc_qty_for_lot(
    session: AsyncSession, lot_id: uuid.UUID
) -> Decimal:
    """Total currently-placed quantity of a lot across all nodes (capacity)."""
    total = (
        await session.execute(
            select(func.coalesce(func.sum(LotAllocation.qty), 0)).where(
                LotAllocation.lot_id == lot_id,
                LotAllocation.is_active.is_(True),
            )
        )
    ).scalar_one()
    return Decimal(total)


async def sum_received_qty_for_lot(
    session: AsyncSession, lot_id: uuid.UUID
) -> Decimal:
    """Total quantity ever placed (unit-IN) for a lot — the lifetime cap base.

    Sums the append-only ``receipt`` movements (the only source of unit-IN;
    ``place`` is the sole writer). Unlike the active-allocation sum, this does
    NOT shrink when a unit is consumed (the dispense is a separate row), so
    consumed units keep counting against ``ordered_qty`` and can't be re-placed.
    """
    total = (
        await session.execute(
            select(func.coalesce(func.sum(StockMovement.qty_delta), 0)).where(
                StockMovement.lot_id == lot_id,
                StockMovement.movement_type == "receipt",
            )
        )
    ).scalar_one()
    return Decimal(total)


async def lot_on_hand(session: AsyncSession, lot_id: uuid.UUID) -> Decimal:
    """Ledger on-hand for a lot — SUM(qty_delta) over its stock movements."""
    total = (
        await session.execute(
            select(func.coalesce(func.sum(StockMovement.qty_delta), 0)).where(
                StockMovement.lot_id == lot_id
            )
        )
    ).scalar_one()
    return Decimal(total)


async def customer_exists(session: AsyncSession, customer_id: uuid.UUID) -> bool:
    return (
        await session.execute(select(Customer.id).where(Customer.id == customer_id))
    ).first() is not None


async def product_exists(session: AsyncSession, product_id: uuid.UUID) -> bool:
    return (
        await session.execute(select(Product.id).where(Product.id == product_id))
    ).first() is not None


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
    grid_row: int | None = None,
    grid_col: int | None = None,
    notes: str | None = None,
) -> LotAllocation:
    alloc = LotAllocation(
        lot_id=lot_id,
        location_node_id=location_node_id,
        qty=qty,
        grid_row=grid_row,
        grid_col=grid_col,
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


# ── Ledger writers (consume / transfer go to app.stock_movements) ───────
#
# The location system no longer keeps its own movement log: quantity-changing
# operations are written to the GxP ledger so on-hand reconciles. These build
# node-referenced rows (the legacy ``meta.locations`` columns stay NULL) — the
# widened ``ck_movements_locations`` accepts exactly one location kind per
# occupied side. Caller commits.


async def create_node_receipt_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    to_location_node_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> StockMovement:
    """A unit-IN into a node cell/location: ``receipt`` row (+qty)."""
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=None,
        to_location_node_id=to_location_node_id,
        movement_type="receipt",
        qty_delta=qty,
        qty_abs=qty,
        notes=notes,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    return movement


async def create_node_dispense_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_node_id: uuid.UUID,
    to_location_node_id: uuid.UUID,
    qty: int,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> StockMovement:
    """Consume = unit-out: a ``dispense`` row from the source node, recording
    the Flat location that consumed it as ``to_location_node_id``."""
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=to_location_node_id,
        movement_type="dispense",
        qty_delta=-qty,
        qty_abs=qty,
        notes=notes,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(movement)
    await session.flush()
    return movement


async def create_node_transfer_pair(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_node_id: uuid.UUID,
    to_location_node_id: uuid.UUID,
    qty: Decimal,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> tuple[StockMovement, StockMovement]:
    """A node→node move: ``transfer_out`` + ``transfer_in`` pair (net-zero)."""
    out_leg = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=None,
        movement_type="transfer_out",
        qty_delta=-qty,
        qty_abs=qty,
        notes=notes,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(out_leg)
    await session.flush()

    in_leg = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=None,
        to_location_node_id=to_location_node_id,
        movement_type="transfer_in",
        qty_delta=qty,
        qty_abs=qty,
        notes=notes,
        paired_movement_id=out_leg.id,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    session.add(in_leg)
    await session.flush()
    return out_leg, in_leg


async def list_node_ledger(
    session: AsyncSession,
    *,
    lot_id: uuid.UUID | None = None,
    node_id: uuid.UUID | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[StockMovement]:
    """Ledger movements touching a node (or lot) — the click-through history."""
    stmt = select(StockMovement)
    if lot_id is not None:
        stmt = stmt.where(StockMovement.lot_id == lot_id)
    if node_id is not None:
        stmt = stmt.where(
            or_(
                StockMovement.from_location_node_id == node_id,
                StockMovement.to_location_node_id == node_id,
            )
        )
    stmt = (
        stmt.order_by(StockMovement.performed_at.desc()).limit(limit).offset(offset)
    )
    return list((await session.execute(stmt)).scalars().unique().all())
