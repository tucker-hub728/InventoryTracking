"""The kit-cost export's column contract and union invariant (RPT-003).

The client asked for a raw dump he intends to hand to departments who will open
it in Excel and start totalling columns:

    "Ideally we would just do a data dump of all the information captured over a
    date range into a .CSV file that they can use…"
    — Blane Larson, 2026-08-27

That makes the **union invariant** the load-bearing property of this file:
every money column must be populated on exactly one ``row_kind``, so a naive
``SUM()`` down any money column is meaningful without anybody first knowing to
filter by kind. RPT-001 guards the same property for the same reason; the
failure mode is a plausible-looking total that double-counts.

The other guards here are the ones a spreadsheet cannot recover from:

  * **blank is not zero** — an unpriced lot must export ``""`` and never ``0``;
  * **zero is not blank** — the customer-owned cells on a $0 PO cost a real
    nothing, and reporting that as "unknown" would be equally wrong;
  * **scrap value stays inside the batch total** — it is an "of which", and a
    file that invited adding it would overstate every kit;
  * **CSV injection** — this file is assembled from operator free text (lot
    numbers, notes, descriptions) and is emailed to finance.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from app.exports.csv_writer import export_filename, format_cell, render_csv
from app.exports.kit_cost_rows import (
    KIT_COST_COLUMNS,
    KIT_COST_HEADERS,
    ROW_KIND_LABELS,
    ROW_KINDS,
    KitFacts,
    batch_consumption_row,
    batch_output_row,
    blank_row,
    header_row,
    kit_summary_row,
    material_issue_row,
    material_return_row,
    output_shipment_row,
)

GENERATED = datetime(2026, 8, 31, 14, 3, 11, tzinfo=UTC)
RANGE_FROM = datetime(2026, 8, 1, tzinfo=UTC)
RANGE_TO = datetime(2026, 9, 1, tzinfo=UTC)

STAMP = {"generated_at": GENERATED, "range_from": RANGE_FROM, "range_to": RANGE_TO}

KIT = KitFacts(
    kit_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
    kit_number="KIT-0289",
    status="closed",
    target_qty=5,
    item_number="AY-001",
    item_description="Buffer Sub-Assembly",
    production_location_path="Manufacturing Floor",
)

#: Every money column in the file. The union invariant is asserted against this
#: list, so a new money column added without a home fails the test rather than
#: quietly becoming double-countable.
MONEY_COLUMNS = (
    "issue_value_amount",
    "return_value_amount",
    "consumed_value_amount",
    "consumed_unit_cost_amount",
    "batch_material_cost_amount",
    "batch_unit_cost_amount",
    "batch_scrap_value_amount",
    "shipped_cost_amount",
    "kit_material_charged_amount",
    "kit_material_credited_amount",
    "kit_material_net_amount",
)


def _issue(**over):
    return material_issue_row(
        KIT,
        **{
            **STAMP,
            "movement_id": uuid.uuid4(),
            "event_at": datetime(2026, 8, 10, tzinfo=UTC),
            "movement_type": "kit_issue",
            "line_no": 1,
            "component_item_number": "CR-001",
            "component_item_description": "Media",
            "lot_number": "LOT-A",
            "unit_price": Decimal("1.500000"),
            "qty": 100,
            "performed_by_name": "Super Admin",
            "notes": None,
            **over,
        },
    )


def _return(**over):
    return material_return_row(
        KIT,
        **{
            **STAMP,
            "movement_id": uuid.uuid4(),
            "event_at": datetime(2026, 8, 12, tzinfo=UTC),
            "movement_type": "kit_return",
            "line_no": 1,
            "component_item_number": "CR-001",
            "component_item_description": "Media",
            "lot_number": "LOT-A",
            "unit_price": Decimal("1.500000"),
            "qty": 10,
            "performed_by_name": "Super Admin",
            "notes": None,
            **over,
        },
    )


def _consumption(**over):
    return batch_consumption_row(
        KIT,
        **{
            **STAMP,
            "event_at": datetime(2026, 8, 14, tzinfo=UTC),
            "batch_no": 1,
            "line_no": 1,
            "component_item_number": "CR-001",
            "component_item_description": "Media",
            "qty": 50,
            "unit_cost": Decimal("1.500000"),
            "extended_value": Decimal("75.000000"),
            "cost_is_complete": True,
            **over,
        },
    )


def _output(**over):
    return batch_output_row(
        KIT,
        **{
            **STAMP,
            "event_at": datetime(2026, 8, 14, tzinfo=UTC),
            "batch_no": 1,
            "good_qty": 4,
            "scrap_qty": 1,
            "output_lot_number": "PL-123",
            "output_lot_expiration_date": date(2027, 1, 1),
            "output_lot_release_state": "quarantine",
            "material_cost": Decimal("450.000000"),
            "unit_cost": Decimal("112.500000"),
            "scrap_value": Decimal("112.500000"),
            "cost_is_complete": True,
            "performed_by_name": "Super Admin",
            **over,
        },
    )


def _shipment(**over):
    return output_shipment_row(
        KIT,
        **{
            **STAMP,
            "movement_id": uuid.uuid4(),
            "event_at": datetime(2026, 8, 20, tzinfo=UTC),
            "output_lot_number": "PL-123",
            "qty": 4,
            "unit_cost": Decimal("112.500000"),
            "customer_name": "Johnson & Johnson",
            "reference_number": "SO-9001",
            "performed_by_name": "Super Admin",
            **over,
        },
    )


def _summary(**over):
    return kit_summary_row(
        KIT,
        **{
            **STAMP,
            "event_at": datetime(2026, 8, 1, tzinfo=UTC),
            "charged": Decimal("465.000000"),
            "credited": Decimal("15.000000"),
            "cost_is_complete": True,
            **over,
        },
    )


ALL_BUILDERS = (_issue, _return, _consumption, _output, _shipment, _summary)


# ── The column contract ─────────────────────────────────────────────────


def test_every_builder_emits_the_full_column_set():
    """A builder that forgets a column exports blank, never a short row."""
    for build in ALL_BUILDERS:
        assert set(build().keys()) == set(KIT_COST_COLUMNS)


def test_blank_row_covers_every_column():
    assert set(blank_row()) == set(KIT_COST_COLUMNS)
    assert all(v is None for v in blank_row().values())


def test_column_names_are_unique():
    assert len(KIT_COST_COLUMNS) == len(set(KIT_COST_COLUMNS))


def test_every_row_kind_has_a_builder():
    """One builder per kind, and each writes its LABEL rather than its key.

    The internal names group and filter inside the route; the file shows plain
    English, because "batch_consumption" is a cell value nobody outside this
    repo can read.
    """
    kinds = {build()["row_kind"] for build in ALL_BUILDERS}
    assert kinds == {ROW_KIND_LABELS[k] for k in ROW_KINDS}
    assert len(ROW_KIND_LABELS) == len(ROW_KINDS)


def test_headers_are_plain_english():
    """Every column has a title, and none of them leaks the internal key."""
    headers = header_row()
    assert len(headers) == len(KIT_COST_COLUMNS)
    unlabelled = [c for c in KIT_COST_COLUMNS if c not in KIT_COST_HEADERS]
    assert not unlabelled, f"no display title for {unlabelled}"
    # A reader should never meet a snake_case key in the header row.
    assert not [h for h in headers if "_" in h]


def test_money_columns_are_marked_as_money():
    """`($)` distinguishes a money column from a quantity at a glance."""
    for col in MONEY_COLUMNS:
        assert KIT_COST_HEADERS[col].endswith("($)"), col


# ── The union invariant ─────────────────────────────────────────────────


def test_each_money_column_belongs_to_exactly_one_row_kind():
    """The property that makes a naive `SUM()` down any money column safe.

    Without it, a finance pivot over the whole file silently double-counts —
    and it looks right, which is what makes it dangerous.
    """
    owners: dict[str, set[str]] = {col: set() for col in MONEY_COLUMNS}
    for build in ALL_BUILDERS:
        row = build()
        for col in MONEY_COLUMNS:
            if row[col] is not None:
                owners[col].add(row["row_kind"])
    for col, kinds in owners.items():
        assert len(kinds) == 1, f"{col} is populated on {sorted(kinds)} — must be exactly one"


def test_scrap_value_is_inside_the_batch_total_not_beside_it():
    """"Of which", not "plus". The client's bill must not be overstated."""
    row = _output()
    assert row["batch_scrap_value_amount"] <= row["batch_material_cost_amount"]
    # And the per-unit figure recovers the WHOLE material cost across good units
    # — which is how the customer ends up paying for the scrap.
    assert row["batch_unit_cost_amount"] * row["batch_good_qty"] == row[
        "batch_material_cost_amount"
    ]


