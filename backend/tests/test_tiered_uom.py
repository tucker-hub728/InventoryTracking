"""Tiered unit of measure — the order-unit / consume-unit boundary (REQ-001).

An item may be ordered in Box and consumed in Each. The whole feature rests on
one rule: ``ordered_qty`` and ``qty_received`` are in ORDER units, everything
from the lot onward is in CONSUME units, and exactly one multiplication sits
between them.

The failure mode this file exists to catch is not a crash. ``3`` and ``300`` are
both entirely plausible values for every column involved, so a conversion in the
wrong direction — or a missing one — produces a number that is wrong by two
orders of magnitude and looks completely ordinary in the UI, in the audit trail,
and in the signed record. Nothing raises. So the arithmetic and the validation
around it are tested directly rather than through HTTP: the thing under test is
the multiplication, not the transport.

The end-to-end path (raise an order, receive against it, place the units) lives
in ``smoke_tiered_uom.py``, which needs a live API and a password.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from app.core.bounds import MAX_QTY
from app.inventory.repository import packs_to_units, units_to_packs
from app.inventory.schemas import ItemCreate, ItemUpdate, OrderLineInput
from pydantic import ValidationError as PydanticValidationError

# ── The conversion itself ─────────────────────────────────────────────


class TestPacksToUnits:
    """Order units → consume units. The only multiplication in the feature."""

    def test_multiplies_by_the_pack_size(self) -> None:
        assert packs_to_units(3, 100) == 300

    def test_none_factor_passes_through(self) -> None:
        # Every line predating REQ-001 has no pack: it was ordered in the unit
        # it is consumed in, so 150 ordered is 150 placed. This is the branch
        # that keeps existing orders behaving identically.
        assert packs_to_units(150, None) == 150

    def test_factor_of_one_is_not_special(self) -> None:
        assert packs_to_units(7, 1) == 7

    def test_zero_packs_is_zero_units(self) -> None:
        # Outstanding hits 0 on a fully-received line and is converted for
        # display; 0 must not become the pack size.
        assert packs_to_units(0, 100) == 0


class TestUnitsToPacks:
    """Consume units → order units. Only the lot-quantity correction needs it."""

    def test_divides_by_the_pack_size(self) -> None:
        assert units_to_packs(300, 100) == 3

    def test_none_factor_passes_through(self) -> None:
        assert units_to_packs(150, None) == 150

    def test_round_trips(self) -> None:
        for packs in (1, 3, 17, 1000):
            assert units_to_packs(packs_to_units(packs, 100), 100) == packs

    def test_rejects_a_partial_pack(self) -> None:
        # 250 units of a 100-pack is two and a half boxes. There is no honest
        # value to write back to a column counting boxes, and picking 2 or 3
        # would silently move the order's fulfilment state to something nobody
        # chose — so it refuses rather than guesses.
        with pytest.raises(ValueError, match="not a whole number of packs"):
            units_to_packs(250, 100)

    def test_rejects_a_partial_pack_just_below_a_boundary(self) -> None:
        with pytest.raises(ValueError):
            units_to_packs(299, 100)

    def test_accepts_exact_boundaries(self) -> None:
        assert units_to_packs(100, 100) == 1
        assert units_to_packs(0, 100) == 0


# ── The item carries no pack at all ───────────────────────────────────


class TestItemHasNoPack:
    """An item has ONE unit: the one it is consumed in.

    A pack describes a purchase, not a material — the same glove arrives by the
    Box from one supplier and by the Case from another, and either may re-pack
    next year. An item-level default was built and then removed: it was read
    exactly once, to pre-fill a PO line, and never again, so it could only ever
    drift out of step with the lines while looking authoritative. These tests
    pin that decision, because the natural instinct on seeing ``pack_uom`` on
    the order line is to "normalise" it back onto the item.
    """

    def test_item_create_has_no_pack_fields(self) -> None:
        assert "pack_uom" not in ItemCreate.model_fields
        assert "units_per_pack" not in ItemCreate.model_fields

    def test_item_update_has_no_pack_fields(self) -> None:
        assert "pack_uom" not in ItemUpdate.model_fields
        assert "units_per_pack" not in ItemUpdate.model_fields
        # ``clear_pack`` went with them — there is nothing left to clear.
        assert "clear_pack" not in ItemUpdate.model_fields

    def test_sending_a_pack_to_item_create_is_refused(self) -> None:
        # ``extra="forbid"`` turns a stale client into a 422 rather than a
        # silently dropped field, which is the difference between "your pack
        # was ignored" and "your pack went somewhere".
        with pytest.raises(PydanticValidationError):
            ItemCreate(
                sku_suffix="001",
                description="Pipette tips",
                prefix_id="p",
                uom="Each",
                pack_uom="Box",
                units_per_pack=100,
            )

    def test_sending_a_pack_to_item_update_is_refused(self) -> None:
        with pytest.raises(PydanticValidationError):
            ItemUpdate(pack_uom="Box", units_per_pack=100)

    def test_the_consume_unit_is_untouched(self) -> None:
        # ``uom`` is the one unit an item still has, and it must keep working.
        item = ItemCreate(
            sku_suffix="001", description="Pipette tips", prefix_id="p", uom="Each"
        )
        assert item.uom == "Each"


# ── The order line: where the pack actually lives ─────────────────────


class TestOrderLinePack:
    def test_unit_without_a_factor_is_allowed_here(self) -> None:
        # Unlike the item, a PO may be raised for "3 Box" before anyone knows
        # how many are in a box; receive requires the count and freezes it.
        line = OrderLineInput(
            item_id="i", supplier_id="s", ordered_qty=3, pack_uom="Box"
        )
        assert line.pack_uom == "Box"
        assert line.units_per_pack is None

    def test_factor_without_a_unit_is_still_rejected(self) -> None:
        with pytest.raises(PydanticValidationError, match="needs a pack_uom"):
            OrderLineInput(
                item_id="i", supplier_id="s", ordered_qty=3, units_per_pack=100
            )

    def test_no_pack_at_all_is_accepted(self) -> None:
        line = OrderLineInput(item_id="i", supplier_id="s", ordered_qty=150)
        assert line.pack_uom is None

    def test_price_is_per_order_unit(self) -> None:
        # $95.00 is the price of one Box, not of one Each. The division to a
        # per-consume-unit price happens at receive, onto the lot.
        line = OrderLineInput(
            item_id="i",
            supplier_id="s",
            ordered_qty=3,
            unit_price=Decimal("95.00"),
            pack_uom="Box",
            units_per_pack=100,
        )
        assert line.unit_price == Decimal("95.00")


# ── Bounds: the product is what lands in the ledger, not the input ────


class TestQuantityBounds:
    def test_ordered_qty_alone_is_bounded(self) -> None:
        with pytest.raises(PydanticValidationError):
            OrderLineInput(
                item_id="i", supplier_id="s", ordered_qty=MAX_QTY + 1
            )

    def test_a_legal_pack_count_can_still_exceed_the_limit_once_multiplied(
        self,
    ) -> None:
        # Both halves pass their own field bound, and the product is ten
        # million. Pydantic cannot catch this — the route checks the product,
        # which is why that guard exists there and is asserted here as the
        # reason the schema alone is not enough.
        line = OrderLineInput(
            item_id="i",
            supplier_id="s",
            ordered_qty=20_000,
            pack_uom="Box",
            units_per_pack=500,
        )
        assert packs_to_units(line.ordered_qty, line.units_per_pack) > MAX_QTY


# ── The per-unit price derivation ─────────────────────────────────────


class TestPriceDerivation:
    """The lot stores price per CONSUME unit; the order line, per pack.

    ``lots.unit_price_amount`` is multiplied by movement quantities, which are
    in consume units, so it has to be the divided figure. It is stored at six
    decimal places precisely because that division is usually not exact.
    """

    def test_exact_division(self) -> None:
        assert Decimal("95.00") / 100 == Decimal("0.95")

    def test_inexact_division_needs_more_than_two_places(self) -> None:
        per_unit = Decimal("95.00") / 3
        # Rounded to the old 2dp column, this multiplies back to 95.01 —
        # a penny invented by the storage type, on every three-pack ever
        # received. Six places keeps the round-trip within a hundredth of a
        # cent.
        assert (round(per_unit, 2) * 3) == Decimal("95.01")
        assert abs(round(per_unit, 6) * 3 - Decimal("95.00")) < Decimal("0.0001")


# ── The line's pack comes from the payload and nowhere else ───────────


class TestLinePackHasNoOtherSource:
    """With no item default, the payload is the whole answer.

    This used to be a resolver weighing the item's pack against the client's,
    where "omitted" and "explicitly null" had to mean different things. Both
    now mean the same thing — no pack — and the value written to the line is
    simply what arrived. The tests are kept as the record of an absence: if a
    default ever reappears anywhere, an omitted pack stops being ``None`` and
    these fail.
    """

    def test_omitted_means_no_pack(self) -> None:
        line = OrderLineInput(item_id="i", supplier_id="s", ordered_qty=150)
        assert "pack_uom" not in line.model_fields_set
        assert (line.pack_uom, line.units_per_pack) == (None, None)

    def test_explicit_null_means_the_same_as_omitted(self) -> None:
        line = OrderLineInput(
            item_id="i", supplier_id="s", ordered_qty=150, pack_uom=None
        )
        assert (line.pack_uom, line.units_per_pack) == (None, None)

    def test_a_unit_is_carried_without_a_factor_being_invented(self) -> None:
        # "Case" with no size stays sizeless until receive. Nothing may supply
        # a 100 from elsewhere — that would place a case as if it held a box's
        # worth, and the number would look entirely ordinary.
        line = OrderLineInput(
            item_id="i", supplier_id="s", ordered_qty=3, pack_uom="Case"
        )
        assert (line.pack_uom, line.units_per_pack) == ("Case", None)

    def test_a_full_pack_is_carried_verbatim(self) -> None:
        line = OrderLineInput(
            item_id="i",
            supplier_id="s",
            ordered_qty=3,
            pack_uom="Case",
            units_per_pack=500,
        )
        assert (line.pack_uom, line.units_per_pack) == ("Case", 500)
