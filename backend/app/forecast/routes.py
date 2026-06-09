"""``/v1/forecasts`` routes — list + e-signed batch save.

Reads need ``inventory:view``. The batch **save** is a GxP-significant, e-signed
action gated on ``inventory:sign``: it mirrors the stock-movement flow —
validate + apply the cell changes, ``consume_reauth_evidence`` (replay-guarded),
then one ``record_entity_change`` audit row linked to the signature, all in a
single transaction.

A forecast cell is product (optionally customer) × year × month → runs. Cells
are hard-deleted, so a change with ``runs = 0`` removes that cell.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import NotFoundError, ValidationError
from app.forecast import repository as forecast_repo
from app.forecast.schemas import (
    ForecastEntryRead,
    ForecastSaveRequest,
    ForecastSaveResult,
)
from app.models.forecast import ForecastEntry
from app.products import repository as products_repo
from app.security.permissions import RequirePermission

forecasts_router = APIRouter(prefix="/forecasts", tags=["forecasts"])

#: Reauth action verb minted by the frontend before a save.
FORECAST_SAVE_ACTION = "forecast.save"

#: Cap how many per-cell diffs we embed in the audit row's ``after`` so a huge
#: paste doesn't balloon the audit table. The counts are always exact.
_MAX_AUDIT_CHANGES = 500


# ── Helpers ────────────────────────────────────────────────────────────


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


def _entry_to_read(e: ForecastEntry) -> ForecastEntryRead:
    return ForecastEntryRead(
        id=str(e.id),
        product_id=str(e.product_id),
        product_sku=e.product.sku if e.product else "",
        product_name=e.product.name if e.product else "",
        customer_id=str(e.customer_id) if e.customer_id else None,
        customer_name=e.customer.name if e.customer else None,
        year=e.forecast_year,
        month=e.forecast_month,
        runs=e.runs,
    )


# ── Routes ─────────────────────────────────────────────────────────────


@forecasts_router.get(
    "",
    response_model=list[ForecastEntryRead],
    summary="List forecast cells for a year",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_forecasts(
    db: DBSession,
    year: Annotated[int | None, Query(description="Calendar year")] = None,
    product_id: Annotated[str | None, Query(description="Filter by product")] = None,
    customer_id: Annotated[str | None, Query(description="Filter by customer")] = None,
) -> list[ForecastEntryRead]:
    target_year = year if year is not None else datetime.now(UTC).year
    product_uuid = _parse_uuid_or_422(product_id, field="product_id") if product_id else None
    customer_uuid = _parse_uuid_or_422(customer_id, field="customer_id") if customer_id else None
    rows = await forecast_repo.list_forecast_entries(
        db, year=target_year, product_id=product_uuid, customer_id=customer_uuid
    )
    return [_entry_to_read(r) for r in rows]


@forecasts_router.put(
    "",
    response_model=ForecastSaveResult,
    summary="Save a batch of forecast cell changes (e-signed)",
    # GxP-significant: requires a fresh reauth evidence id for
    # action='forecast.save', like a stock movement.
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def save_forecasts(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ForecastSaveRequest,
) -> ForecastSaveResult:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")

    upserted = 0
    deleted = 0
    diffs: list[dict[str, Any]] = []

    # Cache product/customer lookups across the batch.
    prod_cache: dict[uuid.UUID, Any] = {}
    cust_cache: dict[uuid.UUID, Any] = {}

    for ch in payload.changes:
        product_uuid = _parse_uuid_or_422(ch.product_id, field="product_id")
        product = prod_cache.get(product_uuid)
        if product is None:
            product = await products_repo.get_product(db, product_uuid)
            if product is None:
                raise NotFoundError(f"Product {ch.product_id} not found")
            prod_cache[product_uuid] = product

        customer_uuid: uuid.UUID | None = None
        customer = None
        if ch.customer_id is not None:
            customer_uuid = _parse_uuid_or_422(ch.customer_id, field="customer_id")
            customer = cust_cache.get(customer_uuid)
            if customer is None:
                customer = await products_repo.get_customer(db, customer_uuid)
                if customer is None:
                    raise NotFoundError(f"Customer {ch.customer_id} not found")
                cust_cache[customer_uuid] = customer

        existing = await forecast_repo.get_entry(
            db,
            customer_id=customer_uuid,
            product_id=product_uuid,
            year=ch.year,
            month=ch.month,
        )
        old_runs = existing.runs if existing else 0

        if ch.runs <= 0:
            if existing is None:
                continue  # clearing an already-empty cell — no-op
            await forecast_repo.delete_entry(db, entry=existing)
            deleted += 1
        elif existing is not None:
            await forecast_repo.update_runs(
                db, entry=existing, runs=ch.runs, updated_by_user_id=current.id
            )
            upserted += 1
        else:
            await forecast_repo.create_entry(
                db,
                product_id=product_uuid,
                customer_id=customer_uuid,
                year=ch.year,
                month=ch.month,
                runs=ch.runs,
                created_by_user_id=current.id,
            )
            upserted += 1

        if len(diffs) < _MAX_AUDIT_CHANGES:
            diffs.append(
                {
                    "product_sku": product.sku,
                    "customer": customer.name if customer else None,
                    "year": ch.year,
                    "month": ch.month,
                    "from": old_runs,
                    "to": ch.runs,
                }
            )

    # Bind the signature to this batch via a synthetic id, consume the evidence
    # (replay-guarded), and write one audit row linked to the signature. The
    # consume + audit + cell writes all commit together below.
    batch_id = uuid.uuid4()
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=FORECAST_SAVE_ACTION,
        target_table="app.forecast_entries",
        target_id=batch_id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.forecast_entries",
        subject_id=batch_id,
        subject_label=f"Forecast save — {upserted} upserted, {deleted} deleted",
        before=None,
        after={"upserted": upserted, "deleted": deleted, "changes": diffs},
        signature_id=evidence_uuid,
    )
    await db.commit()

    return ForecastSaveResult(upserted=upserted, deleted=deleted)
