"""Column contract + cell formatting for the finance export (RPT-001).

Pure functions, no database. Everything here is about one question: what does
this value look like when finance opens the file in Excel?

    "The system shall provide a CSV export (full data dump) for finance, who
    apply their own downstream math; the export is the current-state,
    full-column output."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

"They apply their own downstream math" is the load-bearing clause. It means
this module's job is to hand over exact factors and never a rounded, summarised
or helpfully-defaulted number. In particular a missing price exports as an
EMPTY cell, never ``0`` — see :func:`format_cell`.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

# Ceiling on rows in one file. Not a paging limit — an OOM backstop. A runaway
# join produces a clean 422 instead of a killed worker. Today's dev catalogue
# renders in the low thousands, so this is ~2 orders of magnitude of headroom.
MAX_EXPORT_ROWS = 250_000

# ── The column contract ─────────────────────────────────────────────────
#
# ORDER IS PART OF THE CONTRACT. Finance builds spreadsheets against these
# positions; ``test_exports_inventory_csv.py`` freezes the tuple so a
# well-meaning reorder fails the suite instead of silently breaking a macro.
#
# Grouping, in order: export metadata · item identity · lot identity ·
# supplier/PO provenance · location · quantity · money · item-level
# cross-check. A column is populated on some ``row_kind``s and blank on
# others — see ``rows.py`` for which, and why that is what stops the
# item-level figures being double-counted against the detail rows.
COLUMNS: tuple[str, ...] = (
    # ── Export metadata ──
    "export_generated_at",
    "row_kind",
    # ── Item identity (every row kind) ──
    "item_id",
    "item_number",
    "item_description",
    "item_prefix_code",
    "item_tier_name",
    "item_tier_type",
    "is_consumable",
    "uom",
    # ── Lot identity (on_hand, awaiting_release) ──
    "lot_id",
    "lot_number",
    "lot_number_is_synthetic",
    "lot_status",
    "lot_release_state",
    "release_state_applies",
    "manufacture_date",
    "expiration_date",
    "has_expiration_date",
    "is_expired",
    "days_to_expiry",
    "parent_lot_id",
    # ── Supplier / PO provenance ──
    "supplier_id",
    "supplier_name",
    "po_reference",
    "order_id",
    "order_status",
    "order_is_blanket",
    "order_is_archived",
    # ── Location (on_hand only) ──
    "location_node_id",
    "location_path",
    "location_name",
    "location_code",
    "location_node_type",
    "location_is_active",
    # ── Quantity (each populated on exactly one row kind) ──
    "qty_on_hand",
    "qty_awaiting_release",
    "qty_on_order",
    "qty_on_order_packs",
    "pack_uom",
    "units_per_pack",
    # ── Money ──
    "unit_price_per_consume_unit",
    "unit_price_per_order_unit",
    "has_unit_price",
    "extended_value_amount",
    "value_basis",
    # ── Item-level cross-check (item_valuation rows only) ──
    "item_ui_inv_value_amount",
    "item_ui_po_value_amount",
    "item_qty_on_hand_ledger",
    "item_qty_available_ledger",
    "item_qty_on_order",
    "item_qty_awaiting_release",
    "item_status_code",
    "item_reorder_threshold",
    "item_last_movement_at",
)


# ── Cell formatting ─────────────────────────────────────────────────────

# Leading characters Excel and Google Sheets treat as the start of a formula.
# This file is assembled from operator-entered free text (descriptions, notes,
# lot numbers, PO references, supplier and location names) and is then emailed
# to finance, so the guard below is not theoretical.
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def guard_formula(text: str) -> str:
    """Neutralise CSV injection by prefixing a lone apostrophe (OWASP).

    Only ever applied to **strings**. Numbers reach the file through the
    ``Decimal`` / ``int`` branches of :func:`format_cell`, so a negative
    quantity stays ``-5`` and is still a number to Excel; it is a free-text
    cell *beginning* with ``-`` that gets quoted.
    """
    if text and text[0] in _FORMULA_LEAD:
        return "'" + text
    return text


def format_cell(value: Any) -> str:  # noqa: PLR0911 — a type-dispatch ladder; the order IS the logic
    """One Python value → one CSV cell, as finance will read it.

    * ``None`` → ``""``. **Never** ``"None"``, ``"null"`` or ``0``. A blank
      price means "no price recorded"; a zero would mean "worth nothing", and
      the whole point of the ``has_*`` companion columns is that finance can
      tell those apart.
    * ``Decimal`` → ``format(d, "f")``. Plain digits, never scientific: plain
      ``str(Decimal)`` emits ``0E-6`` for some zero-scale values, which Excel
      imports as text. Emitted **unrounded** — a per-consume-unit price carries
      6dp precisely because "$95.00 over a pack of 3" does not divide, and
      rounding each row before finance sums them would reintroduce the error
      the schema was designed to avoid.
    * ``bool`` → ``"true"``/``"false"``, matching the JSON the rest of the API
      emits. Checked before ``int`` because ``bool`` subclasses ``int``.
    * ``datetime`` → ISO-8601 UTC to the second; checked before ``date``
      because ``datetime`` subclasses ``date``. A naive value is assumed UTC
      rather than local — the columns feeding this are all ``timestamptz``.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        stamped = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return stamped.astimezone(UTC).isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, int | float | uuid.UUID):
        return str(value)
    return guard_formula(str(value))


def render_csv(
    rows: Iterable[Mapping[str, Any]], columns: tuple[str, ...] = COLUMNS
) -> bytes:
    """Render the header + rows to RFC-4180 CSV bytes.

    ``utf-8-sig`` (a BOM) is **not** optional. ``location_path`` joins its
    breadcrumb with ``" › "`` (U+203A, see ``locations/repository.py``), and
    supplier and item text can carry anything. Without the BOM, Excel on
    Windows decodes the file in the ANSI codepage and every location reads as
    mojibake.

    ``\\r\\n`` is set explicitly rather than left to the platform default, so
    the bytes are identical whether the export is generated on the Linux
    container or a developer's Windows host.
    """
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(columns)
    for row in rows:
        writer.writerow([format_cell(row.get(column)) for column in columns])
    return buf.getvalue().encode("utf-8-sig")


def export_filename(generated_at: datetime, extension: str = "csv") -> str:
    """``cellready-inventory-20260825T140311Z.csv`` (or ``.xlsx``).

    Pure ASCII (so ``Content-Disposition`` needs no ``filename*``), sorts
    chronologically in a Downloads folder, and carries the same as-of stamp
    that every row's ``export_generated_at`` column carries — so a renamed
    file can still be tied back to the moment it was taken.

    Shared by both formats so a workbook and a flat CSV taken at the same
    moment are recognisably the same export.
    """
    stamp = generated_at.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"cellready-inventory-{stamp}.{extension}"
