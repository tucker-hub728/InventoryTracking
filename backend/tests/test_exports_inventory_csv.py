"""Unit tests for the finance CSV export (RPT-001).

No database. These cover the decisions that are easy to break silently and
expensive to discover late — the column contract, the blank-not-zero rule, and
the companion flags that stop a cell being misread.

    python -m pytest backend/tests/test_exports_inventory_csv.py -q

Run the whole suite with an explicit DATABASE_URL — ``conftest`` uses
``setdefault``, so omitting it points pytest at the DEV database.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from app.exports.csv_writer import (
    COLUMNS,
    export_filename,
    format_cell,
    guard_formula,
    render_csv,
)
from app.exports.rows import (
    ROW_KINDS,
    ItemFacts,
    blank_row,
)

# ── The column contract ─────────────────────────────────────────────────


EXPECTED_COLUMNS = (
    "export_generated_at",
    "row_kind",
    "item_id",
    "item_number",
    "item_description",
    "item_prefix_code",
    "item_tier_name",
    "item_tier_type",
    "is_consumable",
    "uom",
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
    "supplier_id",
    "supplier_name",
    "po_reference",
    "order_id",
    "order_status",
    "order_is_blanket",
    "order_is_archived",
    "location_node_id",
    "location_path",
    "location_name",
    "location_code",
    "location_node_type",
    "location_is_active",
    "qty_on_hand",
    "qty_awaiting_release",
    "qty_on_order",
    "qty_on_order_packs",
    "pack_uom",
    "units_per_pack",
    "unit_price_per_consume_unit",
    "unit_price_per_order_unit",
    "has_unit_price",
    "extended_value_amount",
    "value_basis",
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


def test_column_contract_is_frozen():
    """Order and membership are the contract finance builds spreadsheets on.

    A reordered column silently shifts every downstream formula, so this test
    exists to make that a failed build rather than a bad quarter. Changing it
    deliberately means changing this list too — and telling finance.
    """
    assert COLUMNS == EXPECTED_COLUMNS


def test_blank_row_covers_every_column():
    assert set(blank_row()) == set(COLUMNS)
    assert all(v is None for v in blank_row().values())


# ── Cell formatting ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, ""),
        (True, "true"),
        (False, "false"),
        (0, "0"),
        (-5, "-5"),
        (Decimal("0.000000"), "0.000000"),
        (Decimal("94.999998"), "94.999998"),
        (Decimal("1E+2"), "100"),
        (Decimal("-3.50"), "-3.50"),
        (date(2026, 8, 25), "2026-08-25"),
        (
            datetime(2026, 8, 25, 14, 3, 11, tzinfo=UTC),
            "2026-08-25T14:03:11+00:00",
        ),
        ("CryoStor CS10", "CryoStor CS10"),
        ("", ""),
    ],
)
def test_format_cell(value, expected):
    assert format_cell(value) == expected


def test_decimal_never_uses_scientific_notation():
    """Excel imports ``0E-6`` as text, which breaks a SUM without warning."""
    assert "E" not in format_cell(Decimal("0E-6")).upper()
    assert "E" not in format_cell(Decimal("1E+4")).upper()


def test_bool_is_checked_before_int():
    """``bool`` subclasses ``int``; the wrong branch order exports ``1``/``0``."""
    assert format_cell(True) == "true"
    assert format_cell(1) == "1"


def test_datetime_is_checked_before_date():
    """``datetime`` subclasses ``date``; the wrong order drops the time."""
    assert format_cell(datetime(2026, 8, 25, 9, 30, tzinfo=UTC)).endswith("+00:00")


def test_naive_datetime_is_treated_as_utc():
    assert format_cell(datetime(2026, 8, 25, 9, 30)) == "2026-08-25T09:30:00+00:00"


def test_uuid_formats_hyphenated():
    u = uuid.UUID("4f6edfed-44d6-4282-b9e6-0653e02caef9")
    assert format_cell(u) == "4f6edfed-44d6-4282-b9e6-0653e02caef9"


# ── CSV injection ───────────────────────────────────────────────────────


@pytest.mark.parametrize("payload", ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tfoo", "\rbar"])
def test_formula_injection_is_neutralised(payload):
    """Free text starting with a formula lead is executed by Excel and Sheets.

    This file is built from operator-entered descriptions, lot numbers, PO
    references and supplier names, then emailed to finance — so the guard is
    not theoretical.
    """
    assert guard_formula(payload).startswith("'")
    assert format_cell(payload).startswith("'")


def test_ordinary_text_is_untouched():
    for safe in ("CryoStor CS10", "PL-301-07", "Tank 1 › Quadrant 1", "0.95"):
        assert guard_formula(safe) == safe


def test_negative_numbers_are_not_quoted():
    """A negative *number* must stay a number — only free text is guarded."""
    assert format_cell(-5) == "-5"
    assert format_cell(Decimal("-3.50")) == "-3.50"


# ── File-level rendering ────────────────────────────────────────────────


def test_render_csv_has_bom_and_crlf():
    """The BOM is what stops Excel on Windows mojibake-ing ``›`` breadcrumbs."""
    out = render_csv([])
    assert out.startswith(b"\xef\xbb\xbf")
    assert out.endswith(b"\r\n")


def test_render_csv_header_matches_columns():
    text = render_csv([]).decode("utf-8-sig")
    assert text.strip().split(",") == list(COLUMNS)


def test_render_csv_round_trips_awkward_text():
    """A description with a comma, a quote and a newline must survive."""
    nasty = 'Media, "special", 500mL\nsecond line'
    row = blank_row() | {"row_kind": "on_hand", "item_description": nasty}
    parsed = list(csv.DictReader(io.StringIO(render_csv([row]).decode("utf-8-sig"))))
    assert len(parsed) == 1
    assert parsed[0]["item_description"] == nasty


def test_render_csv_writes_columns_in_order():
    row = blank_row() | {"row_kind": "on_hand", "qty_on_hand": 42}
    parsed = list(csv.reader(io.StringIO(render_csv([row]).decode("utf-8-sig"))))
    assert parsed[0] == list(COLUMNS)
    assert parsed[1][COLUMNS.index("qty_on_hand")] == "42"


def test_export_filename_is_ascii_and_sortable():
    name = export_filename(datetime(2026, 8, 25, 14, 3, 11, tzinfo=UTC))
    assert name == "cellready-inventory-20260825T140311Z.csv"
    assert name.isascii()


# ── Row builders: the flags that stop a cell being misread ──────────────


FACTS = ItemFacts(
    item_id=uuid.uuid4(),
    item_number="CR-1042",
    description="Media 500mL",
    prefix_code="CR",
    tier_name="Raw Materials",
    tier_type="raw_material",
    is_consumable=True,
    uom="Each",
)
GENERATED = datetime(2026, 8, 25, 12, 0, tzinfo=UTC)
TODAY = date(2026, 8, 25)


class _Lot:
    """Minimal stand-in for the ORM ``Lot`` the awaiting-release builder reads."""

    def __init__(self, **kw):
        defaults = {
            "id": uuid.uuid4(),
            "lot_number": "PL-301-07",
            "status": "available",
            "release_state": "quarantine",
            "manufacture_date": None,
            "expiration_date": None,
            "parent_lot_id": None,
            "supplier_id": None,
            "supplier": None,
            "po_reference": "PO-2026-0042",
            "receipt_transaction_id": uuid.uuid4(),
            "unit_price_amount": Decimal("0.950000"),
        }
        self.__dict__.update(defaults | kw)


def _awaiting(**lot_kw):
    from app.exports.rows import awaiting_release_row

    return awaiting_release_row(
        FACTS, _Lot(**lot_kw), 12, today=TODAY, generated_at=GENERATED
    )


def test_unpriced_stock_exports_blank_not_zero():
    """The decision that motivates the ``has_unit_price`` column.

    ``0`` would tell finance the stock is worthless. What we actually know is
    nothing, and an empty cell is the only honest way to say so.
    """
    row = _awaiting(unit_price_amount=None)
    assert row["has_unit_price"] is False
    assert row["extended_value_amount"] is None
    assert format_cell(row["extended_value_amount"]) == ""


def test_priced_stock_multiplies_at_row_grain():
    row = _awaiting(unit_price_amount=Decimal("0.950000"))
    assert row["has_unit_price"] is True
    assert row["extended_value_amount"] == Decimal("11.400000")
    assert row["value_basis"] == "awaiting_qty_x_lot_price"


@pytest.mark.parametrize(
    ("lot_number", "expected"),
    [
        ("AUTO-20260821-1", True),
        # Case-sensitive by design: a vendor lot that happens to read "auto-1"
        # must not be mislabelled as machine-generated.
        ("auto-1", False),
        ("PL-301-07", False),
    ],
)
def test_synthetic_lot_flag(lot_number, expected):
    assert _awaiting(lot_number=lot_number)["lot_number_is_synthetic"] is expected


@pytest.mark.parametrize(
    ("release_state", "applies"),
    [("released", True), ("quarantine", True), (None, False)],
)
def test_release_state_applies_flag(release_state, applies):
    """An empty ``lot_release_state`` means "no workflow applies", not "not
    released" — the normal case for every consumable and raw material."""
    row = _awaiting(release_state=release_state)
    assert row["release_state_applies"] is applies
    assert row["lot_release_state"] == release_state


