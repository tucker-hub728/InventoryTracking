"""Kitting DB helpers — plain async functions; the route owns the transaction.

Every helper ``add`` + ``flush``-es and returns the ORM object; the caller
commits (house convention). Quantity changes are written to the append-only
``app.stock_movements`` ledger via :func:`create_kit_movement`; on-hand stays
derived through ``app.v_item_stock`` (no stock table here).
"""

from __future__ import annotations

import uuid
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import Select, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, lazyload, selectinload

from app.core.search import like_contains
from app.models.audit import AuditEvent
from app.models.identity import User
from app.models.inventory import BomLine, Item, ItemPrefix, ItemTier, Lot, StockMovement
from app.models.kitting import Kit, KitBatchConsumption, KitLine, KitProductionBatch
from app.models.locations import KANBAN_NODE_TYPE, LocationNode, LotAllocation
from app.notifications.pending import mark_item

# Flat-category marking a production/lab floor. Allocations here are WIP held
# by an open kit, never available stock (§0.3a).
PRODUCTION_CATEGORY = "production"


def not_floor_stock():
    """SQL predicate: this allocation is back-office stock somebody may draw on.

    Two things are on the production floor and neither is available:

    * an allocation at a production/lab node — WIP held by an open kit (§0.3a);
    * an allocation in a **Kanban** — area consumables handed to the floor
      (KAN-001). New since kan01, and the reason this stopped being a one-line
      filter.

    The Kanban arm is NOT redundant with the first, and that is the whole point
    of extracting this. A Kanban's own ``flat_category`` is NULL — it is the
    *parent* production area that carries the category — so a plain
    ``flat_category != 'production'`` test lets Kanban rows straight through.
    Before kan01 that was harmless because a Kanban held no allocations at all;
    the moment it holds a balance, every picker filtered that way would offer
    the floor's gloves as issuable stock and the same units could be spent
    twice — once on the floor, once back in stores.

    Callers: the kit issue picker, the consumable issue picker, and the finance
    export. Keep them on this helper rather than re-deriving the predicate.
    """
    return (func.coalesce(LocationNode.flat_category, "") != PRODUCTION_CATEGORY) & (
        LocationNode.node_type != KANBAN_NODE_TYPE
    )

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
            not_floor_stock(),
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
            not_floor_stock(),
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
            not_floor_stock(),
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
    session: AsyncSession,
    item_id: uuid.UUID,
    node_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> list[LotAllocation]:
    """Active allocations of an item at a node, FIFO by expiry then age —
    the consume order for a kit issue.

    ``for_update=True`` locks the allocation rows for the rest of the
    transaction. Issue paths MUST use it: they sum these quantities, decide
    whether there is enough, and then draw them down, and without the lock a
    concurrent issue can empty the same rows in between (VR-004).

    Note ``of=LotAllocation`` — the statement joins ``Lot`` only to filter and
    order, and locking lots as well would make two kits that merely share an
    item block each other for no reason.
    """
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
    if for_update:
        stmt = stmt.with_for_update(of=LotAllocation)
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
        like = like_contains(q.strip().lower())
        base = (
            base.join(Item, Item.id == Kit.item_id)
            .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
            .where(
                or_(
                    func.lower(Kit.kit_number).like(like, escape="\\"),
                    func.lower(Item.description).like(like, escape="\\"),
                    func.lower(func.concat(ItemPrefix.code, "-", Item.sku_suffix)).like(like, escape="\\"),
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
) -> dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int, Decimal | None]]]:
    """Per kit line, the INITIAL issue split by (lot, source node) — powers the
    "lots pulled" snapshot on the Issue step (client 2026-07-22). Only
    ``kit_issue`` rows (not additional issues or returns), summed per lot at each
    source. Returns ``{kit_line_id: [(lot_number, from_node_id, qty, price)]}``.

    ``price`` is that lot's per-consume-unit cost (RPT-003), carried so the UI
    can show what each pull was worth. A line drawing from two differently
    priced lots reports a blended unit cost, and without the per-lot prices
    beside it that blend is a number nobody can check."""
    stmt = (
        select(
            StockMovement.kit_line_id,
            Lot.lot_number,
            StockMovement.from_location_node_id,
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
            Lot.unit_price_amount,
        )
        .select_from(StockMovement)
        .join(Lot, Lot.id == StockMovement.lot_id, isouter=True)
        .where(
            StockMovement.kit_id == kit_id,
            StockMovement.movement_type == "kit_issue",
        )
        .group_by(
            StockMovement.kit_line_id,
            Lot.lot_number,
            StockMovement.from_location_node_id,
            Lot.unit_price_amount,
        )
    )
    out: dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int, Decimal | None]]] = {}
    for line_id, lot_number, from_node, qty, price in (await session.execute(stmt)).all():
        if line_id is None:
            continue
        out.setdefault(line_id, []).append((lot_number, from_node, int(qty), price))
    return out


