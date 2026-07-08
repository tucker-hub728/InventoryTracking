"""Persistence helpers for the inventory module — items, stock, transactions.

Routes orchestrate and validate; this module owns the queries and the stock
upsert primitives. Every write path is called inside the route's single DB
transaction (the route commits).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Row, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.models.identity import User
from app.models.inventory import (
    InventoryStock,
    InventoryTransaction,
    InventoryTransactionLine,
    Item,
)
from app.models.locations import Location

# ── Items ────────────────────────────────────────────────────────────────

ItemAggRow = Row[tuple[Item, Decimal, int]]  # (item, on_hand, location_count)


def _item_agg_columns():
    """Correlated subquery columns for an item's on-hand + location count."""
    on_hand = (
        select(func.coalesce(func.sum(InventoryStock.quantity_available), 0))
        .where(InventoryStock.item_id == Item.id)
        .correlate(Item)
        .scalar_subquery()
        .label("on_hand")
    )
    location_count = (
        select(func.count(func.distinct(InventoryStock.location_id)))
        .where(
            InventoryStock.item_id == Item.id,
            InventoryStock.quantity_available > 0,
        )
        .correlate(Item)
        .scalar_subquery()
        .label("location_count")
    )
    return on_hand, location_count


async def list_items(
    session: AsyncSession,
    *,
    tier: str | None = None,
    active: bool | None = None,
    search: str | None = None,
) -> list[ItemAggRow]:
    on_hand, location_count = _item_agg_columns()
    stmt = select(Item, on_hand, location_count).order_by(Item.item_code)
    if tier is not None:
        stmt = stmt.where(Item.tier == tier)
    if active is not None:
        stmt = stmt.where(Item.is_active.is_(active))
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where(
            Item.item_code.ilike(pattern) | Item.item_name.ilike(pattern)
        )
    return list((await session.execute(stmt)).all())


async def get_item(session: AsyncSession, item_id: uuid.UUID) -> Item | None:
    return (
        await session.execute(select(Item).where(Item.id == item_id))
    ).scalar_one_or_none()


async def get_item_with_aggregates(
    session: AsyncSession, item_id: uuid.UUID
) -> ItemAggRow | None:
    on_hand, location_count = _item_agg_columns()
    stmt = select(Item, on_hand, location_count).where(Item.id == item_id)
    return (await session.execute(stmt)).one_or_none()


async def get_item_stock_rows(
    session: AsyncSession, item_id: uuid.UUID
) -> list[Row[tuple[InventoryStock, str, str]]]:
    # location_id is a non-null FK, so the join always matches — name/type are
    # never NULL in practice.
    stmt = (
        select(InventoryStock, Location.location_name, Location.location_type)
        .outerjoin(Location, InventoryStock.location_id == Location.id)
        .where(
            InventoryStock.item_id == item_id,
            InventoryStock.quantity_available > 0,
        )
        .order_by(Location.location_name, InventoryStock.lot_number)
    )
    return list((await session.execute(stmt)).all())


async def get_item_by_code(session: AsyncSession, code: str) -> Item | None:
    stmt = select(Item).where(func.lower(Item.item_code) == code.lower())
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_item(
    session: AsyncSession,
    *,
    item_code: str,
    item_name: str,
    description: str | None,
    tier: str,
    is_consumable: bool,
    unit_of_measure: str,
    default_location_id: uuid.UUID | None,
    track_expiry: bool,
) -> Item:
    item = Item(
        item_code=item_code,
        item_name=item_name,
        description=description,
        tier=tier,
        is_consumable=is_consumable,
        unit_of_measure=unit_of_measure,
        default_location_id=default_location_id,
        track_expiry=track_expiry,
    )
    session.add(item)
    await session.flush()
    return item


# ── Stock ────────────────────────────────────────────────────────────────

StockRow = Row[tuple[InventoryStock, str | None, str | None, str | None]]


async def list_stock(
    session: AsyncSession,
    *,
    item_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
) -> list[StockRow]:
    """Flat stock balances joined with item + location display names."""
    stmt = (
        select(
            InventoryStock,
            Item.item_code,
            Item.item_name,
            Location.location_name,
        )
        .outerjoin(Item, InventoryStock.item_id == Item.id)
        .outerjoin(Location, InventoryStock.location_id == Location.id)
        .order_by(Item.item_code, Location.location_name)
    )
    if item_id is not None:
        stmt = stmt.where(InventoryStock.item_id == item_id)
    if location_id is not None:
        stmt = stmt.where(InventoryStock.location_id == location_id)
    return list((await session.execute(stmt)).all())


