"""varyield01: variable-yield items — the BOM stops being a floor on output

    "When growing virus or creating a protein, the constraint isn't the yield
    for the consumption of the raw material or assemblies. For example: one TREX
    reactor with 4 media feedings could result in a yield of 200 grams of
    material. The next time it is produced it could consume the exact same raw
    materials but yield 350 grams of material. The software (correctly for what
    we knew yesterday) constrained the parts 1:many (depending on scrap). The way
    virus production works is that it is consumed as a Variable Yield : Consumed
    Material with no real constraints on material in to material used."
    — Blane Larson, 2026-09-01

    "Would removing the constraints or adding a toggle like you did with the
    media be possible?"
    — the same message

Two boolean columns, and a toggle rather than a removal, because the constraint
being lifted is *correct* everywhere else.

## What the constraint is, and which run it actually breaks

``_produce_batch`` requires, per component, that the material recorded as used
covers what the recipe says the batch needs::

    need = ceil(qty_per_unit × (good + scrap))
    if used < need:  → 422 used_below_need

For an assembly that is simply physics: you cannot make three units out of two
units' worth of parts. For a bioreactor it is false — the cells decide the yield,
not the arithmetic.

The failing case is the OVER-yield run, which is worth stating plainly because
the error message points the other way. With 200 units of material issued against
a 1:1 recipe, a run that yields 200 passes; a run that yields 350 is rejected,
because ``need`` becomes 350 and only 200 was used. And there is no way around it
from the floor: ``used_exceeds_issued`` caps ``used`` at what is physically on the
production node, so the operator cannot inflate ``used`` to satisfy the first
gate. A good run — the better of the two — is simply unrecordable.

## Why the flag sits on the item being MADE

``consumed_in_kit`` (kitmedia01) marks a COMPONENT, because pouring away a
leftover is a fact about the media. Variable yield is a fact about the PROCESS,
and the process is identified by the thing being grown. So this flag lives on the
parent — the AY/FG the kit builds — and is read once, at kit creation.

## Why the kit carries a snapshot

``kits.variable_yield`` copies the item's flag at creation, exactly as
``kit_lines.consumed_in_kit`` copies the item's and ``qty_per_unit`` copies the
BOM's. Re-reading the item at produce time would let an edit months later
retroactively legalise batches that were refused, or invalidate batches that were
signed — changing the meaning of a closed record without changing a quantity.

## What the flag does NOT relax

Only ``used_below_need``, the one recipe-derived gate. ``used_qty_missing`` and
``used_exceeds_issued`` are physical facts and still apply: the operator must
still say what was consumed, and still cannot consume material that is not on the
floor. The BOM also keeps every other job it has — it still decides which
components a kit has and still drives the quantity to issue. It stops being a
floor on output; it does not stop being the plan.

## Costing needs no change at all

``output_unit_cost`` is ``material_cost ÷ good_qty`` and has always divided by the
operator-entered good count, so a 200 g run and a 350 g run off identical material
already price correctly and differently. ``recompute.py`` replays from each
batch's stored ``good_qty``, so a later lot-price correction stays right too. This
is the half of the client's scenario that was already built.

## What this does NOT do

**No backfill.** Every existing item stays ``FALSE``. Nothing in the catalogue is
a grown item yet as far as the software is concerned, and no historical kit is
touched: a kit that was held to the linear rule was reconciled correctly under the
rules in force at the time.

**No decimal quantities.** Blane's example is 200 g and 350 g — whole numbers.
Every quantity in kitting is an ``Integer``, so "350 g" is recorded as 350 units
of an item whose ``uom`` reads "g". Whether they ever report a fractional gram is
an open question for the client, and widening the column set is its own job.

**No cap on output.** There never was one — nothing relates ``good_qty`` to
``target_qty`` anywhere. The 1:many behaviour the client describes came entirely
from the input-side floor removed here.

Revision ID: varyield01
Revises: kitmedia01
Create Date: 2026-09-01 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "varyield01"
down_revision: str | None = "kitmedia01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "variable_yield",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )
    # A consumable is banned from bills of material and so can never be the
    # parent a kit builds. An item that were both would carry a flag that only
    # means anything in a place it may not appear.
    op.create_check_constraint(
        "ck_items_consumable_xor_variable_yield",
        "items",
        "NOT (is_consumable AND variable_yield)",
        schema="app",
    )
    op.add_column(
        "kits",
        sa.Column(
            "variable_yield",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("kits", "variable_yield", schema="app")
    op.drop_constraint(
        "ck_items_consumable_xor_variable_yield",
        "items",
        type_="check",
        schema="app",
    )
    op.drop_column("items", "variable_yield", schema="app")
