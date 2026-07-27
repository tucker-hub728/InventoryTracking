"""Persistence helpers for the customer module.

A customer is simple master data (name / contact / email). Customers are NOT
linked to inventory items — the part number is the source of truth for inventory
identity; shipments name a customer at ship time.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Select, asc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.products import Customer


async def list_customers(
    session: AsyncSession, *, q: str | None = None
) -> list[Customer]:
    stmt: Select[tuple[Customer]] = select(Customer).where(
        Customer.deleted_at.is_(None)
    )
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Customer.name).like(like),
                func.lower(func.coalesce(Customer.contact_person, "")).like(like),
                func.lower(func.coalesce(Customer.email, "")).like(like),
            )
        )
    stmt = stmt.order_by(asc(func.lower(Customer.name)))
    return list((await session.execute(stmt)).scalars().all())


async def get_customer(
    session: AsyncSession, customer_id: uuid.UUID
) -> Customer | None:
    stmt = select(Customer).where(
        Customer.id == customer_id, Customer.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_customer_by_name(session: AsyncSession, name: str) -> Customer | None:
    stmt = select(Customer).where(
        func.lower(Customer.name) == name.strip().lower(),
        Customer.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_customer(
    session: AsyncSession,
    *,
    name: str,
    created_by_user_id: uuid.UUID,
    contact_person: str | None = None,
    email: str | None = None,
) -> Customer:
    """Insert a customer row (links set separately). Caller commits."""
    customer = Customer(
        name=name.strip(),
        contact_person=contact_person,
        email=email,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(customer)
    await session.flush()
    refreshed = await get_customer(session, customer.id)
    assert refreshed is not None
    return refreshed


async def apply_customer_patch(
    session: AsyncSession,
    *,
    customer: Customer,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> Customer:
    for col, value in patch.items():
        if col == "name" and isinstance(value, str):
            value = value.strip()
        setattr(customer, col, value)
    customer.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_customer(session, customer.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_customer(
    session: AsyncSession, *, customer: Customer, deleted_by_user_id: uuid.UUID
) -> Customer:
    customer.deleted_at = datetime.now(UTC)
    customer.updated_by_user_id = deleted_by_user_id
    await session.flush()
    return customer


def customer_to_audit_snapshot(customer: Customer) -> dict[str, object | None]:
    return {
        "name": customer.name,
        "contact_person": customer.contact_person,
        "email": customer.email,
        "deleted_at": customer.deleted_at.isoformat() if customer.deleted_at else None,
    }