async def location_item_buckets(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    location_id: uuid.UUID,
    lot_number: str | None = None,
) -> list[InventoryStock]:
    """Non-empty stock buckets of one item at one location, FIFO-ordered by
    expiry (soonest first, NULLs last) then age — the drawdown order for a
    lot-agnostic transfer. If ``lot_number`` is given, restrict to that lot."""
    stmt = (
        select(InventoryStock)
        .where(
            InventoryStock.item_id == item_id,
            InventoryStock.location_id == location_id,
            InventoryStock.quantity_available > 0,
        )
        .order_by(
            InventoryStock.expiry_date.asc().nulls_last(),
            InventoryStock.created_at.asc(),
        )
    )
    if lot_number is not None:
        stmt = stmt.where(
            func.coalesce(InventoryStock.lot_number, "") == lot_number
        )
    return list((await session.execute(stmt)).scalars().all())


async def get_stock_bucket(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    location_id: uuid.UUID,
    lot_number: str | None,
) -> InventoryStock | None:
    """Fetch the unique (item, location, COALESCE(lot,'')) balance bucket."""
    stmt = select(InventoryStock).where(
        InventoryStock.item_id == item_id,
        InventoryStock.location_id == location_id,
        func.coalesce(InventoryStock.lot_number, "") == (lot_number or ""),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def add_stock(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    location_id: uuid.UUID,
    lot_number: str | None,
    expiry_date: date | None,
    quantity: Decimal,
    unit_of_measure: str,
) -> InventoryStock:
    """Upsert: add ``quantity`` into the (item, location, lot) bucket."""
    bucket = await get_stock_bucket(
        session, item_id=item_id, location_id=location_id, lot_number=lot_number
    )
    if bucket is None:
        bucket = InventoryStock(
            item_id=item_id,
            location_id=location_id,
            lot_number=lot_number,
            expiry_date=expiry_date,
            quantity_available=quantity,
            unit_of_measure=unit_of_measure,
        )
        session.add(bucket)
    else:
        bucket.quantity_available = bucket.quantity_available + quantity
        if expiry_date is not None and bucket.expiry_date is None:
            bucket.expiry_date = expiry_date
    await session.flush()
    return bucket


async def remove_stock(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    location_id: uuid.UUID,
    lot_number: str | None,
    quantity: Decimal,
) -> InventoryStock | None:
    """Decrement the (item, location, lot) bucket. Returns the bucket, or
    ``None`` if it does not exist / holds too little (caller decides how to
    surface the shortfall)."""
    bucket = await get_stock_bucket(
        session, item_id=item_id, location_id=location_id, lot_number=lot_number
    )
    if bucket is None or bucket.quantity_available < quantity:
        return None
    bucket.quantity_available = bucket.quantity_available - quantity
    await session.flush()
    return bucket


# ── Transactions ─────────────────────────────────────────────────────────

TransactionListRow = Row[tuple[InventoryTransaction, int, str | None, str | None]]


async def db_now(session: AsyncSession) -> datetime:
    """Server clock — keeps the transaction_no prefix and date consistent."""
    return (await session.execute(select(func.now()))).scalar_one()


async def next_transaction_no(session: AsyncSession, when: datetime) -> str:
    """``TRX-YYYYMMDD-XXXX`` with a zero-padded per-day sequence.

    The sequence is the count of same-day transactions + 1, computed inside
    the caller's DB transaction. The unique index on ``transaction_no`` is
    the backstop against a concurrent collision.
    """
    prefix = f"TRX-{when:%Y%m%d}-"
    count = (
        await session.execute(
            select(func.count())
            .select_from(InventoryTransaction)
            .where(InventoryTransaction.transaction_no.like(f"{prefix}%"))
        )
    ).scalar_one()
    return f"{prefix}{count + 1:04d}"


async def create_transaction(
    session: AsyncSession,
    *,
    transaction_no: str,
    transaction_type: str,
    transaction_date: datetime,
    created_by: uuid.UUID,
    reference_no: str | None,
    notes: str | None,
) -> InventoryTransaction:
    txn = InventoryTransaction(
        transaction_no=transaction_no,
        transaction_type=transaction_type,
        transaction_date=transaction_date,
        created_by=created_by,
        reference_no=reference_no,
        notes=notes,
    )
    session.add(txn)
    await session.flush()
    return txn


async def add_transaction_line(
    session: AsyncSession,
    *,
    transaction_id: uuid.UUID,
    item_id: uuid.UUID,
    from_location_id: uuid.UUID | None,
    to_location_id: uuid.UUID | None,
    lot_number: str | None,
    expiry_date: date | None,
    quantity: Decimal,
    unit_of_measure: str,
) -> InventoryTransactionLine:
    line = InventoryTransactionLine(
        transaction_id=transaction_id,
        item_id=item_id,
        from_location_id=from_location_id,
        to_location_id=to_location_id,
        lot_number=lot_number,
        expiry_date=expiry_date,
        quantity=quantity,
        unit_of_measure=unit_of_measure,
    )
    session.add(line)
    await session.flush()
    return line


async def list_transactions(
    session: AsyncSession,
    *,
    transaction_type: str | None = None,
    item_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[TransactionListRow]:
    line_count = (
        select(func.count(InventoryTransactionLine.id))
        .where(InventoryTransactionLine.transaction_id == InventoryTransaction.id)
        .correlate(InventoryTransaction)
        .scalar_subquery()
        .label("line_count")
    )
    creator = aliased(User)
    stmt = (
        select(
            InventoryTransaction,
            line_count,
            creator.first_name,
            creator.last_name,
        )
        .outerjoin(creator, InventoryTransaction.created_by == creator.id)
        .order_by(InventoryTransaction.transaction_date.desc())
        .limit(limit)
        .offset(offset)
    )
    if transaction_type is not None:
        stmt = stmt.where(InventoryTransaction.transaction_type == transaction_type)
    if item_id is not None:
        stmt = stmt.where(
            select(InventoryTransactionLine.id)
            .where(
                InventoryTransactionLine.transaction_id == InventoryTransaction.id,
                InventoryTransactionLine.item_id == item_id,
            )
            .exists()
        )
    if location_id is not None:
        stmt = stmt.where(
            select(InventoryTransactionLine.id)
            .where(
                InventoryTransactionLine.transaction_id == InventoryTransaction.id,
                (InventoryTransactionLine.from_location_id == location_id)
                | (InventoryTransactionLine.to_location_id == location_id),
            )
            .exists()
        )
    return list((await session.execute(stmt)).all())


async def item_transaction_ids(
    session: AsyncSession, item_id: uuid.UUID, *, limit: int
) -> list[uuid.UUID]:
    """The ids of the most-recent transactions that touched this item."""
    stmt = (
        select(InventoryTransaction.id)
        .join(
            InventoryTransactionLine,
            InventoryTransactionLine.transaction_id == InventoryTransaction.id,
        )
        .where(InventoryTransactionLine.item_id == item_id)
        .group_by(InventoryTransaction.id, InventoryTransaction.transaction_date)
        .order_by(InventoryTransaction.transaction_date.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars().all())


ItemLedgerRow = Row[
    tuple[
        InventoryTransactionLine,
        InventoryTransaction,
        str | None,  # from_location_name
        str | None,  # to_location_name
        str | None,  # creator first
        str | None,  # creator last
    ]
]


async def item_ledger_lines(
    session: AsyncSession, item_id: uuid.UUID, txn_ids: list[uuid.UUID]
) -> list[ItemLedgerRow]:
    """All lines for this item within the given transactions, joined with the
    header + from/to location names + creator name, newest transaction first."""
    from_loc = aliased(Location)
    to_loc = aliased(Location)
    creator = aliased(User)
    stmt = (
        select(
            InventoryTransactionLine,
            InventoryTransaction,
            from_loc.location_name,
            to_loc.location_name,
            creator.first_name,
            creator.last_name,
        )
        .join(
            InventoryTransaction,
            InventoryTransactionLine.transaction_id == InventoryTransaction.id,
        )
        .outerjoin(from_loc, InventoryTransactionLine.from_location_id == from_loc.id)
        .outerjoin(to_loc, InventoryTransactionLine.to_location_id == to_loc.id)
        .outerjoin(creator, InventoryTransaction.created_by == creator.id)
        .where(
            InventoryTransactionLine.item_id == item_id,
            InventoryTransactionLine.transaction_id.in_(txn_ids),
        )
        .order_by(
            InventoryTransaction.transaction_date.desc(),
            InventoryTransactionLine.created_at.asc(),
        )
    )
    return list((await session.execute(stmt)).all())


async def get_transaction(
    session: AsyncSession, transaction_id: uuid.UUID
) -> InventoryTransaction | None:
    stmt = (
        select(InventoryTransaction)
        .where(InventoryTransaction.id == transaction_id)
        .options(selectinload(InventoryTransaction.lines))
    )
    return (await session.execute(stmt)).scalar_one_or_none()
