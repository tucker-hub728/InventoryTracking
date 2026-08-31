"""Material cost arithmetic for kits — RPT-003.

Pure functions, no database. Everything here takes numbers and returns numbers
so the rules can be tested exhaustively without building a kit; the queries that
feed them live in ``app/kitting/repository.py`` and the wiring in
``app/kitting/routes.py``.

## What cost means here

    "Cost shall flow through kitting: issued quantities carry their lot cost, so
    a closed kit can be costed (materials only)."
    — SRS Consolidated Amendment 9+10

    "The FG Lot-xxx should pull through all the costs... so the Customer can be
    charged the actual cost for that particular FG Lot."
    — Blane Larson, 2026-08-27

Materials only. No labour, no overhead, no machine time (phase one, explicit in
the requirement).

## Why a moving average, and not "what the drain consumed"

The obvious implementation is to have ``_drain_production`` report which lots it
drew down and price those. It is wrong, and quietly so.
``allocations_for_item_at_node`` filters by item and node with **no kit filter**
— its own docstring talks about "two kits that merely share an item" — because
material is never bound to a kit (TRX-002). So on a shared production floor, kit
A's produce can drain kit B's lot and stamp B's price onto A's finished good.
Nothing errors; the invoice is just wrong.

So cost is never read off the floor. It is derived from the kit's **own**
movement rows, which carry ``kit_id`` and ``kit_line_id`` and are therefore
exact per kit, per component:

    unit_cost_L = (charged_L − credited_L − consumed_L) / residual_qty_L

A moving weighted average over what the line still holds. Three properties make
it the right shape:

* **Exact in aggregate.** ``Σ batch values + residual == charged − credited``.
  The value identity mirrors the quantity identity close-out already enforces
  (``issued + additional == used + early_returned + backflushed``).
* **Decomposable per batch**, which is the whole point — a kit can mint several
  finished lots and each is billed separately.
* **Agrees exactly** with the drain-based answer whenever a line drew from one
  lot, or all its lots share a price. That is the overwhelmingly common case;
  the two only diverge on a mixed-price line, where the average is the defensible
  answer and the floor read is a coin flip.

## Scrap

Included, and it is a **slice, not an addend**. Scrapped material was charged at
issue and never credited back, so its value is already inside
``batch_material_cost``. What charges it to the customer is
``output_unit_cost`` dividing by good units alone — see that function.
``scrap_value`` then reports the portion for visibility.

## Unknown is not zero

If any lot feeding a line has no price, that line's cost is unknown, and the
unknown propagates: the batch cost is ``None``, the minted lot is left unpriced,
and ``cost_is_complete`` is false. A partial sum would read as a complete one,
which for a billing artefact is the worst available outcome. This is RPT-001's
blank-is-never-zero rule applied one level up. ``$0`` is a different thing
entirely — a real, known price, which is what the customer-owned cells arriving
on a 0$ PO actually cost — and it flows through as ``Decimal("0")``.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from app.core.bounds import MAX_MONEY
from app.core.exceptions import ValidationError

#: Money scale for per-unit figures. Matches ``lots.unit_price_amount``
#: (NUMERIC(14, 6)) so a stamped cost round-trips through the lot unchanged.
UNIT_COST_EXP = Decimal("0.000001")

#: Movement types that put material ON the floor at the kit's expense.
CHARGE_MOVEMENT_TYPES: tuple[str, ...] = ("kit_issue", "kit_additional_issue")

#: Movement types that hand material BACK to inventory, crediting the kit.
#: All three are physically identical and differ only in what they mean
#: (kitting05): the signed close-out reconciliation, a mid-production return
#: (TRX-008), and the post-issue cancel.
CREDIT_MOVEMENT_TYPES: tuple[str, ...] = ("backflush", "kit_return", "kit_cancel_return")

#: How a return is valued: at the returned lot's own price, read straight from
#: the ledger.
#:
#: The alternative — crediting at the line's moving average at the moment of
#: return — is arguably more correct, because the close-out back-flush drains
#: the same unfiltered shared floor the consume does, so a kit can hand back a
#: lot it never issued and be refunded at a price it was never charged. But that
#: valuation is not derivable after the fact: it would have to be computed and
#: **stored on every return**, in three separate endpoints, to avoid being
#: re-derived later against edited lot prices.
#:
#: Lot-price credits need no extra storage and are directly auditable — "we
#: credited LOT-B back at $3" is a sentence someone can check. The two policies
#: agree exactly whenever a line drew from one lot or all its lots share a
#: price, which is the overwhelmingly common case; they diverge only on a
#: mixed-price line with a lot-specific return, and ``line_unit_cost`` clamps
#: the pathological end of that at zero rather than emitting a negative cost.
#:
#: Named rather than inlined so the client's answer, if it differs, has one
#: place to land. Raise it with them once they see real numbers.
CREDIT_AT_LOT_PRICE = True


def line_unit_cost(
    *,
    charged: Decimal | None,
    credited: Decimal,
    consumed: Decimal,
    residual_qty: int,
) -> Decimal | None:
    """The per-unit value of what a kit line still holds on the floor.

    ``charged`` is ``None`` when any lot issued to this line has no price — the
    unknown swallows the line, rather than the priced part of it standing in for
    the whole. ``residual_qty`` of 0 means the line is spent: there is nothing
    left to value, which is not an error, so the caller gets ``None`` and simply
    attributes nothing.

    Returns an unrounded Decimal. Quantisation happens once, at the point the
    figure becomes a stored per-unit price (``output_unit_cost``), so that
    per-line rounding does not accumulate across a wide BOM.
    """
    if charged is None:
        return None
    if residual_qty <= 0:
        return None
    remaining_value = charged - credited - consumed
    # Clamp at zero rather than raising. Returns are valued at the moving
    # average, so the identity holds exactly; but a lot price edited downward
    # *between* an issue and its return can still drive the residual slightly
    # negative, and a negative unit cost would turn into a credit on an invoice.
    if remaining_value < 0:
        remaining_value = Decimal("0")
    return remaining_value / Decimal(residual_qty)


def line_extended_value(unit_cost: Decimal | None, qty: int) -> Decimal | None:
    """Value of ``qty`` units drawn from a line at ``unit_cost``."""
    if unit_cost is None:
        return None
    return unit_cost * Decimal(qty)


def batch_cost(line_values: list[Decimal | None]) -> tuple[Decimal | None, bool]:
    """Total material value of one batch, and whether that total is complete.

    A single ``None`` among the components makes the whole batch unknown. That
    is the intended severity: a finished good is not partially costed, it is
    either costed or it is not.

    Returns ``(cost, cost_is_complete)``. An empty batch — no line consumed
    anything — is a complete cost of zero, not an unknown one.
    """
    if any(v is None for v in line_values):
        return None, False
    total = sum((v for v in line_values if v is not None), Decimal("0"))
    return total, True


def output_unit_cost(material_cost: Decimal | None, good_qty: int) -> Decimal | None:
    """What one good finished unit cost — the figure stamped onto the lot.

    **Divides by good units alone.** This is the mechanism by which scrap is
    charged to the customer, and it is the whole of the client's "the Customer
    can be charged the actual cost for that particular FG Lot": $450 of material
    yielding 4 good and 1 scrapped comes out at $112.50 a unit, so all $450 is
    recovered. Dividing by ``good_qty + scrap_qty`` would price the units at $90
    and leave CellReady holding the $90 loss.

    ``good_qty`` of 0 is a real case — a final close-out that scrapped
    everything — and mints no lot, so there is no per-unit price to compute.
    """
    if material_cost is None or good_qty <= 0:
        return None
    unit = material_cost / Decimal(good_qty)
    return quantize_unit_cost(unit)


def scrap_value(
    material_cost: Decimal | None, good_qty: int, scrap_qty: int
) -> Decimal | None:
    """How much of a batch's material went into units that failed.

    Prorated over units **attempted**::

        material_cost × scrap_qty / (good_qty + scrap_qty)

    Not ``scrap_qty × output_unit_cost``, which was the first cut and was wrong
    twice over. That price is ``material ÷ good``, i.e. it already carries the
    scrap; multiplying it back out by the scrap count double-applies the
    absorption. With ``good == scrap`` it reports the *entire* batch cost as
    scrap, and with ``scrap > good`` it exceeds the batch total outright and
    trips ``ck_kit_production_batches_scrap_is_slice`` — a 500 on produce, not a
    wrong number on a screen.

    This definition is always ``<= material_cost`` by construction: it is a
    share of it, which is exactly what the constraint asserts and what "of
    which" means on the screen. All-scrapped (``good_qty == 0``) correctly
    returns the whole cost — every unit of material went into something that
    failed.

    It is reported, never added. The material behind these units was charged at
    issue and is already inside ``material_cost``; what recovers it from the
    customer is ``output_unit_cost`` dividing by good units alone.
    """
    if material_cost is None:
        return None
    attempted = good_qty + scrap_qty
    if attempted <= 0 or scrap_qty <= 0:
        return Decimal("0")
    return material_cost * Decimal(scrap_qty) / Decimal(attempted)


def quantize_unit_cost(value: Decimal) -> Decimal:
    """Round a per-unit figure to the scale ``lots.unit_price_amount`` stores.

    Raises rather than letting Postgres throw a ``DataError`` at flush time: an
    overflow here is a real condition (one expensive cell line, ``good_qty`` of
    1) and the operator deserves a sentence about it rather than a 500 from the
    end of the request.
    """
    quantized = value.quantize(UNIT_COST_EXP, rounding=ROUND_HALF_UP)
    if quantized > MAX_MONEY:
        raise ValidationError(
            f"The computed unit cost ({quantized}) exceeds the maximum this system "
            f"can record ({MAX_MONEY}). Check the input lot prices.",
            code="cost_exceeds_max",
        )
    return quantized