async def line_all_charges_breakdown(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int, Decimal | None, bool]]]:
    """Per kit line, EVERY charge split by lot — initial issue *and* additional.

    Returns ``{kit_line_id: [(lot_number, from_node_id, qty, price, is_additional)]}``.

    Distinct from :func:`line_issue_breakdown`, which is deliberately the
    ``kit_issue`` rows only because it powers the Issue step's "lots pulled"
    snapshot (client 2026-07-22). That is the wrong set for **cost**: a kit
    topped up over several feeding days does most of its buying through
    ``kit_additional_issue``, and a cost panel built on the initial issue alone
    hides the very lot whose price explains the number it is trying to justify.

    Ordered oldest-first so the sequence reads as the line's buying history —
    which is what a moving average is an average *of*.
    """
    from app.kitting.costing import CHARGE_MOVEMENT_TYPES

    stmt = (
        select(
            StockMovement.kit_line_id,
            Lot.lot_number,
            StockMovement.from_location_node_id,
            StockMovement.qty_abs,
            Lot.unit_price_amount,
            StockMovement.movement_type,
            StockMovement.performed_at,
        )
        .select_from(StockMovement)
        .join(Lot, Lot.id == StockMovement.lot_id, isouter=True)
        .where(
            StockMovement.kit_id == kit_id,
            StockMovement.kit_line_id.is_not(None),
            StockMovement.movement_type.in_(CHARGE_MOVEMENT_TYPES),
        )
        .order_by(StockMovement.performed_at.asc())
    )
    out: dict[uuid.UUID, list[tuple[str | None, uuid.UUID | None, int, Decimal | None, bool]]] = {}
    for line_id, lot_number, node_id, qty, price, mv_type, _at in (
        await session.execute(stmt)
    ).all():
        out.setdefault(line_id, []).append(
            (lot_number, node_id, int(qty), price, mv_type == "kit_additional_issue")
        )
    return out


