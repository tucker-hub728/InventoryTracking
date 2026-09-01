"""Re-cost a kit after an input lot's price is corrected — RPT-003.

    "when i update the price from the edit lot will it effect the price of the
    AY/FG which is already produce … it should be"
    — client, 2026-08-31

It didn't, and that was the wrong answer. A lot price is editable
(``apply_lot_patch``), and until this module existed the edit changed nothing
downstream: the produced lot's ``unit_price_amount`` was a literal stamped at
produce time, and the batch tables held their own frozen copies. So correcting a
typo left the kit page's live "Material cost" disagreeing with the per-lot table
directly beneath it — one figure re-read prices, the others did not.

Now a price edit re-costs every kit that consumed that lot, re-stamps the lots
those kits produced, and follows those lots into any kit that consumed *them*.
One price, everywhere, always current.

## Why this is a replay and not a multiply

Cost is a **moving weighted average** over what a kit line still holds, so each
batch's unit cost depends on what earlier batches already carried away. You
cannot scale a stored figure by the price delta; you have to run the batches
again, in order. Everything that needs is already recorded:

* the charge/credit movements, which carry the **current** lot prices;
* each batch's per-line ``qty`` (``kit_batch_consumptions``);
* each batch's ``good_qty``.

So the replay is deterministic — the same inputs that produced the original
numbers, with one price changed.

## What it deliberately does not do

**It does not re-derive quantities.** Only money is recomputed. If a replay ever
disagreed with the stored quantities that would be a bug in the ledger, not
something to paper over here.

**It does not touch a kit that consumed nothing.** A kit with no batches has no
cost to correct.

## The consequence the client accepted

A lot that has already shipped can change price. That is inherent to
corrections propagating — a figure cannot be both live and immutable — and it
is why every recompute writes an audit row naming the lot that triggered it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.kitting import costing
from app.kitting import repository as kit_repo


@dataclass
class RecomputeResult:
    """What a recompute changed, for the audit row and the API response."""

    kits_visited: int = 0
    batches_updated: int = 0
    #: ``{lot_number: (old_price, new_price)}`` for every produced lot whose
    #: stamped price actually moved. Empty when the edit changed no output.
    lots_repriced: dict[str, tuple[Decimal | None, Decimal | None]] = field(
        default_factory=dict
    )
    #: Ids of the lots in ``lots_repriced``, for the cascade to follow. Kept
    #: apart from the audit-facing dict, which is keyed by lot number so the
    #: recorded row reads as something a person can look up.
    _repriced_lot_ids: list[uuid.UUID] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.lots_repriced) or self.batches_updated > 0


async def recompute_kits_for_lot(
    session: AsyncSession,
    *,
    lot_id: uuid.UUID,
    _seen: set[uuid.UUID] | None = None,
) -> RecomputeResult:
    """Re-cost every kit that consumed ``lot_id``, then follow their output.

    The cascade is what makes a sub-assembly correction reach the finished good
    built from it. It terminates because a kit cannot consume its own output —
    the BOM is acyclic — and ``_seen`` guards the case anyway, because a cycle
    would be an infinite loop rather than a wrong number.
    """
    seen = _seen if _seen is not None else set()
    result = RecomputeResult()

    for kit_id in await kit_repo.kits_that_consumed_lot(session, lot_id):
        if kit_id in seen:
            continue
        seen.add(kit_id)
        one = await recompute_kit(session, kit_id=kit_id)
        result.kits_visited += 1 + one.kits_visited
        result.batches_updated += one.batches_updated
        result.lots_repriced.update(one.lots_repriced)

        # Follow every output lot whose price moved into the kits that consumed
        # it. Only repriced lots — an unchanged lot changes nothing downstream.
        for repriced_lot_id in one._repriced_lot_ids:
            deeper = await recompute_kits_for_lot(
                session, lot_id=repriced_lot_id, _seen=seen
            )
            result.kits_visited += deeper.kits_visited
            result.batches_updated += deeper.batches_updated
            result.lots_repriced.update(deeper.lots_repriced)

    return result


async def recompute_kit(session: AsyncSession, *, kit_id: uuid.UUID) -> RecomputeResult:
    """Replay one kit's batches at today's lot prices and re-stamp its lots.

    Batches run in ``batch_no`` order — the order they actually happened — with
    charges and credits taken **as of each batch's own timestamp**, so a return
    made between batch 2 and batch 3 lands where it did originally. Replaying
    against the kit's final totals instead would move value into batches that
    had not seen it yet.
    """
    result = RecomputeResult()
    batches = await kit_repo.batches_for_kit(session, kit_id)
    if not batches:
        return result

    flows = await kit_repo.kit_movement_flows(session, kit_id)
    lines = await kit_repo.line_ids_for_kit(session, kit_id)

    # Value and quantity already carried away by earlier batches, per line.
    consumed_value: dict[uuid.UUID, Decimal] = dict.fromkeys(lines, Decimal("0"))
    consumed_qty: dict[uuid.UUID, int] = dict.fromkeys(lines, 0)

    for batch in batches:
        line_values: list[Decimal | None] = []
        for c in sorted(batch.consumptions, key=lambda c: str(c.kit_line_id)):
            charged, credited, charged_qty, credited_qty, unpriced = _flows_as_of(
                flows, c.kit_line_id, batch.produced_at
            )
            residual = charged_qty - credited_qty - consumed_qty[c.kit_line_id]
            unit = costing.line_unit_cost(
                charged=None if unpriced else charged,
                credited=credited,
                consumed=consumed_value[c.kit_line_id],
                residual_qty=residual,
            )
            extended = costing.line_extended_value(unit, c.qty)
            c.unit_cost_amount = unit
            c.extended_value_amount = extended
            c.cost_is_complete = extended is not None
            if extended is not None:
                consumed_value[c.kit_line_id] += extended
            consumed_qty[c.kit_line_id] += c.qty
            line_values.append(extended)

        material, complete = costing.batch_cost(line_values)
        unit_cost = costing.output_unit_cost(material, batch.good_qty)
        batch.material_cost_amount = material
        batch.unit_cost_amount = unit_cost
        batch.cost_is_complete = complete
        result.batches_updated += 1

        if batch.output_lot_id is not None:
            lot = await kit_repo.get_lot_for_update(session, batch.output_lot_id)
            if lot is not None and lot.unit_price_amount != unit_cost:
                result.lots_repriced[lot.lot_number] = (lot.unit_price_amount, unit_cost)
                result._repriced_lot_ids.append(lot.id)
                lot.unit_price_amount = unit_cost

    await session.flush()
    return result


def _flows_as_of(
    flows: list[tuple[uuid.UUID, datetime, str, int, Decimal | None]],
    line_id: uuid.UUID,
    at: datetime,
) -> tuple[Decimal, Decimal, int, int, bool]:
    """Charges and credits for one line up to ``at``, in money and in units.

    ``<=`` rather than ``<``: a produce and the issue that fed it can share a
    timestamp to the microsecond on a fast machine, and the material was there.

    Returns ``(charged, credited, charged_qty, credited_qty, any_unpriced)``.
    ``any_unpriced`` covers only CHARGES — an unpriced return cannot make a
    line unknown, because the material was priced on its way in.
    """
    charged = credited = Decimal("0")
    charged_qty = credited_qty = 0
    unpriced = False
    for flow_line, when, mv_type, qty, price in flows:
        if flow_line != line_id or when > at:
            continue
        if mv_type in costing.CHARGE_MOVEMENT_TYPES:
            charged_qty += qty
            if price is None:
                unpriced = True
            else:
                charged += price * Decimal(qty)
        else:
            credited_qty += qty
            if price is not None:
                credited += price * Decimal(qty)
    return charged, credited, charged_qty, credited_qty, unpriced
