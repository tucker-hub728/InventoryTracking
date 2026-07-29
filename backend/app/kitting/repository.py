"""Kitting DB helpers — plain async functions; the route owns the transaction.

Every helper ``add`` + ``flush``-es and returns the ORM object; the caller
commits (house convention). Quantity changes are written to the append-only
``app.stock_movements`` ledger via :func:`create_kit_movement`; on-hand stays
derived through ``app.v_item_stock`` (no stock table here).
"""

from __future__ import annotations

import uuid
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import Select, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload

from app.models.audit import AuditEvent
from app.models.inventory import BomLine, Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitLine
from app.models.locations import LocationNode, LotAllocation

# Flat-category marking a production/lab floor. Allocations here are WIP held
# by an open kit, never available stock (§0.3a).
PRODUCTION_CATEGORY = "production"

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


async def storage_node_exists(session: AsyncSession, node_id: uuid.UUID) -> bool:
    stmt = select(LocationNode.id).where(LocationNode.id == node_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def production_node_exists(session: AsyncSession, node_id: uuid.UUID) -> bool:
    """A kit's production location must be a real production/lab floor
    (``Transaction_Spec`` §2) — not a warehouse shelf."""
    stmt = select(LocationNode.id).where(
        LocationNode.id == node_id,
        LocationNode.flat_category == PRODUCTION_CATEGORY,
        LocationNode.is_active.is_(True),
    )
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def item_stock_by_node(
    session: AsyncSession, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict[uuid.UUID, int]]:
    """Per-item, per-node **available** stock from the Location System —
    ``{item_id: {node_id: qty}}`` over active, positive lot allocations.

    Production nodes are excluded: material sitting on a production floor is
    WIP owned by an open kit (§0.3a), not available stock, so it must never be
    offered as an issue source nor counted as on-hand for the picker.
    """
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
        .join(LocationNode, LocationNode.id == LotAllocation.location_node_id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
            func.coalesce(LocationNode.flat_category, "") != PRODUCTION_CATEGORY,
        )
        .group_by(Lot.item_id, LotAllocation.location_node_id)
    )
    out: dict[uuid.UUID, dict[uuid.UUID, int]] = {}
    for item_id, node_id, qty in (await session.execute(stmt)).all():
        out.setdefault(item_id, {})[node_id] = int(qty)
    return out


async def item_stock_by_node_lot(
    session: AsyncSession, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str | None, object, uuid.UUID, int]]]:
    """Per-item available stock grouped by **(location node, lot)** — the
    lot-level source rows for the kit Issue picker (KIT-002/003: "show available
    quantities per lot/shelf" and "FIFO across multiple lots").

    Returns ``{item_id: [(lot_id, lot_number, expiration_date, node_id, qty)]}``
    ordered FIFO (earliest expiry, then oldest lot) so the picker can auto-fill
    across lots in the right order. Production nodes are excluded for the same
    reason as :func:`item_stock_by_node` — WIP is not available stock.
    """
    if not item_ids:
        return {}
    stmt = (
        select(
            Lot.item_id,
            LotAllocation.location_node_id,
            Lot.id,
            Lot.lot_number,
            Lot.expiration_date,
            func.coalesce(func.sum(LotAllocation.qty), 0),
        )
        .select_from(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .join(LocationNode, LocationNode.id == LotAllocation.location_node_id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
            func.coalesce(LocationNode.flat_category, "") != PRODUCTION_CATEGORY,
        )
        .group_by(
            Lot.item_id,
            LotAllocation.location_node_id,
            Lot.id,
            Lot.lot_number,
            Lot.expiration_date,
        )
        # FIFO: earliest expiry first (nulls last), then oldest lot.
        .order_by(Lot.expiration_date.asc().nullslast(), Lot.created_at.asc())
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str | None, object, uuid.UUID, int]]] = {}
    for item_id, node_id, lot_id, lot_number, exp, qty in (await session.execute(stmt)).all():
        out.setdefault(item_id, []).append((lot_id, lot_number, exp, node_id, int(qty)))
    return out


