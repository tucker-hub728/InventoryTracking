"""``/v1/products``, ``/v1/product-materials`` and ``/v1/customers`` routes.

Master-data writes, same gate as vendors/items: reads need ``inventory:view``,
writes need ``inventory:create``. Updates + deletes are audit-logged via
``record_entity_change`` (creates are recorded by the row's own
``created_by_user_id`` / ``created_at``, matching the inventory module). No
e-signature — these aren't GxP stock movements.

A product is a name + a bill of materials (inventory items × qty/run).
Customers link to products many-to-many (managed from the customer payload's
``product_ids``).
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.models.products import Customer, Product, ProductMaterial
from app.products import repository as products_repo
from app.products.schemas import (
    CustomerCreate,
    CustomerRead,
    CustomerUpdate,
    LinkedRef,
    MaterialCreate,
    MaterialUpdate,
    ProductCreate,
    ProductMaterialRead,
    ProductRead,
    ProductUpdate,
)
from app.security.permissions import RequirePermission

products_router = APIRouter(prefix="/products", tags=["products"])
materials_router = APIRouter(prefix="/product-materials", tags=["product-materials"])
customers_router = APIRouter(prefix="/customers", tags=["customers"])
# A product is built from inventory items — this `/items`-prefixed router
# carries the inverse "which products use this item" view, without coupling
# the inventory module to products. Mounted alongside the inventory router.
item_products_router = APIRouter(prefix="/items", tags=["products"])


# ── Helpers ────────────────────────────────────────────────────────────


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(
            f"{field} is not a valid UUID", code=f"invalid_{field}"
        ) from exc


def _refs(pairs: list[tuple[uuid.UUID, str]]) -> list[LinkedRef]:
    return [LinkedRef(id=str(i), name=n) for i, n in pairs]


def _product_to_read(
    product: Product,
    *,
    material_count: int = 0,
    customers: list[LinkedRef] | None = None,
    qty_per_run: Decimal | None = None,
) -> ProductRead:
    return ProductRead(
        id=str(product.id),
        name=product.name,
        sku=product.sku,
        created_at=product.created_at,
        updated_at=product.updated_at,
        created_by_user_id=str(product.created_by_user_id),
        updated_by_user_id=str(product.updated_by_user_id),
        material_count=material_count,
        customers=customers or [],
        qty_per_run=qty_per_run,
    )


def _material_to_read(m: ProductMaterial) -> ProductMaterialRead:
    item = m.item
    stock = item.stock if item else None
    qty_on_hand = stock.qty_on_hand if stock else Decimal("0")
    qty_available = stock.qty_available if stock else Decimal("0")
    status_code = stock.status_code if stock else "out_of_stock"
    return ProductMaterialRead(
        id=str(m.id),
        item_id=str(m.item_id),
        item_number=item.item_number if item else "",
        item_name=item.description if item else "",
        qty_per_run=m.qty_per_run,
        qty_on_hand=qty_on_hand,
        qty_available=qty_available,
        status_code=status_code,  # type: ignore[arg-type]
    )


def _customer_to_read(
    customer: Customer, *, products: list[LinkedRef] | None = None
) -> CustomerRead:
    return CustomerRead(
        id=str(customer.id),
        name=customer.name,
        contact_person=customer.contact_person,
        email=customer.email,
        created_at=customer.created_at,
        updated_at=customer.updated_at,
        created_by_user_id=str(customer.created_by_user_id),
        updated_by_user_id=str(customer.updated_by_user_id),
        products=products or [],
    )


# ── Products ───────────────────────────────────────────────────────────


@products_router.get(
    "",
    response_model=list[ProductRead],
    summary="List products",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_products(
    db: DBSession,
    q: Annotated[str | None, Query(description="Search product name")] = None,
) -> list[ProductRead]:
    products = await products_repo.list_products(db, q=q)
    ids = [p.id for p in products]
    counts = await products_repo.material_counts(db, ids)
    cust_map = await products_repo.customers_for_products(db, ids)
    return [
        _product_to_read(
            p,
            material_count=counts.get(p.id, 0),
            customers=_refs(cust_map.get(p.id, [])),
        )
        for p in products
    ]


@products_router.get(
    "/{product_id}",
    response_model=ProductRead,
    summary="Get one product",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_product(
    db: DBSession, product_id: Annotated[uuid.UUID, Path()]
) -> ProductRead:
    product = await products_repo.get_product(db, product_id)
    if product is None:
        raise NotFoundError(f"Product {product_id} not found")
    counts = await products_repo.material_counts(db, [product.id])
    cust_map = await products_repo.customers_for_products(db, [product.id])
    return _product_to_read(
        product,
        material_count=counts.get(product.id, 0),
        customers=_refs(cust_map.get(product.id, [])),
    )


@products_router.post(
    "",
    response_model=ProductRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a product (name + bill of materials)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_product(
    db: DBSession, current: CurrentDbUserDep, payload: ProductCreate
) -> ProductRead:
    if (await products_repo.get_product_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"A product named '{payload.name}' already exists",
            code="product_name_conflict",
        )
    if (await products_repo.get_product_by_sku(db, payload.sku)) is not None:
        raise ConflictError(
            f"SKU '{payload.sku}' is already in use",
            code="product_sku_conflict",
        )

    # Validate + dedup the inline materials before creating anything.
    seen: set[uuid.UUID] = set()
    parsed: list[tuple[uuid.UUID, Decimal]] = []
    for m in payload.materials:
        item_uuid = _parse_uuid_or_422(m.item_id, field="item_id")
        if item_uuid in seen:
            raise ValidationError(
                "The same material appears more than once",
                code="duplicate_material",
            )
        if (await inv_repo.get_item(db, item_uuid)) is None:
            raise NotFoundError(f"Item {m.item_id} not found")
        seen.add(item_uuid)
        parsed.append((item_uuid, m.qty_per_run))

    try:
        product = await products_repo.create_product(
            db, name=payload.name, sku=payload.sku, created_by_user_id=current.id
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_products_name" in msg:
            raise ConflictError(
                f"A product named '{payload.name}' already exists",
                code="product_name_conflict",
            ) from exc
        if "uq_products_sku" in msg:
            raise ConflictError(
                "Could not generate a unique SKU for that name; "
                "try a slightly different name.",
                code="product_sku_conflict",
            ) from exc
        raise

    for item_uuid, qty in parsed:
        await products_repo.create_material(
            db,
            product_id=product.id,
            item_id=item_uuid,
            qty_per_run=qty,
            created_by_user_id=current.id,
        )

    return _product_to_read(product, material_count=len(parsed), customers=[])


@products_router.patch(
    "/{product_id}",
    response_model=ProductRead,
    summary="Update a product (name)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_product(
    db: DBSession,
    current: CurrentDbUserDep,
    product_id: Annotated[uuid.UUID, Path()],
    payload: ProductUpdate,
) -> ProductRead:
    patch = payload.model_dump(exclude_unset=True)
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    product = await products_repo.get_product(db, product_id)
    if product is None:
        raise NotFoundError(f"Product {product_id} not found")

    if "name" in patch and isinstance(patch["name"], str):
        if patch["name"].strip().lower() != product.name.lower():
            existing = await products_repo.get_product_by_name(db, patch["name"])
            if existing is not None and existing.id != product.id:
                raise ConflictError(
                    f"A product named '{patch['name']}' already exists",
                    code="product_name_conflict",
                )

    before = products_repo.product_to_audit_snapshot(product)
    try:
        updated = await products_repo.apply_product_patch(
            db, product=product, patch=patch, updated_by_user_id=current.id
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_products_name" in msg:
            raise ConflictError(
                "Product name conflict", code="product_name_conflict"
            ) from exc
        raise
    after = products_repo.product_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.products",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    counts = await products_repo.material_counts(db, [updated.id])
    cust_map = await products_repo.customers_for_products(db, [updated.id])
    response = _product_to_read(
        updated,
        material_count=counts.get(updated.id, 0),
        customers=_refs(cust_map.get(updated.id, [])),
    )
    await db.commit()
    return response


@products_router.delete(
    "/{product_id}",
    response_model=ProductRead,
    summary="Soft-delete a product (deleted_at stamp)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_product(
    db: DBSession,
    current: CurrentDbUserDep,
    product_id: Annotated[uuid.UUID, Path()],
) -> ProductRead:
    product = await products_repo.get_product(db, product_id)
    if product is None:
        raise NotFoundError(f"Product {product_id} not found")
    if product.deleted_at is not None:
        return _product_to_read(product)

    before = products_repo.product_to_audit_snapshot(product)
    deleted = await products_repo.soft_delete_product(
        db, product=product, deleted_by_user_id=current.id
    )
    after = products_repo.product_to_audit_snapshot(deleted)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.products",
        subject_id=deleted.id,
        subject_label=deleted.name,
        before=before,
        after=after,
    )

    await db.refresh(deleted)
    response = _product_to_read(deleted)
    await db.commit()
    return response


# ── Materials (bill of materials) ──────────────────────────────────────


@products_router.get(
    "/{product_id}/materials",
    response_model=list[ProductMaterialRead],
    summary="List a product's required materials with live stock",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_materials(
    db: DBSession, product_id: Annotated[uuid.UUID, Path()]
) -> list[ProductMaterialRead]:
    product = await products_repo.get_product(db, product_id)
    if product is None:
        raise NotFoundError(f"Product {product_id} not found")
    materials = await products_repo.list_product_materials(db, product_id=product_id)
    return [_material_to_read(m) for m in materials]


@products_router.post(
    "/{product_id}/materials",
    response_model=ProductMaterialRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a required material to a product",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def add_material(
    db: DBSession,
    current: CurrentDbUserDep,
    product_id: Annotated[uuid.UUID, Path()],
    payload: MaterialCreate,
) -> ProductMaterialRead:
    product = await products_repo.get_product(db, product_id)
    if product is None:
        raise NotFoundError(f"Product {product_id} not found")

    item_uuid = _parse_uuid_or_422(payload.item_id, field="item_id")
    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {payload.item_id} not found")

    if (
        await products_repo.get_material_by_product_item(
            db, product_id=product_id, item_id=item_uuid
        )
    ) is not None:
        raise ConflictError(
            f"{item.item_number} is already a material of this product",
            code="material_conflict",
        )

    try:
        material = await products_repo.create_material(
            db,
            product_id=product_id,
            item_id=item_uuid,
            qty_per_run=payload.qty_per_run,
            created_by_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_product_materials" in msg:
            raise ConflictError(
                f"{item.item_number} is already a material of this product",
                code="material_conflict",
            ) from exc
        if "ck_product_materials_qty_per_run_positive" in msg:
            raise ValidationError(
                "qty_per_run must be greater than zero",
                code="qty_per_run_invalid",
            ) from exc
        raise
    return _material_to_read(material)


@materials_router.patch(
    "/{material_id}",
    response_model=ProductMaterialRead,
    summary="Update a material (qty per run)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_material(
    db: DBSession,
    current: CurrentDbUserDep,
    material_id: Annotated[uuid.UUID, Path()],
    payload: MaterialUpdate,
) -> ProductMaterialRead:
    material = await products_repo.get_material(db, material_id)
    if material is None:
        raise NotFoundError(f"Material {material_id} not found")

    before = products_repo.material_to_audit_snapshot(material)
    label = (
        f"{material.product.name if material.product else material.product_id} · "
        f"{material.item.item_number if material.item else material.item_id}"
    )
    updated = await products_repo.apply_material_patch(
        db,
        material=material,
        patch={"qty_per_run": payload.qty_per_run},
        updated_by_user_id=current.id,
    )
    after = products_repo.material_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.product_materials",
        subject_id=updated.id,
        subject_label=label,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    response = _material_to_read(updated)
    await db.commit()
    return response


@materials_router.delete(
    "/{material_id}",
    response_model=ProductMaterialRead,
    summary="Remove a material from a product (soft delete)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_material(
    db: DBSession,
    current: CurrentDbUserDep,
    material_id: Annotated[uuid.UUID, Path()],
) -> ProductMaterialRead:
    material = await products_repo.get_material(db, material_id)
    if material is None:
        raise NotFoundError(f"Material {material_id} not found")

    before = products_repo.material_to_audit_snapshot(material)
    label = (
        f"{material.product.name if material.product else material.product_id} · "
        f"{material.item.item_number if material.item else material.item_id}"
    )
    deleted = await products_repo.soft_delete_material(
        db, material=material, deleted_by_user_id=current.id
    )
    after = products_repo.material_to_audit_snapshot(deleted)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.product_materials",
        subject_id=deleted.id,
        subject_label=label,
        before=before,
        after=after,
    )

    await db.refresh(deleted)
    response = _material_to_read(deleted)
    await db.commit()
    return response


# ── Customers ──────────────────────────────────────────────────────────


async def _validate_product_ids(
    db: DBSession, product_ids: list[str]
) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for pid in product_ids:
        pu = _parse_uuid_or_422(pid, field="product_id")
        if pu in seen:
            continue
        if (await products_repo.get_product(db, pu)) is None:
            raise NotFoundError(f"Product {pid} not found")
        seen.add(pu)
        out.append(pu)
    return out


@customers_router.get(
    "",
    response_model=list[CustomerRead],
    summary="List customers",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_customers(
    db: DBSession,
    q: Annotated[str | None, Query(description="Search name/contact/email")] = None,
) -> list[CustomerRead]:
    customers = await products_repo.list_customers(db, q=q)
    ids = [c.id for c in customers]
    prod_map = await products_repo.products_for_customers(db, ids)
    return [
        _customer_to_read(c, products=_refs(prod_map.get(c.id, [])))
        for c in customers
    ]


@customers_router.get(
    "/{customer_id}",
    response_model=CustomerRead,
    summary="Get one customer",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_customer(
    db: DBSession, customer_id: Annotated[uuid.UUID, Path()]
) -> CustomerRead:
    customer = await products_repo.get_customer(db, customer_id)
    if customer is None:
        raise NotFoundError(f"Customer {customer_id} not found")
    prod_map = await products_repo.products_for_customers(db, [customer.id])
    return _customer_to_read(customer, products=_refs(prod_map.get(customer.id, [])))


@customers_router.post(
    "",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a customer (details + linked products)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_customer(
    db: DBSession, current: CurrentDbUserDep, payload: CustomerCreate
) -> CustomerRead:
    if (await products_repo.get_customer_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"A customer named '{payload.name}' already exists",
            code="customer_name_conflict",
        )
    product_uuids = await _validate_product_ids(db, payload.product_ids)

    try:
        customer = await products_repo.create_customer(
            db,
            name=payload.name,
            created_by_user_id=current.id,
            contact_person=payload.contact_person,
            email=payload.email,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_customers_name" in msg:
            raise ConflictError(
                f"A customer named '{payload.name}' already exists",
                code="customer_name_conflict",
            ) from exc
        raise

    if product_uuids:
        await products_repo.set_customer_products(
            db,
            customer_id=customer.id,
            product_ids=product_uuids,
            created_by_user_id=current.id,
        )
    prod_map = await products_repo.products_for_customers(db, [customer.id])
    return _customer_to_read(customer, products=_refs(prod_map.get(customer.id, [])))


@customers_router.patch(
    "/{customer_id}",
    response_model=CustomerRead,
    summary="Update a customer (details and/or linked products)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_customer(
    db: DBSession,
    current: CurrentDbUserDep,
    customer_id: Annotated[uuid.UUID, Path()],
    payload: CustomerUpdate,
) -> CustomerRead:
    data = payload.model_dump(exclude_unset=True)
    product_ids = data.pop("product_ids", None)
    column_patch = data  # name / contact_person / email, if set
    if not column_patch and product_ids is None:
        raise ValidationError("No fields to update", code="empty_patch")

    customer = await products_repo.get_customer(db, customer_id)
    if customer is None:
        raise NotFoundError(f"Customer {customer_id} not found")

    if "name" in column_patch and isinstance(column_patch["name"], str):
        if column_patch["name"].strip().lower() != customer.name.lower():
            existing = await products_repo.get_customer_by_name(
                db, column_patch["name"]
            )
            if existing is not None and existing.id != customer.id:
                raise ConflictError(
                    f"A customer named '{column_patch['name']}' already exists",
                    code="customer_name_conflict",
                )

    # Validate the new link set (if provided) before mutating anything.
    product_uuids: list[uuid.UUID] | None = None
    if product_ids is not None:
        product_uuids = await _validate_product_ids(db, product_ids)

    before = products_repo.customer_to_audit_snapshot(customer)
    try:
        updated = await products_repo.apply_customer_patch(
            db, customer=customer, patch=column_patch, updated_by_user_id=current.id
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_customers_name" in msg:
            raise ConflictError(
                "Customer name conflict", code="customer_name_conflict"
            ) from exc
        raise
    if product_uuids is not None:
        await products_repo.set_customer_products(
            db,
            customer_id=updated.id,
            product_ids=product_uuids,
            created_by_user_id=current.id,
        )
    after = products_repo.customer_to_audit_snapshot(updated)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.customers",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
    )

    await db.refresh(updated)
    prod_map = await products_repo.products_for_customers(db, [updated.id])
    response = _customer_to_read(updated, products=_refs(prod_map.get(updated.id, [])))
    await db.commit()
    return response


@customers_router.delete(
    "/{customer_id}",
    response_model=CustomerRead,
    summary="Soft-delete a customer (deleted_at stamp)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def delete_customer(
    db: DBSession,
    current: CurrentDbUserDep,
    customer_id: Annotated[uuid.UUID, Path()],
) -> CustomerRead:
    customer = await products_repo.get_customer(db, customer_id)
    if customer is None:
        raise NotFoundError(f"Customer {customer_id} not found")
    if customer.deleted_at is not None:
        return _customer_to_read(customer)

    before = products_repo.customer_to_audit_snapshot(customer)
    deleted = await products_repo.soft_delete_customer(
        db, customer=customer, deleted_by_user_id=current.id
    )
    after = products_repo.customer_to_audit_snapshot(deleted)

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.customers",
        subject_id=deleted.id,
        subject_label=deleted.name,
        before=before,
        after=after,
    )

    await db.refresh(deleted)
    response = _customer_to_read(deleted)
    await db.commit()
    return response


# ── Inventory item → products (inverse BOM) ────────────────────────────


@item_products_router.get(
    "/{item_id}/products",
    response_model=list[ProductRead],
    summary="List products whose bill of materials uses this inventory item",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_products(
    db: DBSession, item_id: Annotated[uuid.UUID, Path()]
) -> list[ProductRead]:
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    rows = await products_repo.list_products_using_item(db, item_id=item_id)
    counts = await products_repo.material_counts(db, [p.id for p, _ in rows])
    return [
        _product_to_read(p, material_count=counts.get(p.id, 0), qty_per_run=qty)
        for p, qty in rows
    ]
