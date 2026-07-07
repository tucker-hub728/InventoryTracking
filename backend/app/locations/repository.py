"""Persistence helpers for the locations module.

Routes orchestrate and validate; this module owns the queries. Reads that
need the parent's display name use an aliased self-join so the caller never
touches the (async-unsafe) lazy ``parent`` relationship inside a serializer.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import Row, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.inventory import InventoryStock, InventoryTransactionLine
from app.models.locations import Location

# A row shape of (Location, parent_name) — parent_name is NULL for roots.
LocationRow = Row[tuple[Location, str | None]]


async def list_locations(
    session: AsyncSession,
    *,
    active: bool | None = None,
    parent_id: uuid.UUID | None = None,
) -> list[LocationRow]:
    """List locations (optionally filtered), each with its parent's name."""
    parent = aliased(Location)
    stmt = (
        select(Location, parent.location_name.label("parent_name"))
        .outerjoin(parent, Location.parent_location_id == parent.id)
        .order_by(Location.location_name)
    )
    if active is not None:
        stmt = stmt.where(Location.is_active.is_(active))
    if parent_id is not None:
        stmt = stmt.where(Location.parent_location_id == parent_id)
    return list((await session.execute(stmt)).all())


async def get_location_row(
    session: AsyncSession, location_id: uuid.UUID
) -> LocationRow | None:
    """Fetch one location plus its parent's name."""
    parent = aliased(Location)
    stmt = (
        select(Location, parent.location_name.label("parent_name"))
        .outerjoin(parent, Location.parent_location_id == parent.id)
        .where(Location.id == location_id)
    )
    return (await session.execute(stmt)).one_or_none()


async def get_location(
    session: AsyncSession, location_id: uuid.UUID
) -> Location | None:
    """Fetch a bare location row (no parent name) for validation paths."""
    stmt = select(Location).where(Location.id == location_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_all(session: AsyncSession) -> list[Location]:
    """Every location (bare rows), ordered by name — for the tree overview."""
    stmt = select(Location).order_by(Location.location_name)
    return list((await session.execute(stmt)).scalars().all())


StockMinRow = Row[tuple[uuid.UUID, str | None, Decimal]]


async def all_stock_min(session: AsyncSession) -> list[StockMinRow]:
    """(location_id, lot_number, quantity) for every stock bucket — the
    caller rolls these up per location for the overview."""
    stmt = select(
        InventoryStock.location_id,
        InventoryStock.lot_number,
        InventoryStock.quantity_available,
    ).where(InventoryStock.quantity_available > 0)
    return list((await session.execute(stmt)).all())


async def count_children(session: AsyncSession, location_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Location)
        .where(Location.parent_location_id == location_id)
    )
    return int((await session.execute(stmt)).scalar_one())


async def location_has_stock(session: AsyncSession, location_id: uuid.UUID) -> bool:
    stmt = select(
        select(InventoryStock.id)
        .where(InventoryStock.location_id == location_id)
        .exists()
    )
    return bool((await session.execute(stmt)).scalar_one())


async def location_has_txn_lines(
    session: AsyncSession, location_id: uuid.UUID
) -> bool:
    stmt = select(
        select(InventoryTransactionLine.id)
        .where(
            (InventoryTransactionLine.from_location_id == location_id)
            | (InventoryTransactionLine.to_location_id == location_id)
        )
        .exists()
    )
    return bool((await session.execute(stmt)).scalar_one())


async def delete_location(session: AsyncSession, location: Location) -> None:
    """Hard delete. Caller must have verified the location is empty."""
    await session.delete(location)
    await session.flush()


async def create_location(
    session: AsyncSession,
    *,
    location_name: str,
    location_type: str,
    parent_location_id: uuid.UUID | None,
    is_active: bool,
) -> Location:
    """Insert a new location. Caller commits."""
    loc = Location(
        location_name=location_name,
        location_type=location_type,
        parent_location_id=parent_location_id,
        is_active=is_active,
    )
    session.add(loc)
    await session.flush()
    return loc