async def item_cells_by_node(
    session: AsyncSession, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict[uuid.UUID, list[LotAllocation]]]:
    """Occupied **grid cells** holding these items, ``{item: {box_node: [alloc]}}``.

    Only grid-bearing nodes (the Box) appear — a cell is one unit of one lot at
    a ``(grid_row, grid_col)``, enforced single-occupancy by
    ``uq_lot_allocations_cell``. Lets the Issue step show the box's grid so the
    operator picks the exact vials (D2), while the *recorded* location stays the
    box itself (D4).

    Production nodes are excluded for the same reason as
    :func:`item_stock_by_node` — WIP is not available stock.
    """
    if not item_ids:
        return {}
    stmt = (
        select(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .join(LocationNode, LocationNode.id == LotAllocation.location_node_id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
            LotAllocation.grid_row.is_not(None),
            func.coalesce(LocationNode.flat_category, "") != PRODUCTION_CATEGORY,
        )
        .order_by(LotAllocation.grid_row, LotAllocation.grid_col)
    )
    rows = (await session.execute(stmt)).scalars().unique().all()
    lots = (
        {
            lot.id: lot
            for lot in (
                await session.execute(select(Lot).where(Lot.id.in_([r.lot_id for r in rows])))
            )
            .scalars()
            .unique()
            .all()
        }
        if rows
        else {}
    )
    out: dict[uuid.UUID, dict[uuid.UUID, list[LotAllocation]]] = {}
    for alloc in rows:
        lot = lots.get(alloc.lot_id)
        if lot is None:
            continue
        out.setdefault(lot.item_id, {}).setdefault(alloc.location_node_id, []).append(alloc)
    return out


async def grid_nodes(
    session: AsyncSession, node_ids: set[uuid.UUID]
) -> dict[uuid.UUID, LocationNode]:
    """The grid-bearing (Box) nodes among ``node_ids``, keyed by id — used to
    surface ``grid_rows × grid_cols`` so the picker can draw the grid."""
    if not node_ids:
        return {}
    stmt = select(LocationNode).where(
        LocationNode.id.in_(node_ids), LocationNode.grid_rows.is_not(None)
    )
    return {n.id: n for n in (await session.execute(stmt)).scalars().unique().all()}


async def allocations_by_ids(
    session: AsyncSession, allocation_ids: list[uuid.UUID]
) -> list[LotAllocation]:
    """Active allocations by id, for validating an explicit cell selection."""
    if not allocation_ids:
        return []
    stmt = select(LotAllocation).where(
        LotAllocation.id.in_(allocation_ids),
        LotAllocation.is_active.is_(True),
        LotAllocation.qty > 0,
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def occupied_cells(session: AsyncSession, node_id: uuid.UUID) -> set[tuple[int, int]]:
    """``{(row, col)}`` already taken in a box — the free-cell check for returns
    (``uq_lot_allocations_cell`` is the backstop; this gives a clean 422)."""
    stmt = select(LotAllocation.grid_row, LotAllocation.grid_col).where(
        LotAllocation.location_node_id == node_id,
        LotAllocation.is_active.is_(True),
        LotAllocation.grid_row.is_not(None),
    )
    return {(int(r), int(c)) for r, c in (await session.execute(stmt)).all()}


async def floor_lots_by_item_at_node(
    session: AsyncSession, node_id: uuid.UUID, item_ids: set[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str | None, int]]]:
    """Per item, the WIP on a production node split by lot —
    ``{item_id: [(lot_id, lot_number, qty)]}``, FIFO by expiry then age. Powers
    the Return picker (client 2026-07-24): the operator picks which floor lot's
    units to hand back. Same active/qty filters as
    :func:`allocations_for_item_at_node`."""
    if not item_ids:
        return {}
    stmt = (
        select(Lot.item_id, Lot.id, Lot.lot_number, func.sum(LotAllocation.qty))
        .join(LotAllocation, LotAllocation.lot_id == Lot.id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.location_node_id == node_id,
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
        )
        .group_by(Lot.item_id, Lot.id, Lot.lot_number, Lot.expiration_date, Lot.created_at)
        .order_by(Lot.expiration_date.asc().nullslast(), Lot.created_at.asc())
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str | None, int]]] = {}
    for item_id, lot_id, lot_number, qty in (await session.execute(stmt)).all():
        out.setdefault(item_id, []).append((lot_id, lot_number, int(qty)))
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
    q: str | None = None,
    limit: int,
    offset: int,
) -> tuple[list[Kit], int]:
    where = [Kit.deleted_at.is_(None)]
    if status is not None:
        where.append(Kit.status == status)

    base: Select = select(Kit).where(*where)
    if q and q.strip():
        # Server-side search across the kit number, the built item's number
        # (derived ``<prefix code>-<sku_suffix>``), and its description — the same
        # fields the list used to filter client-side. Join the item + prefix so
        # the full derived number matches (e.g. "AY-SSY001"). One item / prefix
        # per kit, so the join doesn't multiply rows (count stays correct).
        like = f"%{q.strip().lower()}%"
        base = (
            base.join(Item, Item.id == Kit.item_id)
            .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
            .where(
                or_(
                    func.lower(Kit.kit_number).like(like),
                    func.lower(Item.description).like(like),
                    func.lower(func.concat(ItemPrefix.code, "-", Item.sku_suffix)).like(like),
                )
            )
        )
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