@pytest.mark.parametrize(
    ("expiration", "has_date", "expired", "days"),
    [
        (date(2026, 8, 24), True, True, -1),
        (date(2026, 8, 25), True, False, 0),  # expires today is not yet expired
        (date(2026, 9, 24), True, False, 30),
        (None, False, False, None),
    ],
)
def test_expiry_flags(expiration, has_date, expired, days):
    """``is_expired=false`` with no date recorded must not read as "in date"."""
    row = _awaiting(expiration_date=expiration)
    assert row["has_expiration_date"] is has_date
    assert row["is_expired"] is expired
    assert row["days_to_expiry"] == days


def test_awaiting_release_row_has_no_location():
    """It genuinely has none — that is what "not yet received to inventory"
    means, and inventing one would be worse than the blank."""
    row = _awaiting()
    assert row["location_node_id"] is None
    assert row["location_path"] is None
    assert row["qty_awaiting_release"] == 12
    assert row["qty_on_hand"] is None


# ── Row-kind column applicability: the double-count guard ───────────────


def test_row_kinds_are_the_documented_four():
    assert ROW_KINDS == ("on_hand", "awaiting_release", "on_order", "item_valuation")


def test_quantity_columns_are_disjoint_across_row_kinds():
    """Each quantity lives on exactly one row kind.

    This is what makes ``SUM(...) GROUP BY row_kind`` meaningful. If a future
    edit populated ``qty_on_order`` on an ``on_hand`` row, a finance pivot
    would double-count and nothing else would complain.
    """
    row = _awaiting()
    populated = {
        c
        for c in ("qty_on_hand", "qty_awaiting_release", "qty_on_order")
        if row[c] is not None
    }
    assert populated == {"qty_awaiting_release"}


