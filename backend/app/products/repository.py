"""Persistence helpers for the product module — products, materials, customers.

Same conventions as ``app.inventory.repository``: session first, caller
commits, creates flush-then-re-read so joined relationships hydrate. The
customer↔product link table is reconciled (hard insert/delete) by
``set_customer_products``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Select, asc, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.products import Customer, CustomerProduct, Product, ProductMaterial

# ── Products ───────────────────────────────────────────────────────────


async def list_products(
    session: AsyncSession, *, q: str | None = None
) -> list[Product]:
    """Products ordered by name. Master-data sized — no pagination."""
    stmt: Select[tuple[Product]] = select(Product).where(Product.deleted_at.is_(None))
    if q:
        stmt = stmt.where(func.lower(Product.name).like(f"%{q.lower()}%"))
    stmt = stmt.order_by(asc(func.lower(Product.name)))
    return list((await session.execute(stmt)).scalars().all())


async def get_product(session: AsyncSession, product_id: uuid.UUID) -> Product | None:
    stmt = select(Product).where(
        Product.id == product_id, Product.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_product_by_name(session: AsyncSession, name: str) -> Product | None:
    stmt = select(Product).where(
        func.lower(Product.name) == name.strip().lower(),
        Product.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_product_by_sku(session: AsyncSession, sku: str) -> Product | None:
    """Case-insensitive SKU lookup — mirrors the partial-unique index."""
    stmt = select(Product).where(
        func.lower(Product.sku) == sku.strip().lower(),
        Product.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_product(
    session: AsyncSession,
    *,
    name: str,
    sku: str,
    created_by_user_id: uuid.UUID,
) -> Product:
    """Insert a product row (no materials). Caller commits.

    ``sku`` is the user-supplied, immutable handle (unique among live rows).
    """
    product = Product(
        name=name.strip(),
        sku=sku.strip(),
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(product)
    await session.flush()
    refreshed = await get_product(session, product.id)
    assert refreshed is not None
    return refreshed


async def apply_product_patch(
    session: AsyncSession,
    *,
    product: Product,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> Product:
    for col, value in patch.items():
        if col == "name" and isinstance(value, str):
            value = value.strip()
        setattr(product, col, value)
    product.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_product(session, product.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_product(
    session: AsyncSession, *, product: Product, deleted_by_user_id: uuid.UUID
) -> Product:
    product.deleted_at = datetime.now(UTC)
    product.updated_by_user_id = deleted_by_user_id
    await session.flush()
    return product


def product_to_audit_snapshot(product: Product) -> dict[str, object | None]:
    return {
        "name": product.name,
        "sku": product.sku,
        "deleted_at": product.deleted_at.isoformat() if product.deleted_at else None,
    }


async def material_counts(
    session: AsyncSession, product_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Live material count per product, in one grouped query."""
    if not product_ids:
        return {}
    stmt = (
        select(ProductMaterial.product_id, func.count())
        .where(
            ProductMaterial.product_id.in_(product_ids),
            ProductMaterial.deleted_at.is_(None),
        )
        .group_by(ProductMaterial.product_id)
    )
    rows = (await session.execute(stmt)).all()
    return {pid: int(n) for pid, n in rows}


async def list_products_using_item(
    session: AsyncSession, *, item_id: uuid.UUID
) -> list[tuple[Product, Decimal]]:
    """Live products whose bill of materials includes ``item_id``.

    The inverse of a product's BOM — backs the "Products" tab on an
    inventory item. Name-sorted; one row per product (unique per
    ``(product, item)``). Each row is paired with the qty of *this* item
    consumed per production run of that product.
    """
    stmt = (
        select(Product, ProductMaterial.qty_per_run)
        .join(ProductMaterial, ProductMaterial.product_id == Product.id)
        .where(
            ProductMaterial.item_id == item_id,
            ProductMaterial.deleted_at.is_(None),
            Product.deleted_at.is_(None),
        )
        .order_by(asc(func.lower(Product.name)))
    )
    return [(p, qty) for p, qty in (await session.execute(stmt)).unique().all()]