async def line_issue_breakdown(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int]]]:
    """Per kit line, the INITIAL issue split by (lot, source node) — powers the
    "lots pulled" snapshot on the Issue step (client 2026-07-22). Only
    ``kit_issue`` rows (not additional issues or returns), summed per lot at each
    source. Returns ``{kit_line_id: [(lot_number, from_node_id, qty)]}``."""
    stmt = (
        select(
            StockMovement.kit_line_id,
            Lot.lot_number,
            StockMovement.from_location_node_id,
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
        )
        .select_from(StockMovement)
        .join(Lot, Lot.id == StockMovement.lot_id, isouter=True)
        .where(
            StockMovement.kit_id == kit_id,
            StockMovement.movement_type == "kit_issue",
        )
        .group_by(StockMovement.kit_line_id, Lot.lot_number, StockMovement.from_location_node_id)
    )
    out: dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int]]] = {}
    for line_id, lot_number, from_node, qty in (await session.execute(stmt)).all():
        if line_id is None:
            continue
        out.setdefault(line_id, []).append((lot_number, from_node, int(qty)))
    return out


async def kit_movements(session: AsyncSession, kit_id: uuid.UUID) -> list[StockMovement]:
    stmt = (
        select(StockMovement)
        .where(StockMovement.kit_id == kit_id)
        .order_by(StockMovement.performed_at.desc(), StockMovement.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def kits_on_floor(session: AsyncSession, node_id: uuid.UUID) -> list[Kit]:
    """Open kits (issued / in production) whose production floor is ``node_id``,
    with their lines — so the Production view can show which kit the WIP on a
    floor belongs to."""
    stmt = (
        select(Kit)
        .where(
            Kit.production_location_node_id == node_id,
            Kit.status.in_(("issued", "in_production")),
            Kit.deleted_at.is_(None),
        )
        .options(selectinload(Kit.lines))
        .order_by(Kit.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars().unique().all())


def _completed_on_floor_where(node_id: uuid.UUID):
    return (
        Kit.production_location_node_id == node_id,
        Kit.status == "closed",
        Kit.deleted_at.is_(None),
    )


async def kits_completed_on_floor(
    session: AsyncSession, node_id: uuid.UUID, *, limit: int = 25, offset: int = 0
) -> list[Kit]:
    """CLOSED kits that built on ``node_id`` — their lines carry the ``used_qty``
    consumed on the floor. Newest first, one page at a time."""
    stmt = (
        select(Kit)
        .where(*_completed_on_floor_where(node_id))
        .options(selectinload(Kit.lines))
        .order_by(Kit.closed_at.desc().nullslast())
        .limit(limit)
        .offset(offset)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def count_kits_completed_on_floor(session: AsyncSession, node_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(Kit).where(*_completed_on_floor_where(node_id))
    return int((await session.execute(stmt)).scalar_one())


def _cancelled_on_floor_where(node_id: uuid.UUID):
    return (
        Kit.production_location_node_id == node_id,
        Kit.status == "cancelled",
        Kit.good_qty.is_not(None),
        Kit.good_qty > 0,
        Kit.deleted_at.is_(None),
    )


async def count_kits_cancelled_on_floor(session: AsyncSession, node_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(Kit).where(*_cancelled_on_floor_where(node_id))
    return int((await session.execute(stmt)).scalar_one())


async def kits_cancelled_on_floor(
    session: AsyncSession, node_id: uuid.UUID, *, limit: int = 25, offset: int = 0
) -> list[Kit]:
    """Cancelled kits that PRODUCED something on ``node_id`` before being
    abandoned. Newest first, capped.

    A kit can be cancelled from ``in_production``, and under incremental
    production (KIT-007) it may already have produced batches by then — real
    stock, on real lots, sitting in storage. Without this the floor showed no
    trace of that work (client 2026-07-28). Kits cancelled having produced
    nothing are excluded: their material went back to inventory and there is no
    output to account for.

    ``closed_at`` is stamped on cancel as well as close, so it orders both.
    """
    stmt = (
        select(Kit)
        .where(*_cancelled_on_floor_where(node_id))
        .options(selectinload(Kit.lines))
        .order_by(Kit.closed_at.desc().nullslast())
        .limit(limit)
        .offset(offset)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def produced_batches_for_kits(
    session: AsyncSession, kit_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[str | None, int, object]]]:
    """Per kit, the produced batches — ``{kit_id: [(lot_number, qty, produced_at)]}``,
    oldest first. Each Produce / close batch mints ONE lot (operator-entered
    number, client 2026-07-24); a batch split across destinations writes several
    ``production_output`` rows for that one lot, so we group by lot and sum the
    units. Powers the "Batches produced" list on the Production floor view."""
    if not kit_ids:
        return {}
    stmt = (
        select(
            StockMovement.kit_id,
            Lot.lot_number,
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
            func.min(StockMovement.performed_at),
        )
        .select_from(StockMovement)
        .join(Lot, Lot.id == StockMovement.lot_id, isouter=True)
        .where(
            StockMovement.kit_id.in_(kit_ids),
            StockMovement.movement_type == "production_output",
        )
        .group_by(StockMovement.kit_id, Lot.lot_number)
        .order_by(func.min(StockMovement.performed_at))
    )
    out: dict[uuid.UUID, list[tuple[str | None, int, object]]] = {}
    for kit_id, lot_number, qty, produced_at in (await session.execute(stmt)).all():
        if kit_id is None:
            continue
        out.setdefault(kit_id, []).append((lot_number, int(qty), produced_at))
    return out


async def consumption_lines_for_item(
    session: AsyncSession, item_id: uuid.UUID, *, limit: int = 200
) -> list[KitLine]:
    """Every kit LINE that draws this item, newest kit first, with its kit loaded.

    The ledger shows what a kit took OUT of stock (``kit_issue``) and what came
    back (``backflush``), but never what was actually **used** — consumption
    writes no stock movement, because the material already left ``v_item_stock``
    at issue (kitting.md §4.3). REQ-2026-07-09-TRX-003 wants the ledger to
    "self-explain: issued fifteen, used twelve, backflushed three", so the middle
    term has to come from ``kit_lines.used_qty``, which is what this returns.

    ``used_qty`` is cumulative across produce batches (KIT-007), so an OPEN kit's
    figure is live and still moving — the caller flags that rather than hiding it
    (client 2026-07-28).
    """
    stmt = (
        select(KitLine)
        .join(Kit, Kit.id == KitLine.kit_id)
        .where(
            KitLine.item_id == item_id,
            Kit.deleted_at.is_(None),
        )
        .options(joinedload(KitLine.kit))
        .order_by(Kit.created_at.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def audit_events_for_item(
    session: AsyncSession, item_id: uuid.UUID, *, limit: int = 200
) -> list[AuditEvent]:
    """Every kit audit event for kits this item took part in — the per-ITEM audit
    history (AUD-001: kitting & reconciliation events viewable per item). The
    item's stock movements carry the ``kit_id`` of every kit it was issued to,
    built in, or back-flushed from, so we collect those kits and load their audit
    events (``subject_table='app.kits'``; each event's ``subject_id`` is the kit
    id and ``subject_label`` the kit number). Newest first, capped."""
    kit_ids = (
        select(StockMovement.kit_id)
        .where(
            StockMovement.item_id == item_id,
            StockMovement.kit_id.is_not(None),
        )
        .distinct()
    )
    stmt = (
        select(AuditEvent)
        .where(
            AuditEvent.subject_table == "app.kits",
            AuditEvent.subject_id.in_(kit_ids),
        )
        .order_by(AuditEvent.occurred_at.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars().all())


async def kit_audit_events(session: AsyncSession, kit_id: uuid.UUID) -> list[AuditEvent]:
    """Every ``audit.audit_events`` row for a kit, newest first — the full
    activity trail (carries good/scrap and per-line changes the stock ledger
    can't record)."""
    stmt = (
        select(AuditEvent)
        .where(
            AuditEvent.subject_table == "app.kits",
            AuditEvent.subject_id == kit_id,
        )
        .order_by(AuditEvent.occurred_at.desc())
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


async def suggest_kit_number(session: AsyncSession) -> str:
    """A free ``KIT-####`` to pre-fill the New-kit field with.

    Peeks at the sequence rather than calling ``nextval`` — this runs on every
    dialog open, and consuming a value each time would burn numbers for kits
    that are never created. Because the operator may also type a name by hand,
    the candidate is walked forward until it is actually free. The create
    endpoint still enforces uniqueness, so this only has to be a good guess.
    """
    row = (
        await session.execute(text("SELECT last_value, is_called FROM app.kit_number_seq"))
    ).one()
    nxt = int(row[0]) + 1 if row[1] else int(row[0])
    for candidate_n in range(nxt, nxt + 1000):
        candidate = f"KIT-{candidate_n:04d}"
        if not await kit_number_taken(session, candidate):
            return candidate
    return f"KIT-{nxt:04d}"


async def kit_number_taken(session: AsyncSession, kit_number: str) -> bool:
    """Mirrors the partial unique index ``uq_kits_kit_number`` (``deleted_at IS
    NULL``), so only a **soft-deleted** kit frees its name.

    A *cancelled* kit keeps it: cancelling abandons the batch but the record —
    and the movements that returned its material — remain, so reusing that batch
    number would make the ledger ambiguous.
    """
    stmt = select(Kit.id).where(Kit.kit_number == kit_number, Kit.deleted_at.is_(None))
    return (await session.execute(stmt)).scalar_one_or_none() is not None


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
