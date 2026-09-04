"""Row builders for the kit-cost export (RPT-003).

Pure functions over already-fetched data — no database. One builder per
``row_kind``; each returns a full-width dict keyed by :data:`KIT_COST_COLUMNS`.

    "No Canned Query is required at this time. I want them to pull the data out
    from the system through the Export function and they can use AI or
    equivalent to mine the data using spreadsheets or some other output. …
    Ideally we would just do a data dump of all the information captured over a
    date range into a .CSV file that they can use and show me what they want as
    an output that we can supply later."
    — Blane Larson, 2026-08-27

So this file is deliberately **wide and unopinionated**. It is the raw material
for a report nobody has specified yet, not the report — which is why no
aggregation, ranking or filtering beyond the date range happens here.

## Why a union of row kinds rather than one flat grain

Same discipline as RPT-001 (``rows.py``), for the same reason. The facts asked
for live at four different grains and cannot be forced into one:

* a **material issue** is per (movement × source lot) — it has a lot and a price;
* a **batch consumption** is per (batch × component) — it has no source lot,
  because cost is attributed as a moving average over a pool;
* a **batch output** is per finished lot — one row, one price, one customer bill;
* a **kit summary** is per kit.

Stamping any of those onto the others multiplies it, and a finance pivot would
silently over-count. So each gets its own ``row_kind`` and its own money column,
blank on the other kinds. **Every money column is populated on exactly one kind**,
so ``SUM(...)`` down any money column is meaningful without a filter — which is
what makes the file safe to hand to someone who will open it in Excel and start
totalling things.

## The one number a reader must not add up twice

``batch_scrap_value_amount`` is a **slice** of ``batch_material_cost_amount``,
not an addition to it. The scrapped units' material was charged at issue and is
already inside the batch total; it is broken out so the loss is visible. It has
its own column rather than its own row kind for exactly this reason — a row
would invite a ``SUM`` that double-counts, a column beside the total reads as
the "of which" it is.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from app.inventory.repository import is_synthetic_lot_number

RowKind = Literal[
    "material_issue",
    "material_return",
    "batch_consumption",
    "batch_output",
    "output_shipment",
    "kit_summary",
]

#: Emission order — the life of the material, top to bottom: what went in, what
#: came back, what each batch consumed, what it produced, where that went, and
#: the kit's own totals last as the cross-check.
ROW_KINDS: tuple[RowKind, ...] = (
    "material_issue",
    "material_return",
    "batch_consumption",
    "batch_output",
    "output_shipment",
    "kit_summary",
)

#: Column order is a contract — finance builds pivots against positions as well
#: as headers, so a reordering is a breaking change even though a rename is
#: obviously one. Frozen by ``tests/test_exports_kit_costs_csv.py``.
KIT_COST_COLUMNS: tuple[str, ...] = (
    # ── Export metadata ──
    "export_generated_at",
    "row_kind",
    "range_from",
    "range_to",
    # ── Kit identity ──
    "kit_id",
    "kit_number",
    "kit_status",
    "kit_target_qty",
    "kit_item_number",
    "kit_item_description",
    "production_location_path",
    # ── The event ──
    "event_at",
    "event_type",
    "movement_id",
    "performed_by_name",
    "notes",
    # ── Batch ──
    "batch_no",
    "batch_good_qty",
    "batch_scrap_qty",
    # ── Component line ──
    "line_no",
    "component_item_number",
    "component_item_description",
    # ── Source lot (populated on the movement kinds only) ──
    "source_lot_number",
    "source_lot_is_synthetic",
    "source_unit_price_per_consume_unit",
    "source_has_unit_price",
    # ── Output lot ──
    "output_lot_number",
    "output_lot_expiration_date",
    "output_lot_release_state",
    # ── Customer ──
    "customer_name",
    "shipment_reference_number",
    # ── Quantity (one column; its meaning is given by row_kind) ──
    "qty",
    # ── Money — each populated on exactly ONE row_kind ──
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
    # ── Completeness companions ──
    "cost_is_complete",
)


#: What each ``row_kind`` is called in the file. The internal names are what the
#: code groups and filters on; these are what a reader sees, because
#: "batch_consumption" is a column value nobody outside this repo can interpret.
ROW_KIND_LABELS: dict[RowKind, str] = {
    "material_issue": "Material issued",
    "material_return": "Material returned",
    "batch_consumption": "Material used in batch",
    "batch_output": "Finished lot",
    "output_shipment": "Shipped to customer",
    "kit_summary": "Kit total",
}

#: Plain-English column titles.
#:
#: RPT-001 deliberately ships snake_case headers — finance pivots against those
#: keys and a rename would break saved workbooks. This file has a different
#: audience: the client asked for something departments could "mine using
#: spreadsheets", and ``source_unit_price_per_consume_unit`` is not a heading
#: anyone reads. The row dicts keep the internal keys; only the header row
#: changes, so the code and the tests are unaffected.
#:
#: Money columns carry ``($)`` so a reader can tell them from quantities at a
#: glance, and the two "?" columns are the companions that separate a blank
#: from a zero.
KIT_COST_HEADERS: dict[str, str] = {
    "export_generated_at": "Exported at",
    "row_kind": "Record type",
    "range_from": "Range from",
    "range_to": "Range to",
    "kit_id": "Kit ID",
    "kit_number": "Kit",
    "kit_status": "Kit status",
    "kit_target_qty": "Kit target qty",
    "kit_item_number": "Making",
    "kit_item_description": "Making (description)",
    "production_location_path": "Production location",
    "event_at": "Date",
    "event_type": "Event",
    "movement_id": "Transaction ID",
    "performed_by_name": "By",
    "notes": "Notes",
    "batch_no": "Batch",
    "batch_good_qty": "Batch good units",
    "batch_scrap_qty": "Batch scrapped units",
    "line_no": "Line",
    "component_item_number": "Component",
    "component_item_description": "Component description",
    "source_lot_number": "From lot",
    "source_lot_is_synthetic": "From lot auto-numbered?",
    "source_unit_price_per_consume_unit": "Price per unit ($)",
    "source_has_unit_price": "Price recorded?",
    "output_lot_number": "Finished lot",
    "output_lot_expiration_date": "Finished lot expiry",
    "output_lot_release_state": "Finished lot quality status",
    "customer_name": "Customer",
    "shipment_reference_number": "Shipment reference",
    "qty": "Quantity",
    "issue_value_amount": "Material issued ($)",
    "return_value_amount": "Material returned ($)",
    "consumed_value_amount": "Material used ($)",
    "consumed_unit_cost_amount": "Material used, per unit ($)",
    "batch_material_cost_amount": "Batch material cost ($)",
    "batch_unit_cost_amount": "Cost per good unit ($)",
    "batch_scrap_value_amount": "Of which scrap ($)",
    "shipped_cost_amount": "Shipped cost ($)",
    "kit_material_charged_amount": "Kit total charged ($)",
    "kit_material_credited_amount": "Kit total returned ($)",
    "kit_material_net_amount": "Kit net material cost ($)",
    "cost_is_complete": "Cost complete?",
}


def header_row(columns: tuple[str, ...] = KIT_COST_COLUMNS) -> tuple[str, ...]:
    """The display header for ``columns``.

    Falls back to the raw key for anything unlabelled, so a column added without
    a title still exports — badly named, but present, which beats a KeyError
    500 on a download.
    """
    return tuple(KIT_COST_HEADERS.get(c, c) for c in columns)


@dataclass(frozen=True)
class KitFacts:
    """The kit identity block repeated on every row of that kit.

    Built once per kit and stamped onto each row, so the file can be filtered to
    one kit without a join. Repetition is the point of a flat export.
    """

    kit_id: uuid.UUID
    kit_number: str
    status: str
    target_qty: int
    item_number: str
    item_description: str
    production_location_path: str | None


def blank_row() -> dict[str, Any]:
    """A full-width row of ``None``.

    Every builder starts here so a column added to :data:`KIT_COST_COLUMNS` and
    forgotten in a builder exports **blank** rather than raising — the same
    defensive default RPT-001 uses.
    """
    return dict.fromkeys(KIT_COST_COLUMNS)


def _base(
    kind: RowKind,
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
) -> dict[str, Any]:
    row = blank_row()
    row["export_generated_at"] = generated_at
    # The LABEL, not the internal key — this cell is read by people. Grouping
    # and filtering in the route key off the literal kind, never off this value,
    # so relabelling is a display change only.
    row["row_kind"] = ROW_KIND_LABELS[kind]
    row["range_from"] = range_from
    row["range_to"] = range_to
    row["kit_id"] = kit.kit_id
    row["kit_number"] = kit.kit_number
    row["kit_status"] = kit.status
    row["kit_target_qty"] = kit.target_qty
    row["kit_item_number"] = kit.item_number
    row["kit_item_description"] = kit.item_description
    row["production_location_path"] = kit.production_location_path
    return row


def _price_columns(row: dict[str, Any], unit_price: Decimal | None) -> None:
    """Write the source-lot price and its companion flag.

    ``source_has_unit_price`` exists because a blank price and a ``$0`` price
    are different facts and a spreadsheet cannot tell them apart: customer-owned
    cells received on a $0 PO genuinely cost nothing, while a kit-produced lot
    from before ``kitcost01`` simply has no price recorded. RPT-001 draws the
    same distinction with the same companion-column device.
    """
    row["source_unit_price_per_consume_unit"] = unit_price
    row["source_has_unit_price"] = unit_price is not None


def material_issue_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    movement_id: uuid.UUID,
    event_at: datetime,
    movement_type: str,
    line_no: int | None,
    component_item_number: str | None,
    component_item_description: str | None,
    lot_number: str | None,
    unit_price: Decimal | None,
    qty: int,
    performed_by_name: str | None,
    notes: str | None,
) -> dict[str, Any]:
    """One ``kit_issue`` / ``kit_additional_issue`` — material charged to the kit.

    This is the **charge side** of the cost formula, at its finest grain: the
    identified source lot and the price it was charged at. It is the only place
    in the file where a specific lot is tied to a specific price, which is what
    makes a blended ``consumed_unit_cost_amount`` downstream checkable.
    """
    row = _base(
        "material_issue", kit, generated_at=generated_at, range_from=range_from, range_to=range_to
    )
    row["event_at"] = event_at
    row["event_type"] = movement_type
    row["movement_id"] = movement_id
    row["line_no"] = line_no
    row["component_item_number"] = component_item_number
    row["component_item_description"] = component_item_description
    row["source_lot_number"] = lot_number
    row["source_lot_is_synthetic"] = (
        is_synthetic_lot_number(lot_number) if lot_number is not None else None
    )
    _price_columns(row, unit_price)
    row["qty"] = qty
    row["issue_value_amount"] = None if unit_price is None else unit_price * Decimal(qty)
    row["cost_is_complete"] = unit_price is not None
    row["performed_by_name"] = performed_by_name
    row["notes"] = notes
    return row


def material_return_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    movement_id: uuid.UUID,
    event_at: datetime,
    movement_type: str,
    line_no: int | None,
    component_item_number: str | None,
    component_item_description: str | None,
    lot_number: str | None,
    unit_price: Decimal | None,
    qty: int,
    performed_by_name: str | None,
    notes: str | None,
) -> dict[str, Any]:
    """One ``backflush`` / ``kit_return`` / ``kit_cancel_return``.

    The **credit side**. Kept as its own kind rather than a signed
    ``issue_value_amount`` so that summing either column alone answers a real
    question ("what did we hand this kit?" / "what came back?"), and their
    difference is the kit's net — which is what ``kit_summary`` publishes.

    ``event_type`` preserves which of the three returns it was: they are
    physically identical and mean different things — a signed close-out
    reconciliation, an excess handed back mid-production, or a cancellation.
    """
    row = _base(
        "material_return", kit, generated_at=generated_at, range_from=range_from, range_to=range_to
    )
    row["event_at"] = event_at
    row["event_type"] = movement_type
    row["movement_id"] = movement_id
    row["line_no"] = line_no
    row["component_item_number"] = component_item_number
    row["component_item_description"] = component_item_description
    row["source_lot_number"] = lot_number
    row["source_lot_is_synthetic"] = (
        is_synthetic_lot_number(lot_number) if lot_number is not None else None
    )
    _price_columns(row, unit_price)
    row["qty"] = qty
    row["return_value_amount"] = None if unit_price is None else unit_price * Decimal(qty)
    row["cost_is_complete"] = unit_price is not None
    row["performed_by_name"] = performed_by_name
    row["notes"] = notes
    return row


def batch_consumption_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    event_at: datetime,
    batch_no: int,
    line_no: int | None,
    component_item_number: str | None,
    component_item_description: str | None,
    qty: int,
    unit_cost: Decimal | None,
    extended_value: Decimal | None,
    cost_is_complete: bool,
) -> dict[str, Any]:
    """What one batch drew from one component line.

    **No source lot, deliberately.** Cost is attributed as a moving weighted
    average over what the line still holds, so a batch consumes value from a
    pool rather than from identified lots; naming a lot here would invent a fact
    the system does not have. The identified lots are on the
    ``material_issue`` rows above — identified lots on the charge side, pooled
    value on the consume side.

    ``consumed_unit_cost_amount`` is **frozen** at the moment of consumption.
    Lot prices stay editable after receive, so re-deriving it later would
    silently change what a customer was charged.
    """
    row = _base(
        "batch_consumption",
        kit,
        generated_at=generated_at,
        range_from=range_from,
        range_to=range_to,
    )
    row["event_at"] = event_at
    row["event_type"] = "consumption"
    row["batch_no"] = batch_no
    row["line_no"] = line_no
    row["component_item_number"] = component_item_number
    row["component_item_description"] = component_item_description
    row["qty"] = qty
    row["consumed_unit_cost_amount"] = unit_cost
    row["consumed_value_amount"] = extended_value
    row["cost_is_complete"] = cost_is_complete
    return row


def batch_output_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    event_at: datetime,
    batch_no: int,
    good_qty: int,
    scrap_qty: int,
    output_lot_number: str | None,
    output_lot_expiration_date: date | None,
    output_lot_release_state: str | None,
    material_cost: Decimal | None,
    unit_cost: Decimal | None,
    scrap_value: Decimal | None,
    cost_is_complete: bool,
    performed_by_name: str | None,
) -> dict[str, Any]:
    """One finished lot and what it cost — the row the client asked for.

    *"The FG Lot-xxx should pull through all the costs… so the Customer can be
    charged the actual cost for that particular FG Lot."*

    ``batch_unit_cost_amount`` is ``material ÷ good_qty`` — **good units only**,
    which is how scrap reaches the customer's bill. ``batch_scrap_value_amount``
    then reports the portion lost to failed units; it is already inside
    ``batch_material_cost_amount`` and must never be added to it.

    ``qty`` is ``good_qty`` here, so summing the column across this kind counts
    finished units and nothing else.
    """
    row = _base(
        "batch_output", kit, generated_at=generated_at, range_from=range_from, range_to=range_to
    )
    row["event_at"] = event_at
    row["event_type"] = "produce"
    row["batch_no"] = batch_no
    row["batch_good_qty"] = good_qty
    row["batch_scrap_qty"] = scrap_qty
    row["output_lot_number"] = output_lot_number
    row["output_lot_expiration_date"] = output_lot_expiration_date
    row["output_lot_release_state"] = output_lot_release_state
    row["qty"] = good_qty
    row["batch_material_cost_amount"] = material_cost
    row["batch_unit_cost_amount"] = unit_cost
    row["batch_scrap_value_amount"] = scrap_value
    row["cost_is_complete"] = cost_is_complete
    row["performed_by_name"] = performed_by_name
    return row


def output_shipment_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    movement_id: uuid.UUID,
    event_at: datetime,
    output_lot_number: str | None,
    qty: int,
    unit_cost: Decimal | None,
    customer_name: str | None,
    reference_number: str | None,
    performed_by_name: str | None,
) -> dict[str, Any]:
    """A finished lot leaving to a customer, priced at what it cost to make.

    This kind is what closes the loop the client described — cost in at one end,
    a named customer at the other. Without it the file would need a manual
    VLOOKUP from shipments back to batches to answer "what did we charge whom",
    which is the first question anyone will ask of it.
    """
    row = _base(
        "output_shipment", kit, generated_at=generated_at, range_from=range_from, range_to=range_to
    )
    row["event_at"] = event_at
    row["event_type"] = "customer_shipment"
    row["movement_id"] = movement_id
    row["output_lot_number"] = output_lot_number
    row["customer_name"] = customer_name
    row["shipment_reference_number"] = reference_number
    row["qty"] = qty
    row["shipped_cost_amount"] = None if unit_cost is None else unit_cost * Decimal(qty)
    row["cost_is_complete"] = unit_cost is not None
    row["performed_by_name"] = performed_by_name
    return row


def kit_summary_row(
    kit: KitFacts,
    *,
    generated_at: datetime,
    range_from: datetime | None,
    range_to: datetime | None,
    event_at: datetime,
    charged: Decimal | None,
    credited: Decimal,
    cost_is_complete: bool,
) -> dict[str, Any]:
    """One row per kit — the live net, as the cross-check.

    Deliberately **live**: it re-reads lot prices, which stay editable after
    receive. The per-batch figures beside it are frozen at produce time. Both
    are published so a divergence is a subtraction the reader can perform rather
    than a meeting — and a divergence is *correct*, because a shipped lot's cost
    must not move when somebody corrects a price months later.

    Carries no ``qty``: a kit-level quantity would have to pick one of several
    meanings and would be summed against the detail rows by accident.
    """
    row = _base(
        "kit_summary", kit, generated_at=generated_at, range_from=range_from, range_to=range_to
    )
    row["event_at"] = event_at
    row["event_type"] = "kit"
    row["kit_material_charged_amount"] = charged
    row["kit_material_credited_amount"] = credited if charged is not None else None
    row["kit_material_net_amount"] = None if charged is None else charged - credited
    row["cost_is_complete"] = cost_is_complete
    return row