def test_item_level_columns_are_blank_on_detail_rows():
    """The item-level figures must never appear on a row that decomposes them,
    or they get multiplied by the number of rows per item."""
    row = _awaiting()
    for column in (
        "item_ui_inv_value_amount",
        "item_ui_po_value_amount",
        "item_qty_on_hand_ledger",
        "item_qty_available_ledger",
        "item_status_code",
    ):
        assert row[column] is None, column


def test_detail_value_is_blank_on_item_valuation_rows():
    """The mirror of the rule above — an ``item_valuation`` row carries the
    item totals and deliberately no ``extended_value_amount``, so the two can
    never be summed together."""
    from app.exports.rows import item_valuation_row

    class _Stock:
        qty_on_hand = Decimal("50")
        qty_available = Decimal("50")
        status_code = "available"
        last_movement_at = None

    class _Item:
        stock = _Stock()
        reorder_threshold = Decimal("20")

    row = item_valuation_row(
        FACTS,
        _Item(),
        inv_value=Decimal("47.50"),
        po_value=Decimal("190.00"),
        qty_on_order=Decimal("300"),
        qty_awaiting_release=12,
        generated_at=GENERATED,
    )
    assert row["extended_value_amount"] is None
    assert row["item_ui_inv_value_amount"] == Decimal("47.50")
    assert row["item_ui_po_value_amount"] == Decimal("190.00")
    assert row["qty_on_hand"] is None
    assert row["value_basis"] == "ledger_movements_x_lot_price"
