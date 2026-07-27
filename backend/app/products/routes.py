"""``/v1/customers`` routes.

Master-data writes, same gate as suppliers/items: reads need ``inventory:view``,
writes need ``inventory:create``. Updates + deletes are audit-logged via
``record_entity_change``. No e-signature — these aren't GxP stock movements.

A customer is simple master data (name / contact / email). Customers are NOT
linked to inventory items — the part number is the source of truth for inventory
identity; a shipment names a customer at ship time.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.models.products import Customer
from app.products import repository as products_repo
from app.products.schemas import CustomerCreate, CustomerRead, CustomerUpdate
from app.security.permissions import RequirePermission

customers_router = APIRouter(prefix="/customers", tags=["customers"])


# ── Helpers ────────────────────────────────────────────────────────────


def _customer_to_read(customer: Customer) -> CustomerRead:
    return CustomerRead(
        id=str(customer.id),
        name=customer.name,
        contact_person=customer.contact_person,
        email=customer.email,
        created_at=customer.created_at,
        updated_at=customer.updated_at,
        created_by_user_id=str(customer.created_by_user_id),
        updated_by_user_id=str(customer.updated_by_user_id),
    )


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
    return [_customer_to_read(c) for c in customers]


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
    return _customer_to_read(customer)


@customers_router.post(
    "",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a customer",
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

    response = _customer_to_read(customer)
    await db.commit()
    return response


@customers_router.patch(
    "/{customer_id}",
    response_model=CustomerRead,
    summary="Update a customer",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_customer(
    db: DBSession,
    current: CurrentDbUserDep,
    customer_id: Annotated[uuid.UUID, Path()],
    payload: CustomerUpdate,
) -> CustomerRead:
    column_patch = payload.model_dump(exclude_unset=True)  # name / contact / email
    if not column_patch:
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
    response = _customer_to_read(updated)
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
