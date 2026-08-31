"""``/v1/exports/kit-costs.csv`` — the kit material cost export (RPT-003).

    "No Canned Query is required at this time. I want them to pull the data out
    from the system through the Export function and they can use AI or
    equivalent to mine the data using spreadsheets or some other output. …
    Ideally we would just do a data dump of all the information captured over a
    date range into a .CSV file that they can use and show me what they want as
    an output that we can supply later."
    — Blane Larson, 2026-08-27

A separate module from ``routes.py`` because it is a separate requirement with a
separate audience and a **narrower gate** — the finance export is stock
valuation, this one is what each customer is charged. It reuses that module's
writer, row limit and audit helper, so the two files cannot drift apart on
formatting or on the promise that every download is recorded.

Deliberately unaggregated: six row kinds, no ranking, no grouping, no
summarising. The client explicitly deferred the report itself until the
departments send real examples of what they want, and inventing one now would
mean building it twice.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import CurrentDbUserDep, DBSession
from app.core.exceptions import ValidationError
from app.kitting import repository as kit_repo
from app.locations import repository as loc_repo
from app.security.permissions import ADMIN_ROLES, RequirePermission, RequireRole

from . import kit_cost_repository as kc_repo
from . import kit_cost_rows as kc_rows
from .csv_writer import MAX_EXPORT_ROWS, export_filename, render_csv
from .kit_cost_rows import KIT_COST_COLUMNS, ROW_KINDS, RowKind
from .routes import _audit_export

kit_costs_router = APIRouter(prefix="/exports", tags=["exports"])

#: Logical subject for the audit row. Separate from RPT-001's constant so the
#: two exports are distinguishable in the audit viewer.
KIT_COST_SUBJECT_TABLE = "app.kit_cost_exports"


@kit_costs_router.get(
    "/kit-costs.csv",
    summary="Kit material cost CSV — date-ranged data dump (RPT-003)",
    dependencies=[
        Depends(RequirePermission("inventory", "view")),
        # Narrower than RPT-001 on purpose. This file carries what each customer
        # is charged for each finished lot, which is commercially sensitive in a
        # way a stock valuation is not — and ``inventory:view`` alone would hand
        # it to every read-only account (dev seeds 513 of them).
        Depends(RequireRole(*ADMIN_ROLES)),
    ],
    response_class=Response,
)
async def kit_costs_csv(
    db: DBSession,
    current: CurrentDbUserDep,
    occurred_from: Annotated[datetime | None, Query()] = None,
    occurred_to: Annotated[datetime | None, Query()] = None,
    kit_id: Annotated[uuid.UUID | None, Query()] = None,
    status: Annotated[str | None, Query(max_length=32)] = None,
    row_kinds: Annotated[list[RowKind] | None, Query()] = None,
) -> Response:
    """Everything captured about kit material cost over a date range.

    The range is **half-open** (``>= from``, ``< to``), matching the audit
    module — the only other date range in this API — so the frontend can send a
    whole day as ``[day, day+1)`` and include it without an off-by-one-second
    gap at midnight.

    A kit is selected by its **events**, not its own dates: a kit created in
    January whose batch ran in August belongs in an August file. Once selected,
    every one of its rows in range is emitted, so per-kit totals add up rather
    than being silently partial.
    """
    if occurred_from is not None and occurred_to is not None and occurred_from >= occurred_to:
        raise ValidationError(
            "The 'from' date must be before the 'to' date.", code="invalid_date_range"
        )
    wanted = set(row_kinds) if row_kinds else set(ROW_KINDS)

    generated_at = datetime.now(UTC)
    kit_ids = await kc_repo.kit_ids_in_range(
        db,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        kit_id=kit_id,
        status=status,
    )
    kits = await kc_repo.kits_with_context(db, kit_ids)
    lines = await kc_repo.lines_by_kit(db, kit_ids)
    movements = await kc_repo.material_movements(
        db, kit_ids, occurred_from=occurred_from, occurred_to=occurred_to
    )
    batch_rows = await kc_repo.batches_with_lots(
        db, kit_ids, occurred_from=occurred_from, occurred_to=occurred_to
    )
    consumptions = await kc_repo.consumptions_by_batch(db, kit_ids)
    node_labels = await loc_repo.node_label_map(db) if kit_ids else {}
    output_lot_ids = [b.output_lot_id for b, *_ in batch_rows if b.output_lot_id]
    shipments = await kc_repo.shipments_of_output_lots(
        db, output_lot_ids, occurred_from=occurred_from, occurred_to=occurred_to
    )

    facts: dict[uuid.UUID, kc_rows.KitFacts] = {}
    for kit, item_number, description in kits:
        name, path = node_labels.get(kit.production_location_node_id, ("", ""))
        facts[kit.id] = kc_rows.KitFacts(
            kit_id=kit.id,
            kit_number=kit.kit_number,
            status=kit.status,
            target_qty=kit.target_qty,
            item_number=item_number,
            item_description=description,
            production_location_path=path or name or None,
        )

    stamp: dict[str, Any] = {
        "generated_at": generated_at,
        "range_from": occurred_from,
        "range_to": occurred_to,
    }
    # Grouped by kind, concatenated in ROW_KINDS order below — so the file reads
    # as the life of the material rather than as query output.
    by_kind: dict[str, list[dict[str, Any]]] = {k: [] for k in ROW_KINDS}

    for kid, mv_id, at, mv_type, line_id, lot_no, price, qty, actor, notes in movements:
        kit_facts = facts.get(kid)
        if kit_facts is None:
            continue
        line_no, comp_number, comp_desc = lines.get(kid, {}).get(line_id, (None, None, None))
        is_charge = mv_type in kc_repo.CHARGE_MOVEMENT_TYPES
        builder = kc_rows.material_issue_row if is_charge else kc_rows.material_return_row
        by_kind["material_issue" if is_charge else "material_return"].append(
            builder(
                kit_facts,
                movement_id=mv_id,
                event_at=at,
                movement_type=mv_type,
                line_no=line_no,
                component_item_number=comp_number,
                component_item_description=comp_desc,
                lot_number=lot_no,
                unit_price=price,
                qty=int(qty),
                performed_by_name=actor,
                notes=notes,
                **stamp,
            )
        )

    cost_by_lot: dict[uuid.UUID, Decimal | None] = {}
    for batch, lot_no, expiry, release_state, actor in batch_rows:
        kit_facts = facts.get(batch.kit_id)
        if kit_facts is None:
            continue
        if batch.output_lot_id:
            cost_by_lot[batch.output_lot_id] = batch.unit_cost_amount
        by_kind["batch_output"].append(
            kc_rows.batch_output_row(
                kit_facts,
                event_at=batch.produced_at,
                batch_no=batch.batch_no,
                good_qty=batch.good_qty,
                scrap_qty=batch.scrap_qty,
                output_lot_number=lot_no,
                output_lot_expiration_date=expiry,
                output_lot_release_state=release_state,
                material_cost=batch.material_cost_amount,
                unit_cost=batch.unit_cost_amount,
                scrap_value=batch.scrap_value_amount,
                cost_is_complete=batch.cost_is_complete,
                performed_by_name=actor,
                **stamp,
            )
        )
        for c in consumptions.get(batch.id, []):
            line_no, comp_number, comp_desc = lines.get(batch.kit_id, {}).get(
                c.kit_line_id, (None, None, None)
            )
            by_kind["batch_consumption"].append(
                kc_rows.batch_consumption_row(
                    kit_facts,
                    event_at=batch.produced_at,
                    batch_no=batch.batch_no,
                    line_no=line_no,
                    component_item_number=comp_number,
                    component_item_description=comp_desc,
                    qty=c.qty,
                    unit_cost=c.unit_cost_amount,
                    extended_value=c.extended_value_amount,
                    cost_is_complete=c.cost_is_complete,
                    **stamp,
                )
            )

    lot_to_kit = {b.output_lot_id: b.kit_id for b, *_ in batch_rows if b.output_lot_id}
    lot_numbers = {b.output_lot_id: n for b, n, *_ in batch_rows if b.output_lot_id}
    for lot_id, mv_id, at, qty, customer, reference, actor in shipments:
        kit_facts = facts.get(lot_to_kit.get(lot_id))
        if kit_facts is None:
            continue
        by_kind["output_shipment"].append(
            kc_rows.output_shipment_row(
                kit_facts,
                movement_id=mv_id,
                event_at=at,
                output_lot_number=lot_numbers.get(lot_id),
                qty=int(qty),
                unit_cost=cost_by_lot.get(lot_id),
                customer_name=customer,
                reference_number=reference,
                performed_by_name=actor,
                **stamp,
            )
        )

    # The kit-level net, recomputed LIVE from the ledger rather than summed from
    # the rows above: the date range may have clipped some of them, and a
    # summary that silently reported a partial life would be worse than none.
    # This is also why it can differ from the frozen per-batch figures — see
    # ``kit_summary_row``.
    for kit, _item_number, _description in kits:
        charge_credit = await kit_repo.line_charge_credit_values(db, kit.id)
        charged: Decimal | None = Decimal("0")
        credited = Decimal("0")
        for line_charged, line_credited, _unpriced in charge_credit.values():
            if line_charged is None:
                charged = None
            elif charged is not None:
                charged += line_charged
            credited += line_credited
        by_kind["kit_summary"].append(
            kc_rows.kit_summary_row(
                facts[kit.id],
                event_at=kit.created_at,
                charged=charged,
                credited=credited,
                cost_is_complete=charged is not None,
                **stamp,
            )
        )

    body_rows: list[dict[str, Any]] = []
    for kind in ROW_KINDS:
        if kind in wanted:
            body_rows.extend(by_kind[kind])

    # 422 rather than a silent truncation: half a cost file that looks whole is
    # the one outcome worse than no file (same rule as RPT-001).
    if len(body_rows) > MAX_EXPORT_ROWS:
        raise ValidationError(
            f"This range produces {len(body_rows):,} rows, over the "
            f"{MAX_EXPORT_ROWS:,} limit. Narrow the dates and take it in parts.",
            code="export_too_large",
        )

    body = render_csv(body_rows, columns=KIT_COST_COLUMNS, headers=kc_rows.header_row())
    filename = export_filename(generated_at, "csv", prefix="kit-costs")
    await _audit_export(
        db,
        actor_user_id=current.id,
        filename=filename,
        fmt="csv",
        row_count=len(body_rows),
        byte_count=len(body),
        column_count=len(KIT_COST_COLUMNS),
        item_count=len(kit_ids),
        counts={k: len(by_kind[k]) for k in ROW_KINDS if k in wanted},
        filters={
            "occurred_from": occurred_from.isoformat() if occurred_from else None,
            "occurred_to": occurred_to.isoformat() if occurred_to else None,
            "kit_id": str(kit_id) if kit_id else None,
            "status": status,
            "row_kinds": sorted(wanted),
        },
        subject_table=KIT_COST_SUBJECT_TABLE,
        requirement="RPT-003",
    )

    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
