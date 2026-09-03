"""Multi-tab Excel workbook for the finance export.

A tabbed variant of RPT-001, requested by the client 2026-08-25 after seeing
the flat CSV. Structure:

* **Tab 1** — the tier summary, the same table the inventory page shows on
  screen (SKU, Name, Consumable, On hand, Stock status, Updated). Each SKU is
  an internal hyperlink to that item's own tab.
* **Tabs 2…N** — one per item that has something to show: a header block of
  that item's facts and totals, then its detail rows (stock by lot × location,
  arrivals awaiting release, and open purchase orders).

**This is a deviation from RPT-001 as written**, which says "CSV export (full
data dump) … the current-state, full-column output". The flat, full-column CSV
still exists at ``GET /v1/exports/inventory.csv`` and is unchanged; this
workbook is the shape the client is evaluating. Both are built from the same
rows, so they cannot disagree.

Rows come from ``rows.py`` exactly as the CSV gets them — this module only
decides layout and presentation. The one presentational difference from CSV:
numbers are written as **real numbers** with a display format rather than
formatted strings, so Excel can sum them without a text-to-column dance.
"""

from __future__ import annotations

import io
import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.hyperlink import Hyperlink
from openpyxl.worksheet.worksheet import Worksheet

from .csv_writer import guard_formula

# ── Layout constants ────────────────────────────────────────────────────

#: Tab 1 — deliberately the columns the inventory page renders, in its order.
#: "On hand" is split into quantity + unit because a spreadsheet wants a number
#: it can sum, not the "1674 mL" string the UI draws.
SUMMARY_HEADERS: tuple[tuple[str, str], ...] = (
    ("SKU", "item_number"),
    ("Name", "item_description"),
    ("Consumable", "is_consumable"),
    ("On hand", "qty_on_hand"),
    ("UoM", "uom"),
    ("Stock status", "status"),
    ("Awaiting release", "qty_awaiting_release"),
    ("On order", "qty_on_order"),
    ("Inventory $", "inv_value"),
    ("On PO $", "po_value"),
    ("Reorder at", "reorder_threshold"),
    ("Updated", "updated_at"),
)

#: The detail table on an item's own tab. Item identity is in the header block
#: above it, so repeating item_number / description / tier on every row would
#: be noise — this is the one place that redundancy can be dropped safely.
DETAIL_HEADERS: tuple[tuple[str, str], ...] = (
    ("Type", "row_kind"),
    ("Lot", "lot_number"),
    ("Lot status", "lot_status"),
    ("Release state", "lot_release_state"),
    ("Expires", "expiration_date"),
    ("Expired", "is_expired"),
    ("Days to expiry", "days_to_expiry"),
    ("Location", "location_path"),
    ("Supplier", "supplier_name"),
    ("PO", "po_reference"),
    ("Order status", "order_status"),
    ("On hand", "qty_on_hand"),
    ("Awaiting release", "qty_awaiting_release"),
    ("On order", "qty_on_order"),
    ("Unit price (each)", "unit_price_per_consume_unit"),
    ("Unit price (pack)", "unit_price_per_order_unit"),
    ("Value", "extended_value_amount"),
    # ── Transaction columns, blank on the three balance kinds ──
    #
    # Appended rather than woven in, so the balance half of the table still
    # reads exactly as it did and a "Transaction" row is visibly a different
    # kind of thing. This is the block that answers the question the client
    # actually asked: not "what is on the shelf" but "how did it get there,
    # and what did it cost".
    ("Transaction", "movement_type"),
    ("Direction", "movement_direction"),
    ("Qty moved", "movement_qty_delta"),
    ("Transaction value", "movement_value_amount"),
    ("From", "movement_from_location_path"),
    ("To", "movement_to_location_path"),
    ("Kit", "movement_kit_number"),
    ("Customer", "movement_customer_name"),
    ("Reference", "movement_reference_number"),
    ("By", "movement_performed_by"),
    ("When", "movement_performed_at"),
)

#: Human labels for the row kinds. The machine names are fine in a CSV that a
#: script reads; a tab someone scrolls deserves English.
ROW_KIND_LABELS = {
    "on_hand": "In stock",
    "awaiting_release": "Awaiting release",
    "on_order": "On order",
    # Deliberately NOT "Movement". The ledger's word is ``movement``, but the
    # people reading this tab are finance, and the thing they are looking at is
    # a transaction against an item.
    "movement": "Transaction",
}