def test_qty_means_finished_units_on_an_output_row():
    row = _output()
    assert row["qty"] == row["batch_good_qty"] == 4


def test_kit_summary_carries_no_quantity():
    """A kit-level qty would be summed against the detail rows by accident."""
    assert _summary()["qty"] is None


def test_net_is_charged_minus_credited():
    row = _summary()
    assert (
        row["kit_material_net_amount"]
        == row["kit_material_charged_amount"] - row["kit_material_credited_amount"]
    )


# ── Blank vs zero ───────────────────────────────────────────────────────


def test_an_unpriced_lot_exports_blank_never_zero():
    row = _issue(unit_price=None)
    assert row["issue_value_amount"] is None
    assert row["source_has_unit_price"] is False
    assert row["cost_is_complete"] is False
    assert format_cell(row["issue_value_amount"]) == ""


def test_a_zero_priced_lot_exports_a_real_zero():
    """The J&J case — customer-owned cells on a $0 PO cost a known nothing."""
    row = _issue(unit_price=Decimal("0"))
    assert row["issue_value_amount"] == Decimal("0")
    assert row["source_has_unit_price"] is True
    assert row["cost_is_complete"] is True
    assert format_cell(row["issue_value_amount"]) == "0"


def test_blank_and_zero_are_distinguishable_in_the_file():
    """The single assertion the whole companion-column device exists for."""
    assert format_cell(None) == ""
    assert format_cell(Decimal("0")) == "0"
    assert format_cell(None) != format_cell(Decimal("0"))


