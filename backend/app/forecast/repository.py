"""Persistence helpers for the forecast module — planning cells.

Same conventions as ``app.products.repository``: session first, caller commits.
Forecast cells are **hard-deleted** (no soft-delete), and ``customer_id`` is
optional (NULL = product-level / "Unassigned"), so lookups are null-aware.
"""

from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.forecast import ForecastEntry
from app.models.inventory import Item
from app.models.products import Customer


async def list_forecast_entries(
    session: AsyncSession,
    *,
    year: int,
    product_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
) -> list[ForecastEntry]:
    """Live forecast cells for a year. Only entries on live products (and a
    live customer, or none) are returned; ordered Unassigned-first, then by
    SKU and month.
    """
    stmt = (
        select(ForecastEntry)
        .join(Item, Item.id == ForecastEntry.product_id)
        .outerjoin(Customer, Customer.id == ForecastEntry.customer_id)
        .where(
            ForecastEntry.forecast_year == year,
            Item.deleted_at.is_(None),
            or_(
                ForecastEntry.customer_id.is_(None),
                Customer.deleted_at.is_(None),
            ),
        )
    )
    if product_id is not None:
        stmt = stmt.where(ForecastEntry.product_id == product_id)
    if customer_id is not None:
        stmt = stmt.where(ForecastEntry.customer_id == customer_id)

    rows = list((await session.execute(stmt)).scalars().unique().all())
    # Unassigned (no customer) sorts first, then by customer name, item #, month.
    rows.sort(
        key=lambda e: (
            e.customer.name.lower() if e.customer else "",
            e.product.item_number.lower() if e.product else "",
            e.forecast_month,
        )
    )
    return rows


async def get_entry(
    session: AsyncSession,
    *,
    customer_id: uuid.UUID | None,
    product_id: uuid.UUID,
    year: int,
    month: int,
) -> ForecastEntry | None:
    """Fetch the single cell for the key (null-aware on ``customer_id``)."""
    stmt = select(ForecastEntry).where(
        ForecastEntry.product_id == product_id,
        ForecastEntry.forecast_year == year,
        ForecastEntry.forecast_month == month,
    )
    if customer_id is None:
        stmt = stmt.where(ForecastEntry.customer_id.is_(None))
    else:
        stmt = stmt.where(ForecastEntry.customer_id == customer_id)
    return (await session.execute(stmt)).scalars().unique().one_or_none()


async def create_entry(
    session: AsyncSession,
    *,
    product_id: uuid.UUID,
    customer_id: uuid.UUID | None,
    year: int,
    month: int,
    runs: int,
    created_by_user_id: uuid.UUID,
) -> ForecastEntry:
    """Insert a forecast cell. Caller commits."""
    entry = ForecastEntry(
        product_id=product_id,
        customer_id=customer_id,
        forecast_year=year,
        forecast_month=month,
        runs=runs,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(entry)
    await session.flush()
    return entry


async def update_runs(
    session: AsyncSession,
    *,
    entry: ForecastEntry,
    runs: int,
    updated_by_user_id: uuid.UUID,
) -> ForecastEntry:
    """Update a cell's run count in place."""
    entry.runs = runs
    entry.updated_by_user_id = updated_by_user_id
    await session.flush()
    return entry


async def delete_entry(session: AsyncSession, *, entry: ForecastEntry) -> None:
    """Hard-delete a forecast cell (clearing it)."""
    await session.delete(entry)
    await session.flush()