#: Mirrors ``STOCK_STATUS_META`` in ``frontend/src/config/inventory.ts`` so the
#: summary tab reads exactly like the screen it was exported from.
STATUS_LABELS = {
    "available": "Available",
    "low_stock": "Low stock",
    "out_of_stock": "Out of stock",
}
AWAITING_RELEASE_LABEL = "Awaiting release"


def summary_status_label(
    status_code: str | None,
    *,
    qty_available: Decimal,
    reorder_threshold: Decimal,
    qty_awaiting_release: int,
) -> str:
    """The status pill the inventory page would show for this item.

    Mirrors ``coveredByArrivals`` in
    ``frontend/src/components/shared/stock-status-badge.tsx``: a shortage that
    arrived stock already covers reads "Awaiting release", not "Low stock",
    because "Low stock" is a *purchase* signal and the material is already in
    the building.

    **This is a third copy of that rule** — the other two are the frontend
    function above and ``_covered_by_arrivals`` in
    ``backend/app/planning/repository.py`` (a SQL expression, so not callable
    on plain values). Worth collapsing; noted in
    ``docs/modules/finance-export.md`` rather than silently duplicated.
    """
    label = STATUS_LABELS.get(status_code or "", status_code or "")
    if qty_awaiting_release <= 0 or status_code not in ("low_stock", "out_of_stock"):
        return label
    # ">=" because covering the gap exactly is enough — releasing it puts the
    # item back on its threshold, which is where it is meant to sit.
    if Decimal(qty_awaiting_release) >= (reorder_threshold - qty_available):
        return AWAITING_RELEASE_LABEL
    return label


_MONEY_FORMAT = "#,##0.00"
#: Two decimals always, up to six only when the price actually needs them.
#:
#: ``0`` is a mandatory digit and ``#`` a conditional one, so ``$4.00`` renders
#: as ``4.00`` while ``$95.00`` over a pack of 3 still renders in full as
#: ``31.666667``. A flat ``0.000000`` padded every ordinary price out to
#: ``4.000000``, which reads as false precision and is what finance noticed
#: first when they opened the file.
#:
#: Display only — the cell still holds the unrounded number, so a ``SUM`` or a
#: multiplication over this column is unaffected. Same ``#``-suppression trick
#: ``_QTY_FORMAT`` below already uses.
_PRICE_FORMAT = "#,##0.00####"
_QTY_FORMAT = "#,##0.###"
_DATE_FORMAT = "yyyy-mm-dd"
_DATETIME_FORMAT = "yyyy-mm-dd hh:mm"

_HEADER_FILL = PatternFill("solid", fgColor="F1F5F9")
_HEADER_FONT = Font(bold=True, color="0F172A")
_TITLE_FONT = Font(bold=True, size=14)
_LABEL_FONT = Font(bold=True, color="475569")
_LINK_FONT = Font(color="2563EB", underline="single")
_THIN = Side(style="thin", color="E2E8F0")
_HEADER_BORDER = Border(bottom=Side(style="medium", color="CBD5E1"))
_CELL_BORDER = Border(bottom=_THIN)

#: Excel forbids these in a sheet name, and caps the name at 31 characters.
_ILLEGAL_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")
_MAX_SHEET_NAME = 31


def sheet_name_for(item_number: str, used: set[str]) -> str:
    """A legal, unique worksheet name for one item.

    Excel's rules, all of which a real SKU can trip over: at most 31
    characters, none of ``[ ] : * ? / \\``, not blank, and unique within the
    workbook (case-insensitively — "cr-001" and "CR-001" collide).

    Collisions are resolved with a ``~2`` suffix rather than by truncating
    blindly, so two long SKUs sharing a 31-character prefix stay distinct
    instead of one silently overwriting the other.
    """
    cleaned = _ILLEGAL_SHEET_CHARS.sub("-", item_number or "").strip().strip("'")
    base = (cleaned or "item")[:_MAX_SHEET_NAME]
    candidate = base
    suffix = 2
    while candidate.casefold() in used:
        tail = f"~{suffix}"
        candidate = base[: _MAX_SHEET_NAME - len(tail)] + tail
        suffix += 1
    used.add(candidate.casefold())
    return candidate


