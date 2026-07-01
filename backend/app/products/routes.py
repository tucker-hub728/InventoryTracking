"""``/v1/customers`` routes.

Master-data writes, same gate as vendors/items: reads need ``inventory:view``,
writes need ``inventory:create``. Updates + deletes are audit-logged via
``record_entity_change``. No e-signature — these aren't GxP stock movements.

Customers link to **finished-good items** (built items) many-to-many, managed
from the customer payload's ``item_ids``.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.models.products import Customer
from app.products import repository as products_repo
from app.products.schemas import (
    CustomerCreate,
    CustomerRead,
    CustomerUpdate,
    LinkedRef,
)
from app.security.permissions import RequirePermission

customers_router = APIRouter(prefix="/customers", tags=["customers"])


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


def _customer_to_read(
    customer: Customer, items: list[LinkedRef] | None = None
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
        items=items or [],
    )


async def _validate_item_ids(db: DBSession, item_ids: list[str]) -> list[uuid.UUID]:
    """Each id must be an existing built (finished-good) item."""
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for raw in item_ids:
        iu = _parse_uuid_or_422(raw, field="item_id")
        if iu in seen:
            continue
        item = await inv_repo.get_item(db, iu)
        if item is None:
            raise NotFoundError(f"Item {raw} not found")
        if item.category is None or item.category.kind != "built":
            raise ValidationError(
                "Customers can only be linked to Product (built) items",
                code="item_not_built",
            )
        seen.add(iu)
        out.append(iu)
    return out


# ── Customers ──────────────────────────────────────────────────────────


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
    item_map = await products_repo.items_for_customers(db, ids)
    return [
        _customer_to_read(c, items=_refs(item_map.get(c.id, []))) for c in customers
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
    item_map = await products_repo.items_for_customers(db, [customer.id])
    return _customer_to_read(customer, items=_refs(item_map.get(customer.id, [])))


@customers_router.post(
    "",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a customer (details + linked finished-good items)",
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
    item_uuids = await _validate_item_ids(db, payload.item_ids)

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

    if item_uuids:
        await products_repo.set_customer_items(
            db,
            customer_id=customer.id,
            item_ids=item_uuids,
            created_by_user_id=current.id,
        )
    item_map = await products_repo.items_for_customers(db, [customer.id])
    response = _customer_to_read(customer, items=_refs(item_map.get(customer.id, [])))
    await db.commit()
    return response


@customers_router.patch(
    "/{customer_id}",
    response_model=CustomerRead,
    summary="Update a customer (details and/or linked items)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_customer(
    db: DBSession,
    current: CurrentDbUserDep,
    customer_id: Annotated[uuid.UUID, Path()],
    payload: CustomerUpdate,
) -> CustomerRead:
    data = payload.model_dump(exclude_unset=True)
    item_ids = data.pop("item_ids", None)
    column_patch = data  # name / contact_person / email, if set
    if not column_patch and item_ids is None:
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

    item_uuids: list[uuid.UUID] | None = None
    if item_ids is not None:
        item_uuids = await _validate_item_ids(db, item_ids)

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
    if item_uuids is not None:
        await products_repo.set_customer_items(
            db,
            customer_id=updated.id,
            item_ids=item_uuids,
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
    item_map = await products_repo.items_for_customers(db, [updated.id])
    response = _customer_to_read(updated, items=_refs(item_map.get(updated.id, [])))
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
