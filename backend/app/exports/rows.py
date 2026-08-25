"""Row builders for the finance export (RPT-001).

Pure functions over already-fetched data — no database. One builder per
``row_kind``; each returns a full-width dict keyed by ``csv_writer.COLUMNS``.

## Why the file is a tall union rather than one flat grain

The requirement asks for "current-state, full-column output" and the client
chose one row per (lot × location). Three facts finance needs do not live at
that grain and cannot be forced into it without breaking ``SUM()``:

* **on-order** is per open *order line* — no lot, no location;
* **awaiting release** is per *lot* that has arrived but is not yet received to
  inventory — no location;
* the **valuation the UI shows** is per *item*.

Stamping any of those onto every detail row multiplies them by the number of
rows per item, and a finance pivot would silently over-count. So each fact gets
its own ``row_kind`` and its own columns, blank on the other kinds. Every money
and quantity column is therefore populated on exactly one kind, and
``SUM(...) GROUP BY row_kind`` is always meaningful.

## Which value goes on a detail row

``extended_value_amount`` on an ``on_hand`` row is ``allocation qty × that
lot's price`` — not the item-level ``inv_value_amount`` the item page shows.
A value column has to sum to the rows it sits on, or a pivot by location, by
supplier or by expiry bucket is arithmetic nonsense, and pivoting is the entire
use case.

These are the same number when the data is consistent: ``inv_value`` is
``Σ(movement.qty_delta × lot.unit_price_amount)``, which is
``Σ(per-lot on-hand × per-lot price)`` since price is constant per lot. Picking
the row-grain formula does not pick a *different* number, it picks a
*decomposable* one. The ``item_valuation`` rows carry the UI's figures beside
it so the two can be reconciled inside the file rather than argued about in a
meeting — see ``docs/modules/finance-export.md``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from app.inventory.repository import is_synthetic_lot_number

from .csv_writer import COLUMNS

RowKind = Literal["on_hand", "awaiting_release", "on_order", "item_valuation"]

#: Emission order. ``on_hand`` first so the file opens on the rows finance
#: reads most; ``item_valuation`` last because it is the cross-check, not the
#: data.
ROW_KINDS: tuple[RowKind, ...] = (
    "on_hand",
    "awaiting_release",
    "on_order",
    "item_valuation",
)

# Names the formula behind ``extended_value_amount`` on each row, so nobody has
# to reverse-engineer which grain a number came from.
VALUE_BASIS_ON_HAND = "allocation_qty_x_lot_price"
VALUE_BASIS_AWAITING = "awaiting_qty_x_lot_price"
VALUE_BASIS_ON_ORDER = "outstanding_packs_x_line_price"
VALUE_BASIS_LEDGER = "ledger_movements_x_lot_price"


@dataclass(frozen=True)
class ItemFacts:
    """The item identity block repeated on every row kind.

    Assembled once per item so the four builders cannot disagree about what
    ``CR-1042`` is called.
    """

    item_id: uuid.UUID
    item_number: str
    description: str
    prefix_code: str | None
    tier_name: str | None
    tier_type: str | None
    is_consumable: bool
    uom: str | None


def item_facts_from_orm(item: Any) -> ItemFacts:
    """``ItemFacts`` from a hydrated ``Item``.

    ``item_number`` and ``tier`` are derived properties that walk
    ``item.prefix`` — eagerly joined on the model, so this costs no query.
    """
    tier = item.tier
    return ItemFacts(
        item_id=item.id,
        item_number=item.item_number,
        description=item.description,
        prefix_code=item.prefix.code if item.prefix else None,
        tier_name=tier.name if tier else None,
        tier_type=tier.type if tier else None,
        is_consumable=bool(item.is_consumable),
        uom=item.uom,
    )


def blank_row() -> dict[str, Any]:
    """A full-width row of ``None``.

    Every builder starts here, so a column added to ``COLUMNS`` and forgotten
    in a builder exports blank rather than raising — and blank is the honest
    answer for "this kind of row has no such fact".
    """
    return dict.fromkeys(COLUMNS)


def _base(
    facts: ItemFacts, kind: RowKind, generated_at: datetime
) -> dict[str, Any]:
    row = blank_row()
    row["export_generated_at"] = generated_at
    row["row_kind"] = kind
    row["item_id"] = facts.item_id
    row["item_number"] = facts.item_number
    row["item_description"] = facts.description
    row["item_prefix_code"] = facts.prefix_code
    row["item_tier_name"] = facts.tier_name
    row["item_tier_type"] = facts.tier_type
    row["is_consumable"] = facts.is_consumable
    row["uom"] = facts.uom
    return row


def _apply_lot(
    row: dict[str, Any],
    *,
    lot_id: uuid.UUID,
    lot_number: str | None,
    lot_status: str | None,
    release_state: str | None,
    manufacture_date: date | None,
    expiration_date: date | None,
    parent_lot_id: uuid.UUID | None,
    today: date,
) -> None:
    """Fill the lot block, including the three companion flags.

    The flags exist because each of these columns is misread without one:

    * ``lot_number_is_synthetic`` — ``AUTO-20260821-2`` is a machine-minted
      placeholder meaning *no supplier lot number was captured*, not a vendor
      batch. Uses the same case-sensitive test the rest of the system does.
    * ``release_state_applies`` — an empty ``lot_release_state`` reads as "not
      released" when it in fact means *no release workflow applies*, which is
      the normal case for every consumable and raw material. This is the single
      most misreadable column in the file.
    * ``has_expiration_date`` — without it, ``is_expired = false`` reads as
      "in date" when the truth may be "no date was ever recorded".
    """
    row["lot_id"] = lot_id
    row["lot_number"] = lot_number
    row["lot_number_is_synthetic"] = is_synthetic_lot_number(lot_number)
    row["lot_status"] = lot_status
    row["lot_release_state"] = release_state
    row["release_state_applies"] = release_state is not None
    row["manufacture_date"] = manufacture_date
    row["expiration_date"] = expiration_date
    row["has_expiration_date"] = expiration_date is not None
    # Deliberately the same predicate ``app.v_item_stock.qty_available`` uses,
    # so "expired" means one thing in the CSV and on the item page.
    row["is_expired"] = expiration_date is not None and expiration_date < today
    row["days_to_expiry"] = (
        (expiration_date - today).days if expiration_date is not None else None
    )
    row["parent_lot_id"] = parent_lot_id


def _apply_value(
    row: dict[str, Any],
    *,
    qty: int | Decimal | None,
    unit_price: Decimal | None,
    basis: str,
) -> None:
    """Fill ``has_unit_price`` / ``extended_value_amount`` / ``value_basis``.

    The blank-not-zero rule lives here: with no price recorded the extended
    value is left ``None`` so it exports as an empty cell. A ``0`` would tell
    finance the stock is worthless, when what we actually know is nothing.
    """
    row["has_unit_price"] = unit_price is not None
    row["value_basis"] = basis
    if unit_price is None or qty is None:
        return
    row["extended_value_amount"] = Decimal(qty) * unit_price


def on_hand_row(
    facts: ItemFacts,
    sql_row: Any,
    *,
    location_name: str,
    location_path: str,
    today: date,
    generated_at: datetime,
) -> dict[str, Any]:
    """One active allocation, grouped to (lot × location). The detail grain."""
    row = _base(facts, "on_hand", generated_at)
    _apply_lot(
        row,
        lot_id=sql_row.lot_id,
        lot_number=sql_row.lot_number,
        lot_status=sql_row.lot_status,
        release_state=sql_row.release_state,
        manufacture_date=sql_row.manufacture_date,
        expiration_date=sql_row.expiration_date,
        parent_lot_id=sql_row.parent_lot_id,
        today=today,
    )
    row["supplier_id"] = sql_row.supplier_id
    row["supplier_name"] = sql_row.supplier_name
    row["po_reference"] = sql_row.po_reference
    row["order_id"] = sql_row.receipt_transaction_id
    row["location_node_id"] = sql_row.location_node_id
    row["location_path"] = location_path
    row["location_name"] = location_name
    row["location_code"] = sql_row.location_code
    row["location_node_type"] = sql_row.location_node_type
    row["location_is_active"] = sql_row.location_is_active
    row["qty_on_hand"] = int(sql_row.qty)
    row["unit_price_per_consume_unit"] = sql_row.unit_price_amount
    _apply_value(
        row,
        qty=int(sql_row.qty),
        unit_price=sql_row.unit_price_amount,
        basis=VALUE_BASIS_ON_HAND,
    )
    return row


def awaiting_release_row(
    facts: ItemFacts,
    lot: Any,
    remaining: int,
    *,
    today: date,
    generated_at: datetime,
) -> dict[str, Any]:
    """A lot that has arrived but has not been received to inventory.

    Blank location, deliberately: it has none. This material has no allocation
    and no ledger movement, so it is in neither the on-hand total nor the item
    page's "Inventory $" — folding it into ``qty_on_hand`` would make the CSV
    disagree with every other surface in the product. But it is on site and
    paid for, so hiding it from a finance export would be the opposite error.
    Its own row kind lets finance decide, which is their call to make.
    """
    row = _base(facts, "awaiting_release", generated_at)
    _apply_lot(
        row,
        lot_id=lot.id,
        lot_number=lot.lot_number,
        lot_status=lot.status,
        release_state=lot.release_state,
        manufacture_date=lot.manufacture_date,
        expiration_date=lot.expiration_date,
        parent_lot_id=lot.parent_lot_id,
        today=today,
    )
    row["supplier_id"] = lot.supplier_id
    row["supplier_name"] = lot.supplier.name if lot.supplier else None
    row["po_reference"] = lot.po_reference
    row["order_id"] = lot.receipt_transaction_id
    row["qty_awaiting_release"] = remaining
    row["unit_price_per_consume_unit"] = lot.unit_price_amount
    _apply_value(
        row,
        qty=remaining,
        unit_price=lot.unit_price_amount,
        basis=VALUE_BASIS_AWAITING,
    )
    return row


def on_order_row(
    facts: ItemFacts, sql_row: Any, *, generated_at: datetime
) -> dict[str, Any]:
    """One open order line with outstanding quantity — an unfilled commitment.

    Two quantity columns, and both are needed. ``qty_on_order_packs`` is in
    ORDER units ("2 Box") and is what the line price multiplies;
    ``qty_on_order`` is the same number in CONSUME units so it is comparable
    with on-hand. Publishing only the consume figure beside a per-order-unit
    price makes ``value ÷ qty`` look like a wrong price by a factor of
    ``units_per_pack`` — which is exactly the 100× error the two separate
    ``unit_price_*`` columns exist to prevent.
    """
    row = _base(facts, "on_order", generated_at)
    packs = int(sql_row.outstanding_packs)
    per_pack = int(sql_row.units_per_pack) if sql_row.units_per_pack else 1
    row["supplier_id"] = sql_row.supplier_id
    row["supplier_name"] = sql_row.supplier_name
    row["po_reference"] = sql_row.po_reference
    row["order_id"] = sql_row.order_id
    row["order_status"] = sql_row.order_status
    row["order_is_blanket"] = sql_row.is_blanket
    # Should be false on every row: an order with anything outstanding cannot
    # reach a terminal status, and only terminal orders archive (DATA-002).
    # Carried anyway because ``compute_item_valuations`` does not filter
    # ``archived_at`` either — if that invariant ever breaks, finance sees it
    # here instead of the total being quietly wrong.
    row["order_is_archived"] = sql_row.archived_at is not None
    row["qty_on_order"] = packs * per_pack
    row["qty_on_order_packs"] = packs
    row["pack_uom"] = sql_row.pack_uom
    row["units_per_pack"] = sql_row.units_per_pack
    row["unit_price_per_order_unit"] = sql_row.unit_price_amount
    # No conversion: both factors are already in order units, so 2 Box ×
    # $95.00/Box is the right $190.00. Converting either half double-counts.
    _apply_value(
        row,
        qty=packs,
        unit_price=sql_row.unit_price_amount,
        basis=VALUE_BASIS_ON_ORDER,
    )
    return row


def item_valuation_row(
    facts: ItemFacts,
    item: Any,
    *,
    inv_value: Decimal,
    po_value: Decimal,
    qty_on_order: Decimal,
    qty_awaiting_release: int,
    generated_at: datetime,
) -> dict[str, Any]:
    """The item-level cross-check — one row per item, whatever its stock.

    Carries the two figures the item page renders so finance can verify the
    detail rows in one pivot::

        SUM(extended_value_amount) WHERE row_kind='on_hand'  GROUP BY item_id
            == item_ui_inv_value_amount  WHERE row_kind='item_valuation'
        SUM(extended_value_amount) WHERE row_kind='on_order' GROUP BY item_id
            == item_ui_po_value_amount   WHERE row_kind='item_valuation'

    ``extended_value_amount`` is deliberately left blank on this row kind.
    That blank is what stops these totals being summed together with the
    detail rows that decompose them.
    """
    row = _base(facts, "item_valuation", generated_at)
    row["value_basis"] = VALUE_BASIS_LEDGER
    row["item_ui_inv_value_amount"] = inv_value
    row["item_ui_po_value_amount"] = po_value
    stock = item.stock
    row["item_qty_on_hand_ledger"] = stock.qty_on_hand if stock else Decimal("0")
    row["item_qty_available_ledger"] = stock.qty_available if stock else Decimal("0")
    row["item_qty_on_order"] = qty_on_order
    row["item_qty_awaiting_release"] = qty_awaiting_release
    row["item_status_code"] = stock.status_code if stock else None
    row["item_reorder_threshold"] = item.reorder_threshold
    row["item_last_movement_at"] = stock.last_movement_at if stock else None
    return row
