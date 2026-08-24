"""Lot numbers — always optional, synthesized when absent (REQ-003).

The written requirement says "shall require lot number where the item is
lot-controlled; lot may be skipped/synthesized for non-lot items", which reads
as a per-item rule. The client settled it on 2026-08-21: **any** item may be
received without a lot number. So there is no lot-controlled category, no
per-item flag, and no case where receiving refuses a blank one.

What is left is two rules, both tested here rather than through HTTP because
the thing under test is the rule, not the transport:

  * ``lot_number`` is optional everywhere, and blank means absent rather than
    invalid — a form that always sends the field must not have to omit the key
    to mean "nothing".
  * A synthesized number is told apart from a vendor's by its ``AUTO-`` prefix,
    for the rest of its life, in every screen and export. That only holds if
    nothing else can produce one — hence the reserved-prefix rule, enforced at
    the one door that writes lot numbers on receipt.

The end-to-end behaviour (a blank lot producing ``AUTO-YYYYMMDD-N``, two blanks
producing distinct numbers, a typed ``AUTO-`` being refused) lives in
``smoke_tiered_uom.py``, which needs a live API.
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


# ── No item-level lot flag ────────────────────────────────────────────


class TestNoItemLotFlag:
    """There is deliberately no per-item lot-control setting.

    One was built and removed. The client confirmed on 2026-08-21 that ANY
    item may be received without a lot number, which leaves nothing for a
    per-item flag to decide — a switch whose two positions behave identically
    is worse than no switch, because it implies a control that is not there.

    Asserted rather than merely deleted: the flag reaching the schema again
    would silently re-introduce a rule the client explicitly rejected.
    """

    def test_item_create_rejects_a_lot_control_flag(self) -> None:
        # ItemCreate forbids extra fields, so this is a 422 rather than a
        # value that is quietly ignored.
        with pytest.raises(PydanticValidationError):
            ItemCreate(
                sku_suffix="001",
                description="x",
                prefix_id="p",
                is_lot_controlled=True,
            )

    def test_item_update_rejects_it_too(self) -> None:
        with pytest.raises(PydanticValidationError):
            ItemUpdate(is_lot_controlled=False)

    def test_a_plain_item_still_creates(self) -> None:
        item = ItemCreate(sku_suffix="001", description="x", prefix_id="p")
        assert not hasattr(item, "is_lot_controlled")


# ── The lot number on a receive line ──────────────────────────────────


class TestReceiveLineLotNumber:
    def test_may_be_omitted(self) -> None:
        # The whole point: any item can be received without one. If this field
        # were required the feature would be unreachable.
        assert _line().lot_number is None

    def test_blank_becomes_none_rather_than_a_422(self) -> None:
        # A UI that always sends the field must not have to special-case "".
        # Blank and missing mean the same thing here — generate one.
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