def link_to_sheet(cell: Any, sheet_name: str) -> None:
    """Make ``cell`` jump to another tab in this workbook when clicked.

    **Must be a ``Hyperlink`` with ``location`` set, never a plain string.**
    Assigning ``cell.hyperlink = "#'CR-001'!A1"`` looks like it works — the
    attribute is set, and openpyxl accepts it — but openpyxl turns any string
    into an *external* relationship (``TargetMode="External"``). Excel then
    treats it as a URL to somewhere outside the file and clicking does
    nothing. An internal jump is a ``<hyperlink ref=… location=…>`` with no
    relationship at all, which is what passing ``location`` produces.

    Sheet names are quoted because they can contain spaces ("Raw Materials"),
    and an apostrophe inside a quoted Excel name has to be doubled.
    """
    quoted = sheet_name.replace("'", "''")
    cell.hyperlink = Hyperlink(ref=cell.coordinate, location=f"'{quoted}'!A1")
    cell.font = _LINK_FONT


def _coerce(value: Any) -> Any:
    """Python value → something Excel stores natively where it can.

    Numbers stay numbers and dates stay dates, so the recipient can sum, sort
    and filter without converting a column first — the main reason to ship a
    workbook rather than a CSV at all. ``None`` stays ``None`` so the cell is
    genuinely empty: the blank-means-unknown rule that governs the CSV holds
    here too, and an unpriced lot must never render as ``0``.

    ``Decimal`` becomes ``float`` because openpyxl writes floats natively.
    That is a real precision change, and it is safe at these magnitudes —
    inventory values are far inside float's exact-integer range and prices
    carry 6dp — but it is the reason the CSV, not this file, is the artefact
    to reconcile against when a number is ever disputed.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        stamped = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        # Excel has no timezone concept; normalise to UTC then drop the tzinfo,
        # otherwise openpyxl writes a string and the column stops sorting.
        return stamped.astimezone(UTC).replace(tzinfo=None)
    if isinstance(value, date | int | float | str):
        return value
    return str(value)


def _write_cell(sheet: Worksheet, row: int, col: int, value: Any, key: str = "") -> Any:
    """Write one value, with the number format its column deserves."""
    coerced = _coerce(value)
    # The CSV-injection guard applies to a workbook too: Excel executes a
    # leading "=" in a cell it loaded from .xlsx exactly as it would from .csv.
    if isinstance(coerced, str):
        coerced = guard_formula(coerced)
    cell = sheet.cell(row=row, column=col, value=coerced)
    if isinstance(coerced, bool):
        cell.value = "Yes" if coerced else "No"
    elif isinstance(coerced, datetime):
        cell.number_format = _DATETIME_FORMAT
    elif isinstance(coerced, date):
        cell.number_format = _DATE_FORMAT
    elif isinstance(coerced, float):
        if "price" in key:
            cell.number_format = _PRICE_FORMAT
        elif "value" in key or key.endswith("_amount"):
            cell.number_format = _MONEY_FORMAT
        else:
            cell.number_format = _QTY_FORMAT
    return cell


def _write_header_row(
    sheet: Worksheet, row: int, headers: tuple[tuple[str, str], ...]
) -> None:
    for col, (label, _) in enumerate(headers, start=1):
        cell = sheet.cell(row=row, column=col, value=label)
        cell.font = _HEADER_FONT
        cell.fill = _HEADER_FILL
        cell.border = _HEADER_BORDER
        cell.alignment = Alignment(vertical="center")


def _autosize(sheet: Worksheet, headers: tuple[tuple[str, str], ...], rows: list[dict]) -> None:
    """Width from the widest value, clamped.

    Excel has no real auto-fit for a file written outside it, and a location
    breadcrumb ("Storage › Analytical Lab › Minus-20 Freezers › T90020X") is
    long enough that the default width hides every column after it.
    """
    for col, (label, key) in enumerate(headers, start=1):
        widest = len(label)
        for row in rows:
            rendered = row.get(key)
            if rendered is not None:
                widest = max(widest, len(str(rendered)))
        sheet.column_dimensions[get_column_letter(col)].width = min(max(widest + 3, 10), 46)


def build_workbook(
    *,
    summary_title: str,
    summary_rows: list[dict[str, Any]],
    item_tabs: list[dict[str, Any]],
    generated_at: datetime,
) -> bytes:
    """Assemble the workbook and return the ``.xlsx`` bytes.

    ``summary_rows`` are keyed by the second element of ``SUMMARY_HEADERS``,
    plus ``sheet`` naming the item's tab (or ``None`` when it has none — an
    item with no stock, no arrivals and no open orders gets a summary line but
    no tab of its own, because that tab would be empty).

    ``item_tabs`` each carry ``{sheet, facts, detail_rows}``.
    """
    book = Workbook()
    summary = book.active
    summary.title = _ILLEGAL_SHEET_CHARS.sub("-", summary_title)[:_MAX_SHEET_NAME] or "Summary"

    _build_summary_sheet(summary, summary_title, summary_rows, generated_at)
    for tab in item_tabs:
        _build_item_sheet(book, tab, summary.title)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def _build_summary_sheet(
    sheet: Worksheet,
    title: str,
    rows: list[dict[str, Any]],
    generated_at: datetime,
) -> None:
    sheet["A1"] = title
    sheet["A1"].font = _TITLE_FONT
    sheet["A2"] = f"{len(rows)} items · as at {generated_at.strftime('%Y-%m-%d %H:%M UTC')}"
    sheet["A2"].font = Font(color="64748B")

    header_row = 4
    _write_header_row(sheet, header_row, SUMMARY_HEADERS)

    for offset, row in enumerate(rows, start=header_row + 1):
        for col, (_label, key) in enumerate(SUMMARY_HEADERS, start=1):
            cell = _write_cell(sheet, offset, col, row.get(key), key)
            cell.border = _CELL_BORDER
            # Click a SKU to jump to that item's tab. Items with nothing to
            # show have no tab, so they stay plain text rather than becoming a
            # link that lands nowhere.
            if key == "item_number" and row.get("sheet"):
                link_to_sheet(cell, row["sheet"])

    _autosize(sheet, SUMMARY_HEADERS, rows)
    sheet.freeze_panes = sheet.cell(row=header_row + 1, column=1)
    if rows:
        sheet.auto_filter.ref = (
            f"A{header_row}:{get_column_letter(len(SUMMARY_HEADERS))}{header_row + len(rows)}"
        )


def _build_item_sheet(book: Workbook, tab: dict[str, Any], summary_title: str) -> None:
    sheet = book.create_sheet(tab["sheet"])
    facts: dict[str, Any] = tab["facts"]
    detail_rows: list[dict[str, Any]] = tab["detail_rows"]

    sheet["A1"] = facts.get("item_number") or ""
    sheet["A1"].font = _TITLE_FONT
    sheet["C1"] = facts.get("item_description") or ""
    sheet["C1"].font = Font(color="475569", size=12)

    back = sheet["A2"]
    back.value = "← Back to summary"
    link_to_sheet(back, summary_title)

    # Two label/value pairs per line, so the block stays compact above the table.
    block: tuple[tuple[str, str], ...] = (
        ("Tier", "item_tier_name"),
        ("UoM", "uom"),
        ("Consumable", "is_consumable"),
        ("Stock status", "item_status_code"),
        ("On hand", "qty_on_hand"),
        ("Available", "qty_available"),
        ("Awaiting release", "qty_awaiting_release"),
        ("On order", "qty_on_order"),
        ("Inventory $", "inv_value"),
        ("On PO $", "po_value"),
        ("Reorder at", "reorder_threshold"),
        ("Last movement", "last_movement_at"),
    )
    row = 4
    for index, (label, key) in enumerate(block):
        col = 1 if index % 2 == 0 else 4
        label_cell = sheet.cell(row=row, column=col, value=label)
        label_cell.font = _LABEL_FONT
        _write_cell(sheet, row, col + 1, facts.get(key), key)
        if index % 2 == 1:
            row += 1
    if len(block) % 2:
        row += 1

    header_row = row + 1
    _write_header_row(sheet, header_row, DETAIL_HEADERS)

    display_rows: list[dict[str, Any]] = []
    for offset, detail in enumerate(detail_rows, start=header_row + 1):
        shown = dict(detail)
        shown["row_kind"] = ROW_KIND_LABELS.get(detail.get("row_kind", ""), detail.get("row_kind"))
        display_rows.append(shown)
        for col, (_label, key) in enumerate(DETAIL_HEADERS, start=1):
            cell = _write_cell(sheet, offset, col, shown.get(key), key)
            cell.border = _CELL_BORDER

    _autosize(sheet, DETAIL_HEADERS, display_rows)
    sheet.freeze_panes = sheet.cell(row=header_row + 1, column=1)
    if display_rows:
        sheet.auto_filter.ref = (
            f"A{header_row}:{get_column_letter(len(DETAIL_HEADERS))}"
            f"{header_row + len(display_rows)}"
        )
