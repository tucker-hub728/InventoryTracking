"""``/v1/exports`` — the finance export (RPT-001).

    "The system shall provide a CSV export (full data dump) for finance, who
    apply their own downstream math; the export is the current-state,
    full-column output."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

Two representations of the **same rows**:

* ``GET /v1/exports/inventory.csv`` — RPT-001 as written. One flat sheet, all
  55 columns, every row kind interleaved. The reconciliation artefact.
* ``GET /v1/exports/inventory.xlsx`` — a tabbed workbook the client asked for
  after seeing the flat file (2026-08-25): a summary tab matching the screen,
  then one tab per item that has something to show. A **deviation** from the
  requirement's "full-column output", offered alongside it rather than
  replacing it.

Both are built by :func:`_gather`, so they cannot disagree about the data —
only about layout. The UI ships the workbook; the CSV stays available for
whoever needs the full column set or an exact-decimal reconciliation.

Read-only, and gated on ``inventory:view`` rather than a signature. Every
re-authentication in this system is bound to a record being changed
(``record_table`` / ``record_id``, migration ``esignbind01``); a password
prompt on a read would assert nothing, and prompts that assert nothing teach
people to type their password without reading the dialog.

The download IS audited — see :func:`_audit_export`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit.recorder import record_entity_change
from app.core.exceptions import ValidationError
from app.core.search import MAX_SEARCH_LENGTH
from app.inventory import repository as inv_repo
from app.locations import repository as loc_repo
from app.security.permissions import RequirePermission

from . import repository as exp_repo
from . import rows as builders
from .csv_writer import COLUMNS, MAX_EXPORT_ROWS, export_filename, render_csv
from .rows import ROW_KINDS, ItemFacts, RowKind
from .xlsx_writer import build_workbook, sheet_name_for, summary_status_label

exports_router = APIRouter(prefix="/exports", tags=["exports"])

#: Logical subject for the audit row. No such table exists and none is needed —
#: ``audit.audit_events.subject_id`` is nullable with no FK, so an export is
#: audited as a first-class thing without a schema to carry it.
EXPORT_SUBJECT_TABLE = "app.inventory_exports"

XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)

# ── Shared gathering ────────────────────────────────────────────────────


@dataclass
class _Bundle:
    """One item and everything current-state we know about it."""

    item: Any
    facts: ItemFacts
    on_hand: list[dict[str, Any]] = field(default_factory=list)
    awaiting: list[dict[str, Any]] = field(default_factory=list)
    on_order: list[dict[str, Any]] = field(default_factory=list)
    valuation: dict[str, Any] | None = None
    inv_value: Decimal = Decimal("0")
    po_value: Decimal = Decimal("0")
    qty_on_order: Decimal = Decimal("0")
    qty_awaiting: int = 0

    @property
    def detail_rows(self) -> list[dict[str, Any]]:
        """Every row that describes actual material, summary rows excluded."""
        return [*self.on_hand, *self.awaiting, *self.on_order]

    @property
    def csv_rows(self) -> list[dict[str, Any]]:
        rows = self.detail_rows
        return [*rows, self.valuation] if self.valuation else rows


@dataclass
class _Export:
    bundles: list[_Bundle]
    generated_at: datetime
    counts: dict[str, int]

    @property
    def csv_rows(self) -> list[dict[str, Any]]:
        return [row for bundle in self.bundles for row in bundle.csv_rows]


async def _gather(
    db: DBSession,
    *,
    wanted: tuple[RowKind, ...],
    tier_id: uuid.UUID | None,
    prefix_id: uuid.UUID | None,
    supplier_id: uuid.UUID | None,
    q: str | None,
    is_consumable: bool | None,
) -> _Export:
    """Fetch everything both formats need, in six bulk queries.

    There is no per-item query in here. An export is the one endpoint where an
    N+1 turns a page load into a timeout.
    """
    generated_at = datetime.now(UTC)
    # One date for the whole file, so ``is_expired`` and ``days_to_expiry``
    # cannot disagree between the first row and the last.
    today = generated_at.date()

    items = await exp_repo.filtered_items(
        db,
        tier_id=tier_id,
        prefix_id=prefix_id,
        supplier_id=supplier_id,
        q=q,
        is_consumable=is_consumable,
    )
    item_ids = [item.id for item in items]

    allocations = (
        await exp_repo.allocation_rows_by_item(db, item_ids)
        if "on_hand" in wanted
        else {}
    )
    awaiting = (
        await exp_repo.lots_awaiting_put_away(db, item_ids)
        if "awaiting_release" in wanted
        else {}
    )
    open_orders = (
        await exp_repo.open_order_rows_by_item(db, item_ids)
        if "on_order" in wanted
        else {}
    )
    # Always fetched: the workbook's summary tab shows these figures for every
    # item even when the caller filtered the valuation ROWS out of a CSV.
    valuations = await exp_repo.compute_item_valuations(db, item_ids)
    awaiting_units = await inv_repo.awaiting_release_units(db, item_ids)

    # One tree walk for every location on show — the map is built from a single
    # SELECT plus an in-memory parent walk, so calling it per row would be the
    # one N+1 in an otherwise bulk endpoint.
    node_labels = await loc_repo.node_label_map(db) if allocations else {}

    bundles: list[_Bundle] = []
    for item in items:
        facts = builders.item_facts_from_orm(item)
        inv_value, po_value, qty_on_order = valuations.get(
            item.id, (Decimal("0"), Decimal("0"), Decimal("0"))
        )
        bundle = _Bundle(
            item=item,
            facts=facts,
            inv_value=inv_value,
            po_value=po_value,
            qty_on_order=qty_on_order,
            qty_awaiting=awaiting_units.get(item.id, 0),
        )
        for sql_row in allocations.get(item.id, []):
            name, path = node_labels.get(sql_row.location_node_id, ("", ""))
            bundle.on_hand.append(
                builders.on_hand_row(
                    facts,
                    sql_row,
                    location_name=name,
                    location_path=path or name,
                    today=today,
                    generated_at=generated_at,
                )
            )
        for lot, remaining in awaiting.get(item.id, []):
            bundle.awaiting.append(
                builders.awaiting_release_row(
                    facts, lot, remaining, today=today, generated_at=generated_at
                )
            )
        for sql_row in open_orders.get(item.id, []):
            bundle.on_order.append(
                builders.on_order_row(facts, sql_row, generated_at=generated_at)
            )
        if "item_valuation" in wanted:
            bundle.valuation = builders.item_valuation_row(
                facts,
                item,
                inv_value=inv_value,
                po_value=po_value,
                qty_on_order=qty_on_order,
                qty_awaiting_release=bundle.qty_awaiting,
                generated_at=generated_at,
            )
        bundles.append(bundle)

    counts = {
        "on_hand": sum(len(b.on_hand) for b in bundles),
        "awaiting_release": sum(len(b.awaiting) for b in bundles),
        "on_order": sum(len(b.on_order) for b in bundles),
        "item_valuation": sum(1 for b in bundles if b.valuation),
    }
    total = sum(counts.values())
    if total > MAX_EXPORT_ROWS:
        # A backstop, not a page size. Better a clean 422 than an OOM'd worker.
        raise ValidationError(
            f"This export would be {total:,} rows, over the "
            f"{MAX_EXPORT_ROWS:,} limit. Narrow it with a tier or supplier "
            f"filter.",
            code="export_too_large",
        )
    return _Export(bundles=bundles, generated_at=generated_at, counts=counts)


async def _audit_export(
    db: DBSession,
    *,
    actor_user_id: uuid.UUID,
    filename: str,
    fmt: str,
    row_count: int,
    byte_count: int,
    column_count: int,
    item_count: int,
    counts: dict[str, int],
    filters: dict[str, Any],
    subject_table: str = EXPORT_SUBJECT_TABLE,
    requirement: str = "RPT-001",
) -> None:
    """One ``audit.audit_events`` row per download, written before it is served.

    ``docs/backend-data-structure.md`` §10.8 commits to every export being an
    auditable event. This honours that with no migration — the
    ``audit.export_jobs`` table specced there carries ``file_url`` /
    ``completed_at`` / ``bytes``, the schema of an async job writing to object
    storage, and this system has neither a job runner nor a bucket.

    Part 11 §11.10(e) does not compel it (an export is a read), but "who took a
    copy of our valuation, and what was in it" is a routine inspection question
    and the row costs one INSERT. It carries the real row and byte counts — a
    manifest a pre-emptive write could not have produced.
    """
    await record_entity_change(
        db,
        actor_user_id=actor_user_id,
        # "created" is the honest word — an export artefact came into being.
        # The recorder allows exactly four verbs and the column has no CHECK,
        # so this needs no schema change.
        action="created",
        # Defaults to the RPT-001 constant; the kit-cost export passes its own
        # so the two are distinguishable in the audit viewer — "who took a copy
        # of our customer pricing" is a different question from "who took a copy
        # of our stock valuation".
        subject_table=subject_table,
        subject_id=uuid.uuid4(),
        subject_label=filename,
        before=None,
        after={
            "format": fmt,
            "row_count": row_count,
            "bytes": byte_count,
            "columns": column_count,
            "item_count": item_count,
        },
        context={
            "requirement": requirement,
            "row_counts_by_kind": counts,
            "filters": filters,
        },
        severity="info",
    )
    await db.commit()


# ── Routes ──────────────────────────────────────────────────────────────


@exports_router.get(
    "/inventory.csv",
    summary="Finance CSV export — current-state full data dump (RPT-001)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
    response_class=Response,
)
async def inventory_csv(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID | None, Query()] = None,
    prefix_id: Annotated[uuid.UUID | None, Query()] = None,
    supplier_id: Annotated[uuid.UUID | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)] = None,
    is_consumable: Annotated[bool | None, Query()] = None,
    row_kinds: Annotated[
        list[RowKind] | None,
        Query(description="Which row kinds to include. Default: all four."),
    ] = None,
) -> Response:
    """RPT-001 as specified: one flat sheet, every column.

    **Why not ``StreamingResponse``.** Three reasons, in order of weight:

    1. The BFF proxy buffers the entire upstream body (``await
       upstream.arrayBuffer()``) before a byte reaches the browser, so
       streaming from here buys nothing end to end.
    2. A streaming response taking ``DBSession`` holds a pool connection for
       the whole response — the hazard documented on the notifications SSE
       route, and this pool is 5 + 10.
    3. Once a ``200 text/csv`` is on the wire an exception cannot become the
       standard error envelope; it becomes a truncated file that claims
       success. For a document finance will do arithmetic on, that is the
       worst available failure mode.

    ``GZipMiddleware`` is deliberately left engaged. The no-compress middleware
    exists for the SSE liveness problem (gzip mishandles ``more_body`` chunks);
    a whole ``Response`` is buffer-then-compress, which is right for a large
    text file.
    """
    selected = set(row_kinds) if row_kinds else set(ROW_KINDS)
    wanted = tuple(kind for kind in ROW_KINDS if kind in selected)
    if not wanted:
        raise ValidationError(
            "No row kinds selected — there would be nothing to export.",
            code="empty_row_kinds",
        )

    export = await _gather(
        db,
        wanted=wanted,
        tier_id=tier_id,
        prefix_id=prefix_id,
        supplier_id=supplier_id,
        q=q,
        is_consumable=is_consumable,
    )
    csv_rows = export.csv_rows
    body = render_csv(csv_rows)
    filename = export_filename(export.generated_at, "csv")

    await _audit_export(
        db,
        actor_user_id=current.id,
        filename=filename,
        fmt="csv",
        row_count=len(csv_rows),
        byte_count=len(body),
        column_count=len(COLUMNS),
        item_count=len(export.bundles),
        counts=export.counts,
        filters={
            "tier_id": str(tier_id) if tier_id else None,
            "prefix_id": str(prefix_id) if prefix_id else None,
            "supplier_id": str(supplier_id) if supplier_id else None,
            "q": q,
            "is_consumable": is_consumable,
            "row_kinds": list(wanted),
        },
    )

    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@exports_router.get(
    "/inventory.xlsx",
    summary="Finance Excel export — summary tab plus one tab per item",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
    response_class=Response,
)
async def inventory_xlsx(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID | None, Query()] = None,
    prefix_id: Annotated[uuid.UUID | None, Query()] = None,
    supplier_id: Annotated[uuid.UUID | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)] = None,
    is_consumable: Annotated[bool | None, Query()] = None,
    title: Annotated[
        str,
        Query(
            max_length=64,
            description="Name for the summary tab, e.g. the tier being exported.",
        ),
    ] = "Inventory",
) -> Response:
    """The tabbed workbook: summary tab, then one tab per item.

    **Only items with something to show get a tab** — stock, an arrival, or an
    open order. An item with none of those would get a tab containing a header
    block and an empty table, and 20-odd of those make the workbook harder to
    navigate without adding a fact. They still appear on the summary tab, so
    nothing disappears; their SKU simply is not a link.

    Every row here is the same row the CSV emits, from the same
    :func:`_gather`. The workbook differs only in layout and in writing numbers
    as numbers rather than strings — which is why the CSV, with its exact
    decimals, stays the artefact to reconcile against.
    """
    export = await _gather(
        db,
        wanted=ROW_KINDS,
        tier_id=tier_id,
        prefix_id=prefix_id,
        supplier_id=supplier_id,
        q=q,
        is_consumable=is_consumable,
    )

    used_names: set[str] = set()
    summary_rows: list[dict[str, Any]] = []
    item_tabs: list[dict[str, Any]] = []

    for bundle in export.bundles:
        item = bundle.item
        stock = item.stock
        qty_on_hand = stock.qty_on_hand if stock else Decimal("0")
        qty_available = stock.qty_available if stock else Decimal("0")
        threshold = item.reorder_threshold or Decimal("0")
        detail_rows = bundle.detail_rows
        sheet = sheet_name_for(bundle.facts.item_number, used_names) if detail_rows else None

        status = summary_status_label(
            stock.status_code if stock else None,
            qty_available=qty_available,
            reorder_threshold=threshold,
            qty_awaiting_release=bundle.qty_awaiting,
        )
        summary_rows.append(
            {
                "item_number": bundle.facts.item_number,
                "item_description": bundle.facts.description,
                "is_consumable": bundle.facts.is_consumable,
                "qty_on_hand": qty_on_hand,
                "uom": bundle.facts.uom,
                "status": status,
                "qty_awaiting_release": bundle.qty_awaiting,
                "qty_on_order": bundle.qty_on_order,
                "inv_value": bundle.inv_value,
                "po_value": bundle.po_value,
                "reorder_threshold": threshold,
                "updated_at": item.updated_at,
                "sheet": sheet,
            }
        )
        if sheet:
            item_tabs.append(
                {
                    "sheet": sheet,
                    "facts": {
                        "item_number": bundle.facts.item_number,
                        "item_description": bundle.facts.description,
                        "item_tier_name": bundle.facts.tier_name,
                        "uom": bundle.facts.uom,
                        "is_consumable": bundle.facts.is_consumable,
                        "item_status_code": status,
                        "qty_on_hand": qty_on_hand,
                        "qty_available": qty_available,
                        "qty_awaiting_release": bundle.qty_awaiting,
                        "qty_on_order": bundle.qty_on_order,
                        "inv_value": bundle.inv_value,
                        "po_value": bundle.po_value,
                        "reorder_threshold": threshold,
                        "last_movement_at": stock.last_movement_at if stock else None,
                    },
                    "detail_rows": detail_rows,
                }
            )

    body = build_workbook(
        summary_title=title,
        summary_rows=summary_rows,
        item_tabs=item_tabs,
        generated_at=export.generated_at,
    )
    filename = export_filename(export.generated_at, "xlsx")

    await _audit_export(
        db,
        actor_user_id=current.id,
        filename=filename,
        fmt="xlsx",
        row_count=len(export.csv_rows),
        byte_count=len(body),
        # Tabs, not columns — the meaningful size of a workbook.
        column_count=1 + len(item_tabs),
        item_count=len(export.bundles),
        counts=export.counts,
        filters={
            "tier_id": str(tier_id) if tier_id else None,
            "prefix_id": str(prefix_id) if prefix_id else None,
            "supplier_id": str(supplier_id) if supplier_id else None,
            "q": q,
            "is_consumable": is_consumable,
            "title": title,
            "tabs": 1 + len(item_tabs),
        },
    )

    return Response(
        content=body,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