async def line_charge_credit_values(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, tuple[Decimal | None, Decimal, int]]:
    """Per kit line, the money charged to it and credited back — RPT-003.

    Returns ``{kit_line_id: (charged, credited, unpriced_charge_qty)}``:

    * ``charged``  — Σ ``qty_abs × lots.unit_price_amount`` over ``kit_issue`` +
      ``kit_additional_issue``. **``None`` when any issued lot had no price**;
      see ``unpriced_charge_qty`` below for how that is detected.
    * ``credited`` — the same sum over the three return types. Note this is the
      *lot-price* valuation; whether it is the one actually used is
      ``costing.CREDIT_AT_LINE_AVERAGE``'s call, and by default it is not.
    * ``unpriced_charge_qty`` — units issued to the line from a lot with no
      price. Non-zero means the line's cost is unknowable, and the caller must
      propagate that rather than sum the priced remainder.

    Reads the kit's **own** movements only. That is the point: the production
    floor is shared between kits (``allocations_for_item_at_node`` has no kit
    filter, by design — material is never bound to a kit, TRX-002), so anything
    derived from the floor could charge one kit for another's material. These
    rows carry ``kit_id`` and ``kit_line_id`` and cannot.
    """
    from app.kitting.costing import CHARGE_MOVEMENT_TYPES, CREDIT_MOVEMENT_TYPES

    priced_value = func.coalesce(
        func.sum(
            case(
                (Lot.unit_price_amount.is_not(None), StockMovement.qty_abs * Lot.unit_price_amount),
                else_=0,
            )
        ),
        0,
    )
    unpriced_qty = func.coalesce(
        func.sum(case((Lot.unit_price_amount.is_(None), StockMovement.qty_abs), else_=0)),
        0,
    )
    stmt = (
        select(
            StockMovement.kit_line_id,
            StockMovement.movement_type,
            priced_value,
            unpriced_qty,
        )
        .select_from(StockMovement)
        .join(Lot, Lot.id == StockMovement.lot_id)
        .where(
            StockMovement.kit_id == kit_id,
            StockMovement.kit_line_id.is_not(None),
            StockMovement.movement_type.in_(CHARGE_MOVEMENT_TYPES + CREDIT_MOVEMENT_TYPES),
        )
        .group_by(StockMovement.kit_line_id, StockMovement.movement_type)
    )
    charged: dict[uuid.UUID, Decimal] = {}
    credited: dict[uuid.UUID, Decimal] = {}
    unpriced: dict[uuid.UUID, int] = {}
    for line_id, mv_type, value, no_price_qty in (await session.execute(stmt)).all():
        if mv_type in CHARGE_MOVEMENT_TYPES:
            charged[line_id] = charged.get(line_id, Decimal("0")) + Decimal(value)
            # Only an unpriced CHARGE makes the cost unknown. An unpriced return
            # cannot: the material was priced on the way in, so the line already
            # knows what a unit of it is worth.
            unpriced[line_id] = unpriced.get(line_id, 0) + int(no_price_qty)
        else:
            credited[line_id] = credited.get(line_id, Decimal("0")) + Decimal(value)

    out: dict[uuid.UUID, tuple[Decimal | None, Decimal, int]] = {}
    for line_id in set(charged) | set(credited):
        no_price = unpriced.get(line_id, 0)
        out[line_id] = (
            None if no_price else charged.get(line_id, Decimal("0")),
            credited.get(line_id, Decimal("0")),
            no_price,
        )
    return out


async def consumed_values_by_line(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, Decimal | None]:
    """Per kit line, the value already attributed to earlier batches — RPT-003.

    The third term of the moving average. Without it, batch 2 would re-spend the
    value batch 1 already carried away into its own finished lot.

    ``None`` — never ``0`` — when the line's consumption rows are all unvalued,
    which is what an unpriced input leaves behind. The two are different
    answers and this system has real money riding on the difference: ``0`` means
    the material was free (the customer-owned cells arrive on a $0 PO), ``None``
    means nobody knows what it cost. Coalescing here published ``$0.00`` on the
    kit page for a component the batch drill-down was correctly calling ``—``,
    on the same screen (client, 2026-09-01).

    ``SUM`` skips NULLs rather than poisoning on them, so a line with one valued
    batch and one unvalued one still reports the valued part. That mixed state
    is not reachable in practice — ``charged`` is all-or-nothing per line, and a
    price correction replays every batch (``recompute``) — but if it ever is,
    under-reporting the total is the safe direction for a figure that becomes an
    invoice.
    """
    stmt = (
        select(
            KitBatchConsumption.kit_line_id,
            func.sum(KitBatchConsumption.extended_value_amount),
        )
        .select_from(KitBatchConsumption)
        .join(KitProductionBatch, KitProductionBatch.id == KitBatchConsumption.batch_id)
        .where(KitProductionBatch.kit_id == kit_id)
        .group_by(KitBatchConsumption.kit_line_id)
    )
    return {
        line_id: (None if value is None else Decimal(value))
        for line_id, value in (await session.execute(stmt)).all()
    }


async def next_batch_no(session: AsyncSession, kit_id: uuid.UUID) -> int:
    """The 1-based sequence number for the batch about to be written."""
    stmt = select(func.coalesce(func.max(KitProductionBatch.batch_no), 0)).where(
        KitProductionBatch.kit_id == kit_id
    )
    return int((await session.execute(stmt)).scalar_one()) + 1


