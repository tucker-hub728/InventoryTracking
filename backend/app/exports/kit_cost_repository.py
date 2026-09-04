"""Bulk reads for the kit-cost export (RPT-003).

Six queries, no N+1 — same discipline as ``exports/repository.py``. Each returns
plain tuples or dicts keyed by kit, and ``routes.py`` assembles rows from them.

## The date range

Half-open — ``>= occurred_from``, ``< occurred_to`` — matching the only
date-range precedent in the backend (``audit/repository.py``). Half-open is what
lets the frontend send "the 27th" as ``[27th 00:00, 28th 00:00)`` and include
the whole day without an off-by-one-second gap at midnight.

**Kits are selected by their events, not by their own dates.** A kit created in
January whose only batch ran in August belongs in an August export; filtering on
``kits.created_at`` would drop it. So the range is applied to movements and
batches, and the kits those belong to are then pulled in whole — every one of a
matched kit's rows is emitted, which is what makes the per-kit totals in the
file add up rather than being silently partial.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.kitting.costing import CHARGE_MOVEMENT_TYPES, CREDIT_MOVEMENT_TYPES
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, Lot, StockMovement
from app.models.kitting import Kit, KitBatchConsumption, KitLine, KitProductionBatch
from app.models.products import Customer

#: Every movement type this export reports on the kit's material side.
MATERIAL_MOVEMENT_TYPES: tuple[str, ...] = CHARGE_MOVEMENT_TYPES + CREDIT_MOVEMENT_TYPES


def _in_range(
    stmt: Select, column, occurred_from: datetime | None, occurred_to: datetime | None
) -> Select:
    """Apply the half-open window, skipping either bound when unset."""
    if occurred_from is not None:
        stmt = stmt.where(column >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(column < occurred_to)
    return stmt


async def kit_ids_in_range(
    session: AsyncSession,
    *,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
    kit_id: uuid.UUID | None = None,
    status: str | None = None,
) -> list[uuid.UUID]:
    """Kits with at least one material movement or batch inside the window.

    **Cancelled kits are not filtered out.** ``cancel_kit`` accepts a kit that is
    already ``in_production``, so a cancelled kit can have minted priced finished
    lots that are in stock and shippable. Excluding it would make that cost
    disappear from the file while the stock sat on a shelf.
    """
    mv = _in_range(
        select(StockMovement.kit_id).where(
            StockMovement.kit_id.is_not(None),
            StockMovement.movement_type.in_(MATERIAL_MOVEMENT_TYPES),
        ),
        StockMovement.performed_at,
        occurred_from,
        occurred_to,
    )
    batches = _in_range(
        select(KitProductionBatch.kit_id),
        KitProductionBatch.produced_at,
        occurred_from,
        occurred_to,
    )
    stmt = (
        select(Kit.id)
        .where(Kit.deleted_at.is_(None), or_(Kit.id.in_(mv), Kit.id.in_(batches)))
        .order_by(Kit.created_at.asc())
    )
    if kit_id is not None:
        stmt = stmt.where(Kit.id == kit_id)
    if status is not None:
        stmt = stmt.where(Kit.status == status)
    return list((await session.execute(stmt)).scalars().all())


async def kits_with_context(
    session: AsyncSession, kit_ids: list[uuid.UUID]
) -> list[tuple[Kit, str, str]]:
    """``(kit, item_number, description)`` for the selected kits.

    The kit's own item number is derived (``prefix.code-suffix``), so the join
    goes through ``item_prefixes`` rather than reading a stored column.
    """
    if not kit_ids:
        return []
    stmt = (
        select(Kit, ItemPrefix.code, Item.sku_suffix, Item.description)
        .join(Item, Item.id == Kit.item_id)
        .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
        .where(Kit.id.in_(kit_ids))
        .order_by(Kit.created_at.asc())
    )
    return [
        (kit, f"{code}-{suffix}", description or "")
        for kit, code, suffix, description in (await session.execute(stmt)).all()
    ]


async def lines_by_kit(
    session: AsyncSession, kit_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[uuid.UUID, tuple[int, str, str]]]:
    """``{kit_id: {line_id: (line_no, item_number, description)}}``."""
    if not kit_ids:
        return {}
    stmt = (
        select(KitLine.kit_id, KitLine.id, KitLine.line_no, ItemPrefix.code, Item.sku_suffix,
               Item.description)
        .join(Item, Item.id == KitLine.item_id)
        .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
        .where(KitLine.kit_id.in_(kit_ids))
    )
    out: dict[uuid.UUID, dict[uuid.UUID, tuple[int, str, str]]] = {}
    for kid, line_id, line_no, code, suffix, description in (await session.execute(stmt)).all():
        out.setdefault(kid, {})[line_id] = (line_no, f"{code}-{suffix}", description or "")
    return out


async def material_movements(
    session: AsyncSession,
    kit_ids: list[uuid.UUID],
    *,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
) -> list[tuple]:
    """Charge and credit movements, newest last, with lot price and actor.

    Returns ``(kit_id, movement_id, performed_at, movement_type, kit_line_id,
    lot_number, unit_price, qty_abs, actor_name, notes)``.
    """
    if not kit_ids:
        return []
    stmt = (
        select(
            StockMovement.kit_id,
            StockMovement.id,
            StockMovement.performed_at,
            StockMovement.movement_type,
            StockMovement.kit_line_id,
            Lot.lot_number,
            Lot.unit_price_amount,
            StockMovement.qty_abs,
            User.full_name,
            StockMovement.notes,
        )
        .join(Lot, Lot.id == StockMovement.lot_id, isouter=True)
        .join(User, User.id == StockMovement.performed_by_user_id, isouter=True)
        .where(
            StockMovement.kit_id.in_(kit_ids),
            StockMovement.movement_type.in_(MATERIAL_MOVEMENT_TYPES),
        )
        .order_by(StockMovement.performed_at.asc())
    )
    stmt = _in_range(stmt, StockMovement.performed_at, occurred_from, occurred_to)
    return list((await session.execute(stmt)).all())


async def batches_with_lots(
    session: AsyncSession,
    kit_ids: list[uuid.UUID],
    *,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
) -> list[tuple]:
    """Batches with their output lot and the operator who ran them.

    Returns ``(batch, lot_number, expiration_date, release_state, actor_name)``.
    """
    if not kit_ids:
        return []
    stmt = (
        select(
            KitProductionBatch,
            Lot.lot_number,
            Lot.expiration_date,
            Lot.release_state,
            User.full_name,
        )
        .join(Lot, Lot.id == KitProductionBatch.output_lot_id, isouter=True)
        .join(User, User.id == KitProductionBatch.performed_by_user_id, isouter=True)
        .where(KitProductionBatch.kit_id.in_(kit_ids))
        .order_by(KitProductionBatch.kit_id, KitProductionBatch.batch_no.asc())
    )
    stmt = _in_range(stmt, KitProductionBatch.produced_at, occurred_from, occurred_to)
    return list((await session.execute(stmt)).all())


async def consumptions_by_batch(
    session: AsyncSession, kit_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[KitBatchConsumption]]:
    """``{batch_id: [consumption rows]}`` for the selected kits."""
    if not kit_ids:
        return {}
    stmt = (
        select(KitBatchConsumption)
        .join(KitProductionBatch, KitProductionBatch.id == KitBatchConsumption.batch_id)
        .where(KitProductionBatch.kit_id.in_(kit_ids))
    )
    out: dict[uuid.UUID, list[KitBatchConsumption]] = {}
    for row in (await session.execute(stmt)).scalars().all():
        out.setdefault(row.batch_id, []).append(row)
    return out


async def shipments_of_output_lots(
    session: AsyncSession,
    lot_ids: list[uuid.UUID],
    *,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
) -> list[tuple]:
    """Customer shipments of the finished lots these kits produced.

    Returns ``(lot_id, movement_id, performed_at, qty_abs, customer_name,
    reference_number, actor_name)``.

    The join that closes the loop: ``stock_movements`` already carries
    ``customer_id`` on ``customer_shipment`` rows (CUST-001), so pairing a
    shipment with the batch cost of the lot it moved needs no new schema.
    """
    if not lot_ids:
        return []
    stmt = (
        select(
            StockMovement.lot_id,
            StockMovement.id,
            StockMovement.performed_at,
            StockMovement.qty_abs,
            Customer.name,
            StockMovement.reference_number,
            User.full_name,
        )
        .join(Customer, Customer.id == StockMovement.customer_id, isouter=True)
        .join(User, User.id == StockMovement.performed_by_user_id, isouter=True)
        .where(
            StockMovement.lot_id.in_(lot_ids),
            StockMovement.movement_type == "customer_shipment",
        )
        .order_by(StockMovement.performed_at.asc())
    )
    stmt = _in_range(stmt, StockMovement.performed_at, occurred_from, occurred_to)
    return list((await session.execute(stmt)).all())
