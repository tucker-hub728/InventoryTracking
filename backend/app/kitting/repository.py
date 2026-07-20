"""Kitting DB helpers — plain async functions; the route owns the transaction.

Every helper ``add`` + ``flush``-es and returns the ORM object; the caller
commits (house convention). Quantity changes are written to the append-only
``app.stock_movements`` ledger via :func:`create_kit_movement`; on-hand stays
derived through ``app.v_item_stock`` (no stock table here).
"""

from __future__ import annotations

import uuid
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload

from app.models.inventory import BomLine, Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitLine
from app.models.locations import LocationNode, LotAllocation

# ── Reads / lookups ─────────────────────────────────────────────────────


async def get_item_tier_type(session: AsyncSession, item_id: uuid.UUID) -> str | None:
    """The tier ``type`` of an item, resolved item → prefix → tier."""
    stmt = (
        select(ItemTier.type)
        .select_from(Item)
        .join(ItemPrefix, Item.prefix_id == ItemPrefix.id)
        .join(ItemTier, ItemPrefix.tier_id == ItemTier.id)
        .where(Item.id == item_id, Item.deleted_at.is_(None))
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_bom_children(session: AsyncSession, parent_item_id: uuid.UUID) -> list[BomLine]:
    """Direct BOM components of an item (one level — a kit consumes AY stock,
    it does not explode a child AY's own BOM)."""
    stmt = (
        select(BomLine)
        .where(
            BomLine.parent_item_id == parent_item_id,
            BomLine.deleted_at.is_(None),
        )
        .order_by(BomLine.created_at)
    )
    return list((await session.execute(stmt)).scalars().all())


async def default_source_node_id(session: AsyncSession) -> uuid.UUID | None:
    """A sensible default source: the first active warehouse shelf. The
    operator can override per line before issuing."""
    stmt = (
        select(LocationNode.id)
        .where(LocationNode.node_type == "shelf", LocationNode.is_active.is_(True))
        .order_by(LocationNode.code)
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def storage_node_exists(session: AsyncSession, node_id: uuid.UUID) -> bool:
    stmt = select(LocationNode.id).where(LocationNode.id == node_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def item_stock_by_node(
    session: AsyncSession, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict[uuid.UUID, int]]:
    """Per-item, per-node available stock from the Location System —
    ``{item_id: {node_id: qty}}`` over active, positive lot allocations."""
    if not item_ids:
        return {}
    stmt = (
        select(
            Lot.item_id,
            LotAllocation.location_node_id,
            func.coalesce(func.sum(LotAllocation.qty), 0),
        )
        .select_from(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
        )
        .group_by(Lot.item_id, LotAllocation.location_node_id)
    )
    out: dict[uuid.UUID, dict[uuid.UUID, int]] = {}
    for item_id, node_id, qty in (await session.execute(stmt)).all():
        out.setdefault(item_id, {})[node_id] = int(qty)
    return out


async def allocations_for_item_at_node(
    session: AsyncSession, item_id: uuid.UUID, node_id: uuid.UUID
) -> list[LotAllocation]:
    """Active allocations of an item at a node, FIFO by expiry then age —
    the consume order for a kit issue."""
    stmt = (
        select(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .where(
            Lot.item_id == item_id,
            LotAllocation.location_node_id == node_id,
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
        )
        .order_by(Lot.expiration_date.asc().nullslast(), Lot.created_at.asc())
    )
    return list((await session.execute(stmt)).scalars().unique().all())


def _kit_load() -> tuple:
    return (selectinload(Kit.lines),)


async def get_kit(session: AsyncSession, kit_id: uuid.UUID) -> Kit | None:
    stmt = (
        select(Kit)
        .where(Kit.id == kit_id, Kit.deleted_at.is_(None))
        .options(*_kit_load())
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalars().unique().one_or_none()


async def list_kits(
    session: AsyncSession,
    *,
    status: str | None,
    limit: int,
    offset: int,
) -> tuple[list[Kit], int]:
    where = [Kit.deleted_at.is_(None)]
    if status is not None:
        where.append(Kit.status == status)

    base: Select = select(Kit).where(*where)
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (
        (
            await session.execute(
                base.options(selectinload(Kit.lines))
                .order_by(Kit.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .unique()
        .all()
    )
    return list(rows), total


async def kit_movements(session: AsyncSession, kit_id: uuid.UUID) -> list[StockMovement]:
    stmt = (
        select(StockMovement)
        .where(StockMovement.kit_id == kit_id)
        .order_by(StockMovement.performed_at.desc(), StockMovement.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def load_item_map(session: AsyncSession, item_ids: set[uuid.UUID]) -> dict[uuid.UUID, Item]:
    """Items keyed by id with ``prefix`` eager-loaded, so ``item.item_number``
    (a Python property that reads ``prefix.code``) resolves without a lazy load."""
    if not item_ids:
        return {}
    stmt = select(Item).where(Item.id.in_(item_ids)).options(joinedload(Item.prefix))
    return {i.id: i for i in (await session.execute(stmt)).scalars().unique().all()}


# ── Writes (add + flush; caller commits) ────────────────────────────────


async def next_kit_number(session: AsyncSession) -> str:
    n = (await session.execute(select(func.nextval("app.kit_number_seq")))).scalar_one()
    return f"KIT-{int(n):04d}"


async def create_kit(
    session: AsyncSession,
    *,
    kit_number: str,
    item_id: uuid.UUID,
    target_qty: int,
    production_location_node_id: uuid.UUID,
    notes: str | None,
    created_by_user_id: uuid.UUID,
) -> Kit:
    kit = Kit(
        kit_number=kit_number,
        item_id=item_id,
        target_qty=target_qty,
        status="draft",
        production_location_node_id=production_location_node_id,
        notes=notes,
        created_by_user_id=created_by_user_id,
    )
    session.add(kit)
    await session.flush()
    return kit


async def add_kit_line(
    session: AsyncSession,
    *,
    kit_id: uuid.UUID,
    line_no: int,
    item_id: uuid.UUID,
    qty_per_unit: Decimal,
    issued_qty: int,
    source_location_node_id: uuid.UUID | None,
) -> KitLine:
    line = KitLine(
        kit_id=kit_id,
        line_no=line_no,
        item_id=item_id,
        qty_per_unit=qty_per_unit,
        issued_qty=issued_qty,
        source_location_node_id=source_location_node_id,
        return_location_node_id=source_location_node_id,
    )
    session.add(line)
    await session.flush()
    return line


def default_issued_qty(qty_per_unit: Decimal, target_qty: int) -> int:
    """needed_qty rounded up to whole units — the pre-filled issue quantity."""
    needed = qty_per_unit * target_qty
    return int(needed.to_integral_value(rounding=ROUND_CEILING))


async def create_kit_movement(
    session: AsyncSession,
    *,
    kit_id: uuid.UUID,
    kit_line_id: uuid.UUID | None,
    item_id: uuid.UUID,
    movement_type: str,
    qty_delta: int,
    from_location_node_id: uuid.UUID | None,
    to_location_node_id: uuid.UUID | None,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None,
    notes: str | None,
    lot_id: uuid.UUID | None = None,
) -> StockMovement:
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        movement_type=movement_type,
        qty_delta=qty_delta,
        qty_abs=abs(qty_delta),
        from_location_node_id=from_location_node_id,
        to_location_node_id=to_location_node_id,
        kit_id=kit_id,
        kit_line_id=kit_line_id,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
        notes=notes,
    )
    session.add(movement)
    await session.flush()
    return movement
