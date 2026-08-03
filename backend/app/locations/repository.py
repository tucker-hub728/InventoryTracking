"""Persistence + engine for the location system.

Routes orchestrate and validate; this module owns the queries and the
small amount of structural logic (sibling lookups, occupancy checks,
subtree walks). The strict parent-type rules themselves live as data in
:data:`app.models.locations.PARENT_OF` and are enforced by the route layer
using :func:`get_node` + :data:`PARENT_OF`.
"""

from __future__ import annotations

import re
import uuid
from decimal import Decimal

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError
from app.core.search import like_contains
from app.models.inventory import Item, ItemPrefix, Lot, StockMovement
from app.models.locations import (
    LocationNode,
    LotAllocation,
)
from app.models.products import Customer

# ── Nodes ───────────────────────────────────────────────────────────────


async def get_node(session: AsyncSession, node_id: uuid.UUID) -> LocationNode | None:
    return (
        await session.execute(select(LocationNode).where(LocationNode.id == node_id))
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


def _slugify_area_code(name: str) -> str:
    """A ``PROD-`` code derived from an area name — uppercased, non-alphanumerics
    collapsed to dashes (e.g. "Suite A" → ``PROD-SUITE-A``). Capped at 64 chars
    to fit ``location_nodes.code``."""
    slug = re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-") or "AREA"
    return f"PROD-{slug}"[:64]


async def create_production_area(
    session: AsyncSession, *, name: str, created_by_user_id: uuid.UUID
) -> LocationNode:
    """Create one Production area: a ``flat`` node tagged ``flat_category='production'``,
    a parent-less root (the production areas ARE the sub-locations of the Production
    group; the group itself is the ``production`` category, not a tree node).

    The ``code`` is derived from ``name`` and de-duplicated against existing roots
    (``-2``, ``-3`` … on collision). Bypasses the strict ``PARENT_OF`` engine on
    purpose — ``flat`` is retired for general creation, but a production area is a
    deliberate, admin-only exception (SRS 2026-07-22). Caller commits."""
    base = _slugify_area_code(name)
    code = base
    n = 2
    while await get_sibling_by_code(session, parent_id=None, code=code) is not None:
        suffix = f"-{n}"
        code = f"{base[: 64 - len(suffix)]}{suffix}"
        n += 1
    return await create_node(
        session,
        node_type="flat",
        code=code,
        name=name,
        created_by_user_id=created_by_user_id,
        parent_id=None,
        flat_category="production",
    )


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
            select(func.count()).select_from(LocationNode).where(LocationNode.parent_id == node_id)
        )
    ).scalar_one()
    return int(n)


