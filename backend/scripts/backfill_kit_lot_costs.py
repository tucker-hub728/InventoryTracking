"""Price kit-produced lots that were made before per-batch costing existed — RPT-003.

    "I don't see the cost per Assembly pulling through to the FG. There is just
    a - in the part for unit cost."
    — Blane Larson, 2026-09-01

The cost flow itself works. What he hit is a hole in the DATA, and it is one
lot wide: a kit closed before ``kitcost01`` shipped wrote no
``kit_production_batches`` rows and minted its output lot with no
``unit_price_amount`` at all (the one-argument defect RPT-003 closed). That lot
is then an unpriced input to every kit that consumes it, and **one unpriced
input blanks the whole batch** (``costing.batch_cost``) — so a single legacy
sub-assembly silently blanks every finished good built from it, and the FG
item's entire Unit Ledger reads ``—``.

Repricing them one at a time through the UI works but does not scale and is not
auditable as a decision, hence this script.

## What it can and cannot recover

A batch-less kit kept enough to recover its output price EXACTLY, because the
ledger is the source of truth and it survived:

    unit price = (Σ charged − Σ credited over the kit's own movements) ÷ good_qty

Those are the same numbers the kit page already prints as "Material charged",
and the divisor is the same good-units-only rule as ``costing.output_unit_cost``
— scrap stays inside the total rather than becoming a fourth addend.

It refuses, loudly and per lot, when the answer would be a guess:

  * **an unpriced input** — genuinely unknowable, and blank is the correct
    answer. Fix the input lot's price instead and the cascade reaches this one.
  * **a kit with batch rows** — costing already ran; a blank here means an
    input had no price, so the same fix applies one level down. Never overwrite
    a figure that was computed.
  * **more than one output lot on a batch-less kit** — the per-lot split lived
    in the batch rows that do not exist. Averaging across them would invent a
    number and quietly misbill one of two customers.
  * **``good_qty`` of 0** — nothing to divide by, and nothing was stocked.

## Why it cascades

Writing the price is only half the repair: the kits that CONSUMED the lot are
still carrying blanks. ``recompute.recompute_kits_for_lot`` replays each of
them at the corrected price, re-stamps the lots they produced, and follows
those into kits that consumed *them* — so pricing one legacy sub-assembly
lights up the whole tree above it in one pass. That is also why the scan runs in
rounds: a lot that was unfixable in round 1 because its input was unknown is
usually already fixed by the cascade before round 2 looks at it.

Safety model (matches ``scripts/reset_db.py``):
  * Dry-run by default — prints exactly what it would price, and why it is
    skipping the rest, then exits 0. ``--apply`` is required to write.
  * Every write lands one ``app.lots`` audit row with ``actor_kind="system"``
    naming this script and the requirement, so a repriced lot is never a change
    with no explanation behind it.
  * Only ``lots.unit_price_amount`` and the derived batch figures move. No
    movement is written, no quantity changes, nothing is deleted.

Usage (from the ``backend/`` directory):
    python -m scripts.backfill_kit_lot_costs             # report only
    python -m scripts.backfill_kit_lot_costs --apply     # price what is derivable

Exit codes: 0 = ok / dry-run (including "nothing to do"), 1 = failed.
"""

from __future__ import annotations

import argparse
import asyncio
import uuid
from dataclasses import dataclass
from decimal import Decimal

from app.audit import record_entity_change
from app.db.session import dispose_engine, get_sessionmaker
from app.kitting import costing, recompute
from app.kitting import repository as kit_repo
from app.models.inventory import Lot, StockMovement
from app.models.kitting import Kit, KitProductionBatch
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

#: How many scan/fix passes to run. Each pass can only make the next one
#: smaller — pricing a root lot cascades upward — so this is a guard against a
#: pathological loop, not a tuning knob. Two is usually enough; the cascade does
#: the depth, not the rounds.
_MAX_ROUNDS = 5

#: The requirement this repair belongs to, recorded on every audit row so the
#: rows can be found again as a set.
_REQUIREMENT = "RPT-003"


@dataclass
class Candidate:
    """One unpriced kit-produced lot and what we can say about it."""

    kit_id: uuid.UUID
    kit_number: str
    lot_id: uuid.UUID
    lot_number: str
    #: The price to stamp, or ``None`` when the lot is not derivable.
    price: Decimal | None
    #: Why it is not derivable. Empty when it is.
    skip_reason: str


