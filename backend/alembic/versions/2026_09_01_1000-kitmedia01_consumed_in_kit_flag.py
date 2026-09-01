"""kitmedia01: media consumed to the kit, never back-flushed (KIT-003)

    "In multi-day kits, consumables such as media are consumed when replaced and
    are not back-flushed. The paper record drives what was pulled; the software
    mirrors it."
    — REQ-2026-07-31-KIT-003 (Jira, priority Highest)

    "This is in regards to multiple cell feedings (aka: replaced). The media is
    consumed to the kit as the unit and the cost ($$/unit) should pull through
    with the kit costs."
    — the same ticket, second paragraph

    "Currently the media can be added each time it is used by Issue More but it
    will be backflushed unless the amount used matches the amount issued when it
    is Kitted."
    — Blane Larson, 2026-08-31

Two boolean columns. That last quote is the whole reason this revision exists:
the client had already found the right *procedure* — pull media through "Issue
more" at each feeding — and noticed that the software then hands it straight
back. Close-out back-flushes ``issued + additional − early_returned − used``
unconditionally, and the operator's "used" column pre-fills to the recipe ratio,
so the default action returns the media to stock. Worse for the second quote,
``backflush`` is a CREDIT movement type, so the return also credits the media's
cost away — the $/unit the client wants on the FG lot is exactly what the
back-flush removes.

## Why a flag on the item and not a lift of the consumables ban

Media is an ``is_consumable`` item, and consumables are banned from BOMs
(Transaction Spec §4.3, REQ-2026-07-09-PLN-005). A kit line only ever comes from
a BOM, so media could not be a kit line at all. The client settled this on
2026-08-31 and NOT by lifting the ban: a **non-consumable twin** of the media
(and of agar plates, test peptides) is created and put in the BOM. The twin is
an ordinary tracked item; it simply happens to be poured rather than assembled.

``items.consumed_in_kit`` is what marks that twin, and the CHECK makes the two
flags mutually exclusive — an item that were both would be banned from the very
BOM this flag only means anything inside of.

Note the twin cannot share the original's part number: ``uq_items_prefix_suffix``
makes (prefix, suffix) unique and the SKU is derived from it. Two part numbers
means two stock balances, so kit media must be RECEIVED against the twin. That
is an ongoing purchasing habit, not a one-time setup step.

## Why the kit line carries a snapshot

``kit_lines.consumed_in_kit`` copies the item's flag at kit creation, exactly as
``qty_per_unit`` copies ``bom_lines.qty_per_unit``. How a kit reconciled must not
change under it because somebody edited the item months later. Every read path
takes the line's value, never the item's.

## KIT-006 is not overridden — its input changes

REQ-2026-07-22-KIT-006 says close-out "shall back-flush the difference between
issued and used quantities". At close-out a flagged line's ``used`` is *defined*
as the entire remaining floor, so the difference is zero and the back-flush
correctly returns nothing. The rule still runs; it just has nothing to do. Said
here because the explicit skip in ``close_out_kit`` will otherwise read like a
KIT-006 regression to whoever finds it next.

**And nothing else changes.** While the kit is OPEN a flagged line is an ordinary
component: the BOM drives its need, the operator records each feeding, and
``used_qty_missing`` / ``used_below_need`` / ``used_exceeds_issued`` all apply,
to the poured remainder as much as to an entered amount. This was deliberately
narrowed (client, 2026-08-31) from a first cut that consumed the whole floor at
every batch — which made the BOM meaningless for media and let an early batch eat
the feedings issued for later days.

## What this does NOT do

**No backfill.** Every existing item stays ``FALSE`` — nothing in the catalogue
is a media twin yet, they have to be created. And no historical kit line is
touched: a kit that already reconciled by back-flushing its leftover reconciled
correctly under the rules in force at the time, and rewriting the flag would
change the meaning of a closed, signed record without changing a single quantity.

**No new movement type, no costing column, no migration of cost data.**
Consuming material writes no movement (it left ``v_item_stock`` at issue), so a
flagged line's consumption is an ordinary ``kit_batch_consumptions`` row and its
value flows to the minted lot through the existing moving average. The whole
cost half of KIT-003 is satisfied by the material simply being consumed instead
of returned — ``costing.py`` needs no change at all.

Revision ID: kitmedia01
Revises: kitcost01
Create Date: 2026-09-01 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "kitmedia01"
down_revision: str | None = "kitcost01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "consumed_in_kit",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )
    op.create_check_constraint(
        "ck_items_consumable_xor_consumed_in_kit",
        "items",
        "NOT (is_consumable AND consumed_in_kit)",
        schema="app",
    )
    op.add_column(
        "kit_lines",
        sa.Column(
            "consumed_in_kit",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("kit_lines", "consumed_in_kit", schema="app")
    op.drop_constraint(
        "ck_items_consumable_xor_consumed_in_kit",
        "items",
        type_="check",
        schema="app",
    )
    op.drop_column("items", "consumed_in_kit", schema="app")
