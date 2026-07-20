"""Persistence helpers for the customer module.

Customers link to **finished-good items** via ``app.customer_items``. Products /
product_materials are gone (unified into items + bom_lines).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Select, asc, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import Item, ItemPrefix
from app.models.products import Customer, CustomerItem


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


async def items_for_customers(
    session: AsyncSession, customer_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str]]]:
    """Linked live finished-good items ``(id, label)`` per customer.

    The label is the item's description, prefixed with its item number so the
    chip reads e.g. "FG-0100 · Bioreactor Unit".
    """
    if not customer_ids:
        return {}
    # The item number is derived (``<prefix code>-<suffix>``), not a column, so
    # build it in SQL from the joined prefix code + the stored suffix.
    stmt = (
        select(
            CustomerItem.customer_id,
            Item.id,
            ItemPrefix.code,
            Item.sku_suffix,
            Item.description,
        )
        .join(Item, Item.id == CustomerItem.item_id)
        .join(ItemPrefix, ItemPrefix.id == Item.prefix_id)
        .where(
            CustomerItem.customer_id.in_(customer_ids),
            Item.deleted_at.is_(None),
        )
        .order_by(func.lower(Item.description))
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    for customer_id, iid, code, suffix, desc in (await session.execute(stmt)).all():
        out.setdefault(customer_id, []).append((iid, f"{code}-{suffix} · {desc}"))
    return out


async def get_customer_item_ids(
    session: AsyncSession, customer_id: uuid.UUID
) -> set[uuid.UUID]:
    stmt = select(CustomerItem.item_id).where(
        CustomerItem.customer_id == customer_id
    )
    return set((await session.execute(stmt)).scalars().all())


async def set_customer_items(
    session: AsyncSession,
    *,
    customer_id: uuid.UUID,
    item_ids: list[uuid.UUID],
    created_by_user_id: uuid.UUID,
) -> None:
    """Reconcile a customer's linked items to exactly ``item_ids``.

    Hard inserts/deletes on the link table. Caller commits.
    """
    current = await get_customer_item_ids(session, customer_id)
    desired = set(item_ids)
    to_remove = current - desired
    to_add = desired - current
    if to_remove:
        await session.execute(
            delete(CustomerItem).where(
                CustomerItem.customer_id == customer_id,
                CustomerItem.item_id.in_(to_remove),
            )
        )
    for iid in to_add:
        session.add(
            CustomerItem(
                customer_id=customer_id,
                item_id=iid,
                created_by_user_id=created_by_user_id,
            )
        )
    await session.flush()