def test_an_uncosted_batch_blanks_every_money_column():
    row = _output(material_cost=None, unit_cost=None, scrap_value=None, cost_is_complete=False)
    assert row["batch_material_cost_amount"] is None
    assert row["batch_unit_cost_amount"] is None
    assert row["batch_scrap_value_amount"] is None
    assert row["cost_is_complete"] is False


def test_an_uncosted_kit_blanks_its_net_and_its_credit():
    """Credited alone would imply a net the file cannot actually compute."""
    row = _summary(charged=None)
    assert row["kit_material_charged_amount"] is None
    assert row["kit_material_credited_amount"] is None
    assert row["kit_material_net_amount"] is None


def test_a_shipment_of_an_uncosted_lot_reports_no_cost():
    row = _shipment(unit_cost=None)
    assert row["shipped_cost_amount"] is None
    assert row["cost_is_complete"] is False


# ── Grain rules ─────────────────────────────────────────────────────────


def test_a_consumption_row_names_no_source_lot():
    """Cost is attributed from a pool, so naming a lot would invent a fact.

    Identified lots live on the material_issue rows — identified lots on the
    charge side, pooled value on the consume side. That division is the design.
    """
    row = _consumption()
    assert row["source_lot_number"] is None
    assert row["source_unit_price_per_consume_unit"] is None


def test_the_three_return_types_stay_distinguishable():
    """Physically identical, different meanings — the file must keep them apart."""
    for mv_type in ("backflush", "kit_return", "kit_cancel_return"):
        assert _return(movement_type=mv_type)["event_type"] == mv_type


def test_a_shipment_names_the_customer_and_the_cost_together():
    """The join that closes the loop, and the reason this row kind exists."""
    row = _shipment()
    assert row["customer_name"] == "Johnson & Johnson"
    assert row["shipped_cost_amount"] == Decimal("450.000000")  # 4 x 112.50


def test_every_row_carries_the_range_it_was_taken_for():
    """A saved file must be able to say what window it represents."""
    for build in ALL_BUILDERS:
        row = build()
        assert row["range_from"] == RANGE_FROM
        assert row["range_to"] == RANGE_TO
        assert row["export_generated_at"] == GENERATED


def test_every_row_carries_the_kit_identity_block():
    for build in ALL_BUILDERS:
        row = build()
        assert row["kit_number"] == "KIT-0289"
        assert row["kit_item_number"] == "AY-001"


# ── Rendering ───────────────────────────────────────────────────────────


def test_rendered_csv_has_the_header_and_one_row_per_entry():
    body = render_csv([build() for build in ALL_BUILDERS], columns=KIT_COST_COLUMNS)
    text = body.decode("utf-8-sig")
    lines = text.strip().split("\r\n")
    assert lines[0].split(",")[0] == "export_generated_at"
    assert len(lines) == 1 + len(ALL_BUILDERS)


def test_csv_is_utf8_bom_and_crlf():
    """Excel on Windows needs both; without the BOM every path is mojibake."""
    body = render_csv([_issue()], columns=KIT_COST_COLUMNS)
    assert body.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" in body


def test_free_text_is_guarded_against_formula_injection():
    """Lot numbers and notes are operator-entered and this file gets emailed."""
    body = render_csv(
        [_issue(lot_number="=cmd|calc", notes="-2+3")], columns=KIT_COST_COLUMNS
    ).decode("utf-8-sig")
    assert "'=cmd|calc" in body
    assert "'-2+3" in body


def test_filename_names_this_export_and_stays_ascii():
    name = export_filename(GENERATED, "csv", prefix="kit-costs")
    assert name == "cellready-kit-costs-20260831T140311Z.csv"
    assert name.isascii()


def test_the_inventory_export_filename_is_unchanged():
    """The prefix parameter must not disturb RPT-001's existing filename."""
    assert export_filename(GENERATED) == "cellready-inventory-20260831T140311Z.csv"