async def count_children_by_type(
    session: AsyncSession, *, parent_id: uuid.UUID, node_type: str
) -> int:
    """How many children of one type a node has — including INACTIVE ones.

    Backs the four-quadrants-per-tank cap (REQ-2026-07-15-LOC-001). Deactivated
    quadrants are counted on purpose: a retired quadrant still occupies one of
    the tank's four physical corners, and its code stays reserved by the sibling
    uniqueness constraint, so excluding it would let a tank grow a fifth.
    """
    n = (
        await session.execute(
            select(func.count())
            .select_from(LocationNode)
            .where(
                LocationNode.parent_id == parent_id,
                LocationNode.node_type == node_type,
            )
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


async def update_node_name(session: AsyncSession, *, node: LocationNode, name: str) -> LocationNode:
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


async def max_occupied_cell(session: AsyncSession, node_id: uuid.UUID) -> tuple[int, int]:
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
    session: AsyncSession, allocation_id: uuid.UUID, *, for_update: bool = False
) -> LotAllocation | None:
    """Fetch one allocation.

    Pass ``for_update=True`` when the caller is about to CHANGE the quantity.
    It takes a row lock so a concurrent mutation of the same allocation waits
    here rather than racing between the availability check and the write
    (VR-004). Read-only callers — list views, reports — leave it False so the
    UI never blocks on an operator's in-flight transaction.
    """
    stmt = select(LotAllocation).where(LotAllocation.id == allocation_id)
    if for_update:
        stmt = stmt.with_for_update(of=LotAllocation)
    return (await session.execute(stmt)).scalar_one_or_none()


async def active_allocations_at_node(
    session: AsyncSession, node_id: uuid.UUID, *, for_update: bool = False
) -> list[LotAllocation]:
    """Active allocations at a node. See :func:`get_allocation` for
    ``for_update`` — set it whenever the result feeds a quantity change."""
    stmt = select(LotAllocation).where(
        LotAllocation.location_node_id == node_id,
        LotAllocation.is_active.is_(True),
    )
    if for_update:
        stmt = stmt.with_for_update(of=LotAllocation)
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


async def node_has_movement_history(session: AsyncSession, node_id: uuid.UUID) -> bool:
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


async def sum_active_alloc_qty_for_lot(session: AsyncSession, lot_id: uuid.UUID) -> Decimal:
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


async def sum_received_qty_for_lot(session: AsyncSession, lot_id: uuid.UUID) -> Decimal:
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
    """A location can be dedicated to a finished-good (built) item now."""
    return (
        await session.execute(
            select(Item.id).where(Item.id == product_id, Item.deleted_at.is_(None))
        )
    ).first() is not None


async def list_lot_allocations(
    session: AsyncSession, lot_id: uuid.UUID, *, active_only: bool = True
) -> list[LotAllocation]:
    stmt = select(LotAllocation).where(LotAllocation.lot_id == lot_id)
    if active_only:
        stmt = stmt.where(LotAllocation.is_active.is_(True))
    stmt = stmt.order_by(LotAllocation.created_at)
    return list((await session.execute(stmt)).scalars().unique().all())


async def search_stored_stock(
    session: AsyncSession, *, query: str, limit: int = 400
) -> list[LotAllocation]:
    """Active allocations whose LOT NUMBER, ITEM NUMBER or ITEM NAME matches.

    Backs "where is this stock" in the storage-hierarchy search: one call answers
    which nodes hold it, instead of resolving ids first and then asking per node.
    ``GET /lots`` cannot do this — it filters only by item and status.

    Three things are matched, because an operator looking for stock knows any one
    of them and shouldn't have to know which the box is labelled with:

      * ``lots.lot_number``           — "PL-301-07"
      * the item number               — "CR-301". DERIVED, not stored: it is
        ``prefix.code || '-' || items.sku_suffix``, so the concatenation has to
        happen in SQL. Matching ``sku_suffix`` alone would miss "CR-301" and
        matching the prefix alone would return the entire tier.
      * ``items.description``         — the item's name, "Protein 301"

    ``%``, ``_`` and ``\\`` in the operator's text are escaped, so a value that
    genuinely contains one is matched literally rather than read as a wildcard
    that returns everything in the building.
    """
    pattern = like_contains(query.lower())
    item_number = func.concat(ItemPrefix.code, "-", Item.sku_suffix)
    stmt = (
        select(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .join(Item, Item.id == Lot.item_id)
        .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
        .where(LotAllocation.is_active.is_(True))
        .where(
            or_(
                func.lower(Lot.lot_number).like(pattern, escape="\\"),
                func.lower(item_number).like(pattern, escape="\\"),
                func.lower(Item.description).like(pattern, escape="\\"),
            )
        )
        .order_by(Lot.lot_number, LotAllocation.created_at)
        .limit(limit)
    )
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


async def create_or_merge_allocation(
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
    """Place ``qty`` of a lot at a node, MERGING into an existing active
    allocation of the same lot when the placement is bulk (non-grid).

    A shelf can legally hold many allocations of one lot, but showing the same
    (item, lot) as several rows is confusing — so a bulk placement adds to the
    lot's existing row instead of opening another. Grid (box cell) placements
    always create a fresh row: a cell holds exactly one unit and is
    single-occupancy (``uq_lot_allocations_cell``), so they must never merge.
    """
    if grid_row is None and grid_col is None:
        existing = (
            (
                await session.execute(
                    select(LotAllocation)
                    .where(
                        LotAllocation.lot_id == lot_id,
                        LotAllocation.location_node_id == location_node_id,
                        LotAllocation.grid_row.is_(None),
                        LotAllocation.grid_col.is_(None),
                        LotAllocation.is_active.is_(True),
                    )
                    .order_by(LotAllocation.created_at.asc())
                    .limit(1)
                    # Lock the row we are about to merge into, so two
                    # concurrent receipts of the same lot at the same shelf
                    # queue instead of both reading the same starting value.
                    .with_for_update(of=LotAllocation)
                )
            )
            .scalars()
            .first()
        )
        if existing is not None:
            # Add in SQL, not Python. A lost update here would DESTROY stock
            # (two receipts of 10 landing as +10 instead of +20) — the mirror
            # image of the reduce_allocation bug, and just as invisible.
            await session.flush()
            await session.execute(
                update(LotAllocation)
                .where(LotAllocation.id == existing.id)
                .values(qty=LotAllocation.qty + qty)
            )
            await session.refresh(existing)
            return existing
    return await create_allocation(
        session,
        lot_id=lot_id,
        location_node_id=location_node_id,
        qty=qty,
        created_by_user_id=created_by_user_id,
        grid_row=grid_row,
        grid_col=grid_col,
        notes=notes,
    )


async def reduce_allocation(
    session: AsyncSession, *, allocation: LotAllocation, qty: Decimal
) -> LotAllocation:
    """Subtract ``qty`` from an allocation, deactivating it when it hits 0.

    The 0-qty deactivated row is kept (CHECK is ``qty >= 0``) so the split
    history survives; the append-only movement log records the operation.

    **Concurrency (VR-004).** This used to be a read-modify-write in Python
    (``allocation.qty = allocation.qty - qty``), which loses updates. Two
    requests issuing 3 from a box of 5 both read 5, both computed 2, and both
    wrote 2 — six units left a box that held five, and the ``qty >= 0`` CHECK
    saw nothing wrong because 2 is a perfectly legal value.

    The subtraction now happens *in the database* under a guard:

        UPDATE ... SET qty = qty - :qty WHERE id = :id AND qty >= :qty

    Postgres serialises concurrent UPDATEs of the same row, so the second one
    re-evaluates ``qty >= :qty`` against the value the first one committed.
    If it no longer holds, zero rows match and we raise instead of silently
    corrupting the balance. This is the guarantee; the ``FOR UPDATE`` on the
    availability reads is a courtesy that turns most conflicts into a short
    wait rather than an error the operator sees.
    """
    if qty <= 0:
        # Nothing to do, and a non-positive guard would make the WHERE clause
        # meaningless (every row satisfies ``qty >= 0``).
        return allocation

    # Flush pending ORM state first so the Core UPDATE below doesn't race a
    # dirty in-session copy of this same row.
    await session.flush()

    stmt = (
        update(LotAllocation)
        .where(LotAllocation.id == allocation.id, LotAllocation.qty >= qty)
        .values(qty=LotAllocation.qty - qty)
        .returning(LotAllocation.qty)
    )
    new_qty = (await session.execute(stmt)).scalar_one_or_none()

    if new_qty is None:
        # Either the row vanished or someone else drew it down below ``qty``
        # between our availability check and here. Both are the same story to
        # the caller: re-read and try again.
        raise ConflictError(
            "Stock at this location changed while you were working. "
            "Refresh and try again.",
            code="stock_conflict",
            details={"allocation_id": str(allocation.id), "requested": str(qty)},
        )

    if new_qty <= 0:
        # Empty now — retire the row but keep it for the split history.
        await session.execute(
            update(LotAllocation)
            .where(LotAllocation.id == allocation.id)
            .values(qty=Decimal("0"), is_active=False)
        )

    # The ORM copy is stale after a Core UPDATE; re-sync it so callers that
    # read ``allocation.qty`` afterwards (ledger rows, responses) see truth.
    await session.refresh(allocation)
    return allocation


async def is_descendant_of(
    session: AsyncSession, *, ancestor_id: uuid.UUID, candidate_id: uuid.UUID
) -> bool:
    """True if ``candidate_id`` sits anywhere beneath ``ancestor_id``.

    The cycle guard for a re-hang: dropping a node onto one of its own
    descendants would detach that whole branch from every root, and the
    recursive tree walks would then never reach it.
    """
    row = await session.execute(
        text(
            """
            WITH RECURSIVE down AS (
                SELECT id FROM meta.location_nodes WHERE id = :ancestor
              UNION ALL
                SELECT n.id
                FROM meta.location_nodes n
                JOIN down ON n.parent_id = down.id
            )
            SELECT EXISTS (SELECT 1 FROM down WHERE id = :candidate)
            """
        ),
        {"ancestor": ancestor_id, "candidate": candidate_id},
    )
    return bool(row.scalar_one())


async def move_node(
    session: AsyncSession, *, node: LocationNode, new_parent_id: uuid.UUID
) -> LocationNode:
    """Re-hang a node under a new parent. Its whole subtree comes along.

    Only ``parent_id`` changes. Nothing beneath is rewritten and no stock is
    touched: children point at their parent, and an allocation points at its
    box's id — never at a path — so every descendant's address recomputes
    itself. That downhill ripple is what makes it a re-CASCADE.
    """
    node.parent_id = new_parent_id
    await session.flush()
    await session.refresh(node)
    return node


async def node_path_text(
    session: AsyncSession, node_id: uuid.UUID | None
) -> str | None:
    """Root-to-leaf display address, e.g. ``Tank 2 / Quadrant 1 / Rack 1 / Box 1``.

    Walks parents in one recursive query. Used to freeze the address onto a
    ledger row at write time (see ``StockMovement.from_location_path``), so a
    later re-hang of a node cannot rewrite where history says material was.

    Returns ``None`` for ``None`` — callers pass the possibly-absent side of a
    one-sided movement straight through.
    """
    if node_id is None:
        return None
    row = await session.execute(
        text(
            """
            WITH RECURSIVE up AS (
                SELECT id, parent_id, name, 0 AS depth
                FROM meta.location_nodes
                WHERE id = :node_id
              UNION ALL
                SELECT n.id, n.parent_id, n.name, up.depth + 1
                FROM meta.location_nodes n
                JOIN up ON n.id = up.parent_id
            )
            SELECT string_agg(name, ' / ' ORDER BY depth DESC) FROM up
            """
        ),
        {"node_id": node_id},
    )
    return row.scalar_one_or_none()


async def node_paths(
    session: AsyncSession,
    *,
    from_node_id: uuid.UUID | None,
    to_node_id: uuid.UUID | None,
) -> tuple[str | None, str | None]:
    """Both sides of a movement's frozen address, in one call."""
    return (
        await node_path_text(session, from_node_id),
        await node_path_text(session, to_node_id),
    )


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
        to_location_path=await node_path_text(session, to_location_node_id),
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
    from_path, to_path = await node_paths(
        session, from_node_id=from_location_node_id, to_node_id=to_location_node_id
    )
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=to_location_node_id,
        from_location_path=from_path,
        to_location_path=to_path,
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


async def create_node_shipment_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_node_id: uuid.UUID,
    qty: int,
    performed_by_user_id: uuid.UUID,
    customer_id: uuid.UUID | None = None,
    reference_number: str | None = None,
    reauth_evidence_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> StockMovement:
    """Ship a finished good OUT to a customer — the terminal transaction
    (REQ-2026-07-22-CUST-001 / 07-01 TRX-005). Unit-out from the source node with
    **no destination**: stock leaves the system. ``customer_id`` is optional — a
    named customer honours CUST-001, ``None`` is the catalog / unassigned
    shipment (TRX-007). ``reference_number`` is the free-text tracking / sales
    number (TRX-005). Only the finished good's own stock changes; there is no
    cascade to component inventory (TRX-006)."""
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=None,
        from_location_path=await node_path_text(session, from_location_node_id),
        movement_type="customer_shipment",
        qty_delta=-qty,
        qty_abs=qty,
        customer_id=customer_id,
        reference_number=reference_number,
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
    # Both legs carry BOTH addresses: each row on its own then says where the
    # material came from and where it went, without having to find its partner.
    from_path, to_path = await node_paths(
        session, from_node_id=from_location_node_id, to_node_id=to_location_node_id
    )
    out_leg = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=None,
        from_location_path=from_path,
        to_location_path=to_path,
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
        from_location_path=from_path,
        to_location_path=to_path,
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
    stmt = stmt.order_by(StockMovement.performed_at.desc()).limit(limit).offset(offset)
    return list((await session.execute(stmt)).scalars().unique().all())
