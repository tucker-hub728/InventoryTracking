"""Lot control — required, skipped, or synthesized (REQ-003).

"Shall require lot number where the item is lot-controlled; lot may be
skipped/synthesized for non-lot items."

Two things carry the feature, and both are tested here rather than through
HTTP because the thing under test is the rule, not the transport:

  * ``lot_number`` is optional at the schema layer and conditionally required
    at the route, because the rule depends on the ITEM behind the line — which
    the payload does not carry. A schema that made it required would make the
    non-lot case unreachable; one that made blank *invalid* would 422 before
    the route could decide whether blank mattered.
  * A synthesized number is told apart from a vendor's by its ``AUTO-`` prefix,
    for the rest of its life, in every screen and export. That only holds if
    nothing else can produce one — hence the reserved-prefix rule, tested here
    and enforced at the one door that writes lot numbers on receipt.

The end-to-end rules (422 without a lot on a controlled item, a generated
number on an uncontrolled one, the 409 when switching control off over
existing stock) live in ``smoke_lot_control.py``, which needs a live API.
"""

from __future__ import annotations

import pytest
from app.inventory.repository import (
    SYNTHETIC_LOT_PREFIX,
    is_synthetic_lot_number,
    uses_reserved_lot_prefix,
)
from app.inventory.schemas import ItemCreate, ItemUpdate, ReceiveEventLineInput
from pydantic import ValidationError as PydanticValidationError


def _line(**kw) -> ReceiveEventLineInput:
    """A receive line with the required non-lot fields already filled."""
    base = {
        "line_id": "l1",
        "qty_received": 1,
        "placement": {"node_id": "n1", "cells": []},
    }
    return ReceiveEventLineInput(**{**base, **kw})


# ── The item flag ─────────────────────────────────────────────────────


class TestItemLotControlFlag:
    def test_defaults_to_lot_controlled(self) -> None:
        # Requiring a lot number is the status quo, so an item created by a
        # client that has never heard of REQ-003 keeps today's behaviour. The
        # migration's server_default makes the same promise for existing rows.
        item = ItemCreate(sku_suffix="001", description="x", prefix_id="p")
        assert item.is_lot_controlled is True

    def test_can_be_turned_off_explicitly(self) -> None:
        item = ItemCreate(
            sku_suffix="001", description="x", prefix_id="p", is_lot_controlled=False
        )
        assert item.is_lot_controlled is False

    def test_is_independent_of_is_consumable(self) -> None:
        # The two were nearly collapsed into one flag. They are not the same
        # fact: consumable is how material LEAVES stock, lot control is how it
        # is traced while IN stock. A consumable that still needs a traceable
        # lot for a deviation investigation must remain expressible.
        item = ItemCreate(
            sku_suffix="001",
            description="reagent",
            prefix_id="p",
            is_consumable=True,
            is_lot_controlled=True,
        )
        assert (item.is_consumable, item.is_lot_controlled) == (True, True)

    def test_patch_omits_it_unless_sent(self) -> None:
        # An unrelated PATCH must not silently restate a traceability control.
        patch = ItemUpdate(description="x")
        assert "is_lot_controlled" not in patch.model_dump(exclude_unset=True)

    def test_patch_carries_an_explicit_false(self) -> None:
        patch = ItemUpdate(is_lot_controlled=False)
        assert patch.model_dump(exclude_unset=True) == {"is_lot_controlled": False}


# ── The lot number on a receive line ──────────────────────────────────


class TestReceiveLineLotNumber:
    def test_may_be_omitted(self) -> None:
        # The whole point: a non-lot item is received without one. If this
        # field were required the feature would be unreachable.
        assert _line().lot_number is None

    def test_blank_becomes_none_rather_than_a_422(self) -> None:
        # A UI that always sends the field must not have to special-case "".
        # Rejecting blank here would also fire before the route can decide
        # whether blank was allowed for this item.
        assert _line(lot_number="").lot_number is None
        assert _line(lot_number="   ").lot_number is None

    def test_a_real_value_is_trimmed_and_kept(self) -> None:
        assert _line(lot_number="  L-001  ").lot_number == "L-001"

    def test_over_long_is_still_rejected(self) -> None:
        # Optional is not unbounded — the column is 64 chars.
        with pytest.raises(PydanticValidationError):
            _line(lot_number="L" * 65)


# ── Telling a generated number from a supplier's ──────────────────────


class TestSyntheticLotNumbers:
    def test_recognises_the_generated_prefix(self) -> None:
        assert is_synthetic_lot_number(f"{SYNTHETIC_LOT_PREFIX}20260821-1")

    def test_a_vendor_lot_is_not_synthetic(self) -> None:
        for real in ("L-20260821-A", "VENDOR-4471", "20260821", "auto-1"):
            assert not is_synthetic_lot_number(real), real

    def test_none_and_empty_are_not_synthetic(self) -> None:
        # Called on lot numbers straight off the wire, which may be absent.
        assert not is_synthetic_lot_number(None)
        assert not is_synthetic_lot_number("")

    def test_the_classifier_is_case_sensitive_by_design(self) -> None:
        # Classifying STORED data: only the exact prefix the generator emits
        # counts, so a vendor lot that happens to read "auto-1" is not
        # mislabelled in the UI as machine-generated.
        assert not is_synthetic_lot_number("auto-20260821-1")


class TestReservedPrefixGuard:
    """The input door is stricter than the classifier, on purpose.

    Writing this pair out separately caught a real inconsistency: the frontend
    rejected "auto-…" case-insensitively while the server accepted it, so a
    lower-case spelling would have slipped past into stock. The uniqueness
    index is case-sensitive, so both spellings could then coexist and read
    identically on a printed label.
    """

    def test_rejects_the_exact_generated_prefix(self) -> None:
        assert uses_reserved_lot_prefix("AUTO-20260821-1")

    def test_rejects_any_casing(self) -> None:
        for spelling in ("auto-1", "Auto-1", "aUtO-20260821-4"):
            assert uses_reserved_lot_prefix(spelling), spelling

    def test_allows_a_real_vendor_lot(self) -> None:
        for real in ("L-20260821-A", "VENDOR-4471", "AUTOMATION-7", "AUT-1"):
            assert not uses_reserved_lot_prefix(real), real

    def test_absent_input_is_not_reserved(self) -> None:
        # Called before the required/synthesize decision, so it sees None.
        assert not uses_reserved_lot_prefix(None)
        assert not uses_reserved_lot_prefix("")

    def test_the_prefix_is_the_documented_one(self) -> None:
        # The frontend mirrors this constant by hand (receive-dialog.tsx).
        # If it changes here, that copy has to change too.
        assert SYNTHETIC_LOT_PREFIX == "AUTO-"