async def _unpriced_kit_outputs(
    session: AsyncSession,
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str]]]:
    """``{kit_id: [(lot_id, lot_number), ...]}`` for every unpriced lot a kit made.

    Found through the ledger rather than ``kit_production_batches.output_lot_id``
    precisely because the kits at issue have no batch rows — the
    ``production_output`` movement is the only record that survived, and it
    carries both the kit and the lot.
    """
    stmt = (
        select(StockMovement.kit_id, StockMovement.lot_id, Lot.lot_number)
        .join(Lot, Lot.id == StockMovement.lot_id)
        .where(
            StockMovement.movement_type == "production_output",
            StockMovement.kit_id.is_not(None),
            Lot.unit_price_amount.is_(None),
        )
        .distinct()
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    for kit_id, lot_id, lot_number in (await session.execute(stmt)).all():
        out.setdefault(kit_id, []).append((lot_id, lot_number))
    return out


async def _classify(
    session: AsyncSession,
    kit_id: uuid.UUID,
    outputs: list[tuple[uuid.UUID, str]],
) -> list[Candidate]:
    """Decide, for one kit, whether each of its unpriced lots can be priced."""
    kit = (
        await session.execute(
            select(Kit).options(selectinload(Kit.lines)).where(Kit.id == kit_id)
        )
    ).scalar_one_or_none()
    if kit is None or not outputs:
        return []

    batch_count = int(
        (
            await session.execute(
                select(func.count())
                .select_from(KitProductionBatch)
                .where(KitProductionBatch.kit_id == kit_id)
            )
        ).scalar_one()
    )

    price: Decimal | None = None
    reason = ""

    if batch_count:
        # Costing already ran here. A blank output means an INPUT lot has no
        # price, and that is the lot to fix — deriving from this end would
        # overwrite a computed figure with a reconstructed one.
        reason = "kit has batch records — fix the unpriced INPUT lot instead"
    elif len(outputs) > 1:
        # The per-lot split lived in the batch rows. With several outputs and no
        # rows, any division between them is invented.
        reason = f"batch-less kit produced {len(outputs)} lots — no per-lot split"
    elif kit.good_qty <= 0:
        reason = "no good units — nothing to divide the material cost by"
    else:
        charge_credit = await kit_repo.line_charge_credit_values(session, kit_id)
        material = Decimal("0")
        for line in kit.lines:
            charged, credited, _unpriced_qty = charge_credit.get(
                line.id, (Decimal("0"), Decimal("0"), 0)
            )
            if charged is None:
                reason = "an input lot has no price — the cost is genuinely unknown"
                break
            material += charged - credited
        else:
            # Same divisor rule as production: good units only, so scrap is
            # recovered from the customer rather than carried by us.
            price = costing.output_unit_cost(material, kit.good_qty)
            if price is None:
                reason = "material cost or good quantity is unusable"

    if price is not None:
        lot_id, lot_number = outputs[0]
        return [Candidate(kit_id, kit.kit_number, lot_id, lot_number, price, "")]
    return [
        Candidate(kit_id, kit.kit_number, lot_id, lot_number, None, reason)
        for lot_id, lot_number in outputs
    ]


async def _scan(session: AsyncSession) -> list[Candidate]:
    kits = await _unpriced_kit_outputs(session)
    found: list[Candidate] = []
    for kit_id, outputs in kits.items():
        found.extend(await _classify(session, kit_id, outputs))
    return sorted(found, key=lambda c: (c.kit_number, c.lot_number))


async def _apply(session: AsyncSession, cand: Candidate) -> int:
    """Price one lot, audit it, and cascade. Returns lots repriced downstream."""
    lot = (
        await session.execute(select(Lot).where(Lot.id == cand.lot_id))
    ).scalar_one()
    assert cand.price is not None
    lot.unit_price_amount = cand.price
    await session.flush()

    # The kits that consumed this lot are still carrying blanks; replay them at
    # the corrected price and follow the outputs upward.
    result = await recompute.recompute_kits_for_lot(session, lot_id=lot.id)

    await record_entity_change(
        session,
        actor_user_id=None,
        actor_kind="system",
        action="updated",
        subject_table="app.lots",
        subject_id=lot.id,
        subject_label=lot.lot_number,
        before={"unit_price_amount": None},
        after={"unit_price_amount": str(cand.price)},
        context={
            "requirement": _REQUIREMENT,
            "source": "scripts/backfill_kit_lot_costs",
            "reason": (
                f"Produced by {cand.kit_number}, which closed before per-batch "
                "costing existed and left the lot unpriced. Recovered from the "
                "kit's own ledger charges divided by its good units."
            ),
            "kit_number": cand.kit_number,
            "recosted": {
                "kits": result.kits_visited,
                "batches": result.batches_updated,
                "lots_repriced": {
                    lot_no: [str(old), str(new)]
                    for lot_no, (old, new) in result.lots_repriced.items()
                },
            },
        },
    )
    return len(result.lots_repriced)


def _report(cands: list[Candidate], *, applied: bool) -> None:
    fixable = [c for c in cands if c.price is not None]
    blocked = [c for c in cands if c.price is None]

    if fixable:
        print(f"\n{'PRICED' if applied else 'WOULD PRICE'} ({len(fixable)}):")
        for c in fixable:
            print(f"  {c.kit_number:<12} {c.lot_number:<20} ${c.price}/unit")
    if blocked:
        print(f"\nSKIPPED ({len(blocked)}) — blank is the correct answer here:")
        for c in blocked:
            print(f"  {c.kit_number:<12} {c.lot_number:<20} {c.skip_reason}")
    if not cands:
        print("\nNo unpriced kit-produced lots. Nothing to do.")


async def _run(args: argparse.Namespace) -> int:
    sessionmaker = get_sessionmaker()
    try:
        async with sessionmaker() as session:
            first = await _scan(session)
            print(f"Found {len(first)} unpriced kit-produced lot(s).")

            if not args.apply:
                _report(first, applied=False)
                print("\nDry run — nothing was written. Re-run with --apply to price them.")
                return 0

            priced: list[Candidate] = []
            cascaded = 0
            pending = first
            for round_no in range(1, _MAX_ROUNDS + 1):
                fixable = [c for c in pending if c.price is not None]
                if not fixable:
                    break
                print(f"\nRound {round_no}: pricing {len(fixable)} lot(s)…")
                for cand in fixable:
                    cascaded += await _apply(session, cand)
                    priced.append(cand)
                await session.commit()
                # Re-scan: the cascade above has usually already fixed the lots
                # that were blocked on an unknown input a moment ago.
                pending = await _scan(session)

            _report(priced, applied=True)
            if cascaded:
                print(f"\nCascade re-priced {cascaded} downstream lot(s).")
            remaining = await _scan(session)
            if remaining:
                _report([c for c in remaining if c.price is None], applied=True)
        return 0
    finally:
        await dispose_engine()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Price kit-produced lots left unpriced by kits that closed before "
            "per-batch costing existed (RPT-003), and cascade the correction."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the prices. Without it the script only reports.",
    )
    return parser.parse_args()


def main() -> int:
    return asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