async def customers_for_products(
    session: AsyncSession, product_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str]]]:
    """Linked live customers (id, name) per product, for the list badges."""
    if not product_ids:
        return {}
    stmt = (
        select(CustomerProduct.product_id, Customer.id, Customer.name)
        .join(Customer, Customer.id == CustomerProduct.customer_id)
        .where(
            CustomerProduct.product_id.in_(product_ids),
            Customer.deleted_at.is_(None),
        )
        .order_by(func.lower(Customer.name))
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    for product_id, cid, cname in (await session.execute(stmt)).all():
        out.setdefault(product_id, []).append((cid, cname))
    return out


# ── Materials (bill of materials) ──────────────────────────────────────


async def list_product_materials(
    session: AsyncSession, *, product_id: uuid.UUID
) -> list[ProductMaterial]:
    """Live materials for a product, item (+ stock) joined, item-number sorted."""
    stmt = select(ProductMaterial).where(
        ProductMaterial.product_id == product_id,
        ProductMaterial.deleted_at.is_(None),
    )
    rows = list((await session.execute(stmt)).scalars().unique().all())
    rows.sort(key=lambda m: m.item.item_number if m.item else "")
    return rows


async def get_material(
    session: AsyncSession, material_id: uuid.UUID
) -> ProductMaterial | None:
    stmt = select(ProductMaterial).where(
        ProductMaterial.id == material_id, ProductMaterial.deleted_at.is_(None)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_material_by_product_item(
    session: AsyncSession, *, product_id: uuid.UUID, item_id: uuid.UUID
) -> ProductMaterial | None:
    stmt = select(ProductMaterial).where(
        ProductMaterial.product_id == product_id,
        ProductMaterial.item_id == item_id,
        ProductMaterial.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create_material(
    session: AsyncSession,
    *,
    product_id: uuid.UUID,
    item_id: uuid.UUID,
    qty_per_run: Decimal,
    created_by_user_id: uuid.UUID,
) -> ProductMaterial:
    """Insert a material row. Caller commits."""
    material = ProductMaterial(
        product_id=product_id,
        item_id=item_id,
        qty_per_run=qty_per_run,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    session.add(material)
    await session.flush()
    refreshed = await get_material(session, material.id)
    assert refreshed is not None
    return refreshed


async def apply_material_patch(
    session: AsyncSession,
    *,
    material: ProductMaterial,
    patch: dict[str, object],
    updated_by_user_id: uuid.UUID,
) -> ProductMaterial:
    for col, value in patch.items():
        setattr(material, col, value)
    material.updated_by_user_id = updated_by_user_id
    await session.flush()
    refreshed = await get_material(session, material.id)
    assert refreshed is not None
    return refreshed


async def soft_delete_material(
    session: AsyncSession,
    *,
    material: ProductMaterial,
    deleted_by_user_id: uuid.UUID,
) -> ProductMaterial:
    material.deleted_at = datetime.now(UTC)
    material.updated_by_user_id = deleted_by_user_id
    await session.flush()
    return material


def material_to_audit_snapshot(material: ProductMaterial) -> dict[str, object | None]:
    return {
        "product_id": str(material.product_id),
        "item_id": str(material.item_id),
        "item_number": material.item.item_number if material.item else None,
        "qty_per_run": str(material.qty_per_run),
        "deleted_at": material.deleted_at.isoformat() if material.deleted_at else None,
    }


# ── Customers ──────────────────────────────────────────────────────────


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


async def products_for_customers(
    session: AsyncSession, customer_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str]]]:
    """Linked live products (id, name) per customer, for the list badges."""
    if not customer_ids:
        return {}
    stmt = (
        select(CustomerProduct.customer_id, Product.id, Product.name)
        .join(Product, Product.id == CustomerProduct.product_id)
        .where(
            CustomerProduct.customer_id.in_(customer_ids),
            Product.deleted_at.is_(None),
        )
        .order_by(func.lower(Product.name))
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    for customer_id, pid, pname in (await session.execute(stmt)).all():
        out.setdefault(customer_id, []).append((pid, pname))
    return out


async def get_customer_product_ids(
    session: AsyncSession, customer_id: uuid.UUID
) -> set[uuid.UUID]:
    stmt = select(CustomerProduct.product_id).where(
        CustomerProduct.customer_id == customer_id
    )
    return set((await session.execute(stmt)).scalars().all())


async def set_customer_products(
    session: AsyncSession,
    *,
    customer_id: uuid.UUID,
    product_ids: list[uuid.UUID],
    created_by_user_id: uuid.UUID,
) -> None:
    """Reconcile a customer's product links to exactly ``product_ids``.

    Hard inserts/deletes on the link table. Caller commits.
    """
    current = await get_customer_product_ids(session, customer_id)
    desired = set(product_ids)
    to_remove = current - desired
    to_add = desired - current
    if to_remove:
        await session.execute(
            delete(CustomerProduct).where(
                CustomerProduct.customer_id == customer_id,
                CustomerProduct.product_id.in_(to_remove),
            )
        )
    for pid in to_add:
        session.add(
            CustomerProduct(
                customer_id=customer_id,
                product_id=pid,
                created_by_user_id=created_by_user_id,
            )
        )
    await session.flush()