async def create_batch(
    session: AsyncSession,
    *,
    kit_id: uuid.UUID,
    batch_no: int,
    output_lot_id: uuid.UUID | None,
    good_qty: int,
    scrap_qty: int,
    material_cost_amount: Decimal | None,
    unit_cost_amount: Decimal | None,
    cost_is_complete: bool,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None,
) -> KitProductionBatch:
    batch = KitProductionBatch(
        kit_id=kit_id,
        batch_no=batch_no,
        output_lot_id=output_lot_id,
        good_qty=good_qty,
        scrap_qty=scrap_qty,
        material_cost_amount=material_cost_amount,
        unit_cost_amount=unit_cost_amount,
        cost_is_complete=cost_is_complete,
        performed_by_user_id=performed_by_user_id,
        reauth_evidence_id=reauth_evidence_id,
    )
    session.add(batch)
    await session.flush()
    return batch


async def create_batch_consumption(
    session: AsyncSession,
    *,
    batch_id: uuid.UUID,
    kit_line_id: uuid.UUID,
    qty: int,
    unit_cost_amount: Decimal | None,
    extended_value_amount: Decimal | None,
    cost_is_complete: bool,
) -> KitBatchConsumption:
    row = KitBatchConsumption(
        batch_id=batch_id,
        kit_line_id=kit_line_id,
        qty=qty,
        unit_cost_amount=unit_cost_amount,
        extended_value_amount=extended_value_amount,
        cost_is_complete=cost_is_complete,
    )
    session.add(row)
    await session.flush()
    return row


