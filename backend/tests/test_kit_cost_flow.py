"""Material cost flows through kitting to the finished lot (RPT-003).

    "Cost shall flow through kitting: issued quantities carry their lot cost, so
    a closed kit can be costed (materials only)."
    — CellReady SRS Consolidated Amendment 9+10 (Aug 13, 2026)

    "The FG Lot-xxx should pull through all the costs. The Kit should capture
    the costs to that specific Lot — so the process scrap or material scrap and
    actual material costs are put to the Kit and the Kit is closed out to the FG
    Lot specifically so the Customer can be charged the actual cost for that
    particular FG Lot."
    — Blane Larson, 2026-08-27

These are the arithmetic guards. They exercise ``app/kitting/costing.py``
directly — no database, no HTTP — because the rules that matter here are rules
about numbers, and a test that has to build a kit to check a division is a test
nobody runs.

The properties under guard, in the order they are easiest to break:

  * **The divisor is good units alone.** This is the entire mechanism by which
    the customer is charged for scrap. Changing it to ``good + scrap`` looks
    like a bug fix — "we made 5 units, divide by 5" — and quietly moves the
    scrap loss from the customer's invoice onto CellReady's books.
  * **Scrap is a slice, never an addend.** ``$100 + $200 + $150 + $50 scrap``
    is the intuitive reading and it double-charges, because the scrapped
    material was already charged at issue.
  * **Returns reduce cost.** A naive ``charged / issued`` passes almost every
    test that does not involve a return, and is wrong on every kit that does.
  * **Unknown is not zero, and zero is not unknown.** An unpriced lot must
    blank the whole batch; a $0 lot — which is what the customer-owned cells on
    a 0$ PO actually cost — must flow through as a real zero.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from app.core.exceptions import ValidationError
from app.kitting import costing

# ── The divisor: how scrap reaches the customer ─────────────────────────


def test_unit_cost_divides_by_good_units_only():
    """5 attempted, 4 good, $450 of material → $112.50, not $90.

    The client's requirement in one assertion. At $112.50 the customer pays the
    whole $450 and the scrapped unit's material is recovered; at $90 they pay
    $360 and CellReady eats $90. Nothing else in the system encodes that choice.
    """
    assert costing.output_unit_cost(Decimal("450"), good_qty=4) == Decimal("112.500000")


def test_dividing_by_attempted_units_would_undercharge():
    """The wrong divisor, stated explicitly so the difference is legible."""
    right = costing.output_unit_cost(Decimal("450"), good_qty=4)
    wrong = costing.output_unit_cost(Decimal("450"), good_qty=5)
    assert right > wrong
    assert right * 4 == Decimal("450")
    # The naive version recovers only $360 of $450 spent.
    assert wrong * 4 == Decimal("360")


def test_scrap_only_batch_has_no_unit_price():
    """good_qty 0 is reachable (CloseOutRequest allows it) and mints no lot."""
    assert costing.output_unit_cost(Decimal("450"), good_qty=0) is None


# ── Scrap is a slice of the total, not an addition to it ────────────────


def test_scrap_value_is_the_material_share_of_the_failed_units():
    """5 attempted, 1 scrapped → a fifth of the material, $90 of $450.

    Prorated over units ATTEMPTED. The tempting alternative,
    ``scrap_qty × output_unit_cost``, double-applies the absorption: that price
    is ``material ÷ good``, so it already carries the scrap.
    """
    material = Decimal("450")
    scrap = costing.scrap_value(material, good_qty=4, scrap_qty=1)
    assert scrap == Decimal("90")
    # The property the DB CHECK enforces — a share, never an excess.
    assert scrap < material


def test_scrap_value_never_exceeds_the_batch_cost():
    """The regression guard: this used to crash produce, not just misreport.

    Under ``scrap_qty × unit_cost`` a batch with more scrap than good produced a
    figure LARGER than the whole batch, which trips
    ``ck_kit_production_batches_scrap_is_slice`` and 500s the request. Every mix
    must stay inside the total.
    """
    material = Decimal("100")
    for good, scrap in ((4, 1), (2, 2), (1, 3), (0, 4), (10, 0)):
        value = costing.scrap_value(material, good_qty=good, scrap_qty=scrap)
        assert value is not None
        assert Decimal("0") <= value <= material, f"good={good} scrap={scrap}"


def test_equal_good_and_scrap_splits_the_material_in_half():
    """The case in the screenshot that exposed the old formula.

    2 good and 2 scrapped is half the material lost — not all of it, which is
    what the old definition reported.
    """
    assert costing.scrap_value(Decimal("6.741332"), good_qty=2, scrap_qty=2) == Decimal(
        "3.370666"
    )


def test_an_all_scrapped_batch_loses_the_whole_cost():
    assert costing.scrap_value(Decimal("450"), good_qty=0, scrap_qty=3) == Decimal("450")


def test_adding_scrap_as_a_fourth_line_would_overcharge():
    """The intuitive-but-wrong model, pinned so nobody re-derives it.

    $100 + $200 + $150 of components, one unit of five scrapped. Treating scrap
    as its own addend bills $540 for $450 of material.
    """
    components = [Decimal("100"), Decimal("200"), Decimal("150")]
    material, complete = costing.batch_cost(list(components))
    assert (material, complete) == (Decimal("450"), True)
    naive_total = material + costing.scrap_value(material, good_qty=4, scrap_qty=1)
    assert naive_total == Decimal("540")
    assert naive_total > material  # the double count, made visible


def test_no_scrap_means_zero_scrap_value_not_none():
    """Zero scrap is a known fact, not a missing one."""
    assert costing.scrap_value(Decimal("450"), good_qty=4, scrap_qty=0) == Decimal("0")


def test_scrap_value_of_an_uncosted_batch_is_unknown():
    assert costing.scrap_value(None, good_qty=2, scrap_qty=2) is None


# ── The moving average ──────────────────────────────────────────────────


def test_single_lot_line_costs_what_it_was_charged():
    unit = costing.line_unit_cost(
        charged=Decimal("100"), credited=Decimal("0"), consumed=Decimal("0"), residual_qty=100
    )
    assert unit == Decimal("1")


def test_mixed_price_line_averages_over_what_remains():
    """100 @ $1 plus 100 @ $3 held on the floor → $2.00 a unit."""
    unit = costing.line_unit_cost(
        charged=Decimal("400"), credited=Decimal("0"), consumed=Decimal("0"), residual_qty=200
    )
    assert unit == Decimal("2")


def test_second_batch_does_not_respend_the_first_batch_value():
    """The `consumed` term. Batch 1 took 50 units' worth away with it.

    Without this subtraction the line's remaining $200 would be spread over the
    50 units still on the floor at $4 each — double the true figure — and the
    second finished lot would be billed at twice its cost.
    """
    unit = costing.line_unit_cost(
        charged=Decimal("400"),
        credited=Decimal("0"),
        consumed=Decimal("100"),  # batch 1 consumed 50 @ $2
        residual_qty=150,
    )
    assert unit == Decimal("2")


def test_returns_reduce_the_cost():
    """The discriminating case: `charged / issued` gets this wrong.

    Issue 50 @ $1 and 50 @ $3 ($200 charged), hand back the 50 @ $3 ($150
    credited), then produce from the 50 that remain. The line is worth $50, so
    $1 a unit. A naive charged-over-issued reads $200/100 = $2 and doubles the
    customer's bill.
    """
    unit = costing.line_unit_cost(
        charged=Decimal("200"), credited=Decimal("150"), consumed=Decimal("0"), residual_qty=50
    )
    assert unit == Decimal("1")
    naive = Decimal("200") / Decimal("100")
    assert naive == Decimal("2")
    assert unit != naive


def test_value_identity_holds_across_batches():
    """`Σ batch values + residual == charged − credited`, exactly.

    The value identity mirrors the quantity identity close-out already enforces.
    If it stops holding, cost is leaking or being invented somewhere.
    """
    charged, credited = Decimal("400"), Decimal("0")
    residual, consumed = 200, Decimal("0")

    unit1 = costing.line_unit_cost(
        charged=charged, credited=credited, consumed=consumed, residual_qty=residual
    )
    batch1 = costing.line_extended_value(unit1, 50)
    consumed += batch1
    residual -= 50

    unit2 = costing.line_unit_cost(
        charged=charged, credited=credited, consumed=consumed, residual_qty=residual
    )
    batch2 = costing.line_extended_value(unit2, 150)

    assert batch1 + batch2 == charged - credited


def test_spent_line_yields_no_cost_rather_than_dividing_by_zero():
    assert (
        costing.line_unit_cost(
            charged=Decimal("100"), credited=Decimal("0"), consumed=Decimal("100"), residual_qty=0
        )
        is None
    )


def test_negative_residual_clamps_instead_of_crediting():
    """A lot price edited down between issue and return can overshoot.

    Clamping at zero is deliberate: a negative unit cost would surface on an
    invoice as a credit the customer never earned.
    """
    unit = costing.line_unit_cost(
        charged=Decimal("100"), credited=Decimal("150"), consumed=Decimal("0"), residual_qty=10
    )
    assert unit == Decimal("0")


# ── Unknown vs zero ─────────────────────────────────────────────────────


def test_unpriced_input_makes_the_line_unknown():
    assert (
        costing.line_unit_cost(
            charged=None, credited=Decimal("0"), consumed=Decimal("0"), residual_qty=100
        )
        is None
    )


def test_one_unknown_component_blanks_the_whole_batch():
    """Not a partial sum. A partial cost reads as a complete one."""
    material, complete = costing.batch_cost([Decimal("100"), None, Decimal("150")])
    assert material is None
    assert complete is False


def test_unknown_batch_cost_leaves_the_lot_unpriced():
    assert costing.output_unit_cost(None, good_qty=4) is None


def test_zero_is_a_real_price_not_an_unknown():
    """The J&J case: customer-owned cells arrive on a 0$ PO.

    $0 is a known price and must produce a costed batch, not a blank one. This
    is the distinction RPT-001 draws for the finance export and it holds here:
    blank means "no price recorded", zero means "this cost nothing".
    """
    unit = costing.line_unit_cost(
        charged=Decimal("0"), credited=Decimal("0"), consumed=Decimal("0"), residual_qty=10
    )
    assert unit == Decimal("0")
    material, complete = costing.batch_cost([Decimal("0")])
    assert material == Decimal("0")
    assert complete is True
    assert costing.output_unit_cost(material, good_qty=4) == Decimal("0")


def test_a_free_input_alongside_a_priced_one_still_costs():
    """$0 cells plus $450 of reagents is a $450 kit, not an unknown one."""
    material, complete = costing.batch_cost([Decimal("0"), Decimal("450")])
    assert (material, complete) == (Decimal("450"), True)


def test_empty_batch_is_a_complete_zero():
    assert costing.batch_cost([]) == (Decimal("0"), True)


# ── Sub-assembly roll-up ────────────────────────────────────────────────


def test_sub_assembly_price_flows_into_the_next_kit():
    """Kit 1 mints an AY at $112.50; kit 2 consumes it at that price.

    No recursion is involved and that is the point — the roll-up happened once,
    when kit 1 stamped the price onto the lot. Kit 2 sees an ordinary priced lot
    and the same charge sum picks it up. Before RPT-003 the AY was unpriced and
    this contributed $0, silently.
    """
    ay_unit_price = costing.output_unit_cost(Decimal("450"), good_qty=4)
    assert ay_unit_price == Decimal("112.500000")

    # Kit 2 issues 2 of those AY units plus $100 of reagents.
    ay_line = costing.line_unit_cost(
        charged=ay_unit_price * 2, credited=Decimal("0"), consumed=Decimal("0"), residual_qty=2
    )
    material, complete = costing.batch_cost(
        [costing.line_extended_value(ay_line, 2), Decimal("100")]
    )
    assert complete is True
    assert material == Decimal("325")  # 2 x 112.50 + 100


def test_unpriced_sub_assembly_blanks_the_finished_good():
    """A pre-kitcost01 AY lot has no price, so the FG it feeds has no cost.

    Honest rather than convenient: the alternative is inventing a number for a
    lot that may already have been billed.
    """
    material, complete = costing.batch_cost([None, Decimal("100")])
    assert material is None and complete is False


# ── Bounds ──────────────────────────────────────────────────────────────


def test_unit_cost_quantizes_to_the_lot_price_scale():
    """6dp, matching lots.unit_price_amount, so a stamped cost round-trips."""
    unit = costing.output_unit_cost(Decimal("1"), good_qty=3)
    assert unit == Decimal("0.333333")


def test_overflow_raises_a_clean_error_not_a_database_failure():
    """One expensive cell line and a good_qty of 1 can exceed MAX_MONEY.

    Caught at the edge so the operator gets a sentence, not a 500 from the end
    of the request.
    """
    with pytest.raises(ValidationError) as excinfo:
        costing.output_unit_cost(Decimal("999999999"), good_qty=1)
    assert excinfo.value.code == "cost_exceeds_max"