async def batches_for_kit(
    session: AsyncSession, kit_id: uuid.UUID
) -> list[KitProductionBatch]:
    """Every batch a kit has run, oldest first, with its consumption rows.

    ``selectinload`` rather than a lazy walk: the batch detail view renders the
    per-component breakdown for every batch at once, so lazy loading would be a
    query per batch on a page that already knows it needs them all.
    """
    stmt = (
        select(KitProductionBatch)
        .options(selectinload(KitProductionBatch.consumptions))
        .where(KitProductionBatch.kit_id == kit_id)
        .order_by(KitProductionBatch.batch_no.asc())
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def kits_that_consumed_lot(
    session: AsyncSession, lot_id: uuid.UUID
) -> list[uuid.UUID]:
    """Kits that were CHARGED this lot, oldest first — the recompute frontier.

    Charges only. A kit that merely handed the lot back never took its cost, so
    correcting the price changes nothing it produced.
    """
    from app.kitting.costing import CHARGE_MOVEMENT_TYPES

    stmt = (
        select(StockMovement.kit_id)
        .where(
            StockMovement.lot_id == lot_id,
            StockMovement.kit_id.is_not(None),
            StockMovement.movement_type.in_(CHARGE_MOVEMENT_TYPES),
        )
        .group_by(StockMovement.kit_id)
        .order_by(func.min(StockMovement.performed_at).asc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def kit_movement_flows(
    session: AsyncSession, kit_id: uuid.UUID
) -> list[tuple[uuid.UUID, object, str, int, Decimal | None]]:
    """Every charge and credit on a kit, with its timestamp, qty and lot price.

    One query for the whole replay: the recompute needs each line's position as
    of each batch, and asking the database once per batch would be N queries to
    answer a question one ordered list already covers.

    Returns ``(kit_line_id, performed_at, movement_type, qty_abs, unit_price)``.
    """
    from app.kitting.costing import CHARGE_MOVEMENT_TYPES, CREDIT_MOVEMENT_TYPES

    stmt = (
        select(
            StockMovement.kit_line_id,
            StockMovement.performed_at,
            StockMovement.movement_type,
            StockMovement.qty_abs,
            Lot.unit_price_amount,
        )
        .join(Lot, Lot.id == StockMovement.lot_id)
        .where(
            StockMovement.kit_id == kit_id,
            StockMovement.kit_line_id.is_not(None),
            StockMovement.movement_type.in_(CHARGE_MOVEMENT_TYPES + CREDIT_MOVEMENT_TYPES),
        )
        .order_by(StockMovement.performed_at.asc())
    )
    return [
        (line_id, at, mv_type, int(qty), price)
        for line_id, at, mv_type, qty, price in (await session.execute(stmt)).all()
    ]


async def line_ids_for_kit(session: AsyncSession, kit_id: uuid.UUID) -> list[uuid.UUID]:
    stmt = select(KitLine.id).where(KitLine.kit_id == kit_id)
    return list((await session.execute(stmt)).scalars().all())


async def get_lot_for_update(session: AsyncSession, lot_id: uuid.UUID) -> Lot | None:
    """A lot, locked, so two concurrent recomputes cannot interleave a restamp.

    ``lazyload("*")`` is not optional. ``Lot`` eager-loads its item, tier,
    prefix, stock view and supplier, which SQLAlchemy renders as LEFT OUTER
    JOINs — and Postgres refuses ``FOR UPDATE`` against the nullable side of an
    outer join outright. Only the lot's own row is being locked, so none of
    those relationships is wanted here anyway.
    """
    stmt = (
        select(Lot)
        .where(Lot.id == lot_id)
        .options(lazyload("*"))
        .with_for_update(of=Lot)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def batch_operator_names(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """``{batch_id: operator full name}`` — who ran each batch."""
    stmt = (
        select(KitProductionBatch.id, User.full_name)
        .join(User, User.id == KitProductionBatch.performed_by_user_id)
        .where(KitProductionBatch.kit_id == kit_id)
    )
    return dict((await session.execute(stmt)).all())


async def batch_output_lot_numbers(
    session: AsyncSession, kit_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    """``{batch_id: lot_number}`` for a kit's batches that minted a lot."""
    stmt = (
        select(KitProductionBatch.id, Lot.lot_number)
        .join(Lot, Lot.id == KitProductionBatch.output_lot_id)
        .where(KitProductionBatch.kit_id == kit_id)
    )
    return dict((await session.execute(stmt)).all())


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
    """Every cancelled kit on this floor — no output filter (client 2026-09-01).

    This used to require ``good_qty > 0``, on the reasoning that a kit cancelled
    without producing "has no output and its material already went back"
    (client 2026-07-28). REQ-2026-07-31-KIT-003 made the second half untrue: a
    cancelled kit discards its media rather than returning it, so a kit that
    produced nothing can still have destroyed material — and those were exactly
    the kits the filter hid. The floor view is meant to answer "what happened
    here", so it now lists them all.
    """
    return (
        Kit.production_location_node_id == node_id,
        Kit.status == "cancelled",
        Kit.deleted_at.is_(None),
    )


async def count_kits_cancelled_on_floor(session: AsyncSession, node_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(Kit).where(*_cancelled_on_floor_where(node_id))
    return int((await session.execute(stmt)).scalar_one())


async def kits_cancelled_on_floor(
    session: AsyncSession, node_id: uuid.UUID, *, limit: int = 25, offset: int = 0
) -> list[Kit]:
    """Cancelled kits on ``node_id``. Newest first, capped.

    A kit can be cancelled from ``in_production``, and under incremental
    production (KIT-007) it may already have produced batches by then — real
    stock, on real lots, sitting in storage. Without this the floor showed no
    trace of that work (client 2026-07-28).

    Kits that produced nothing are included too (client 2026-09-01) — see
    ``_cancelled_on_floor_where`` for why that reversed.

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
    variable_yield: bool,
    created_by_user_id: uuid.UUID,
) -> Kit:
    kit = Kit(
        kit_number=kit_number,
        item_id=item_id,
        target_qty=target_qty,
        status="draft",
        production_location_node_id=production_location_node_id,
        notes=notes,
        variable_yield=variable_yield,
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
    consumed_in_kit: bool,
    source_location_node_id: uuid.UUID | None,
) -> KitLine:
    line = KitLine(
        kit_id=kit_id,
        line_no=line_no,
        item_id=item_id,
        qty_per_unit=qty_per_unit,
        issued_qty=issued_qty,
        consumed_in_kit=consumed_in_kit,
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
    # Freeze the addresses as text alongside the ids — a node re-hung later must
    # not rewrite where this kit's history says the material was.
    from app.locations.repository import node_paths

    from_path, to_path = await node_paths(
        session, from_node_id=from_location_node_id, to_node_id=to_location_node_id
    )
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        movement_type=movement_type,
        qty_delta=qty_delta,
        qty_abs=abs(qty_delta),
        from_location_node_id=from_location_node_id,
        to_location_node_id=to_location_node_id,
        from_location_path=from_path,
        to_location_path=to_path,
        kit_id=kit_id,
        kit_line_id=kit_line_id,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
        notes=notes,
    )
    mark_item(session, item_id)
    session.add(movement)
    await session.flush()
    return movement
