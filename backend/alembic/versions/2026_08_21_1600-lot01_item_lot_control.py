"""lot01: mark which items are lot-controlled (REQ-003)

REQ-003 says a lot number is required "where the item is lot-controlled", and
"may be skipped/synthesized for non-lot items". Nothing in the schema said
which items those were, so receiving demanded a lot number for everything —
gloves and cell banks alike.

**Its own column, not a reuse of ``is_consumable``.** That flag was the obvious
candidate: it already means "blind-consumed to manufacturing with no per-lot
traceability" (REQ-2026-07-01-TRX-003), which sounds like the same fact. It is
not. ``is_consumable`` describes what happens to material when it *leaves*
stock; lot control describes how it is traced while it is *in* stock. They
usually coincide and are free to disagree — a consumable reagent can still need
a traceable lot for a deviation investigation, and that is exactly the case a
regulator asks about. Collapsing the two would make that combination
unexpressible, and the client has not yet confirmed they are the same thing
(question outstanding with Blane as of 2026-08-21; we are proceeding on the
assumption that lot control applies to all item types independently).

**NOT NULL DEFAULT true**, and no backfill beyond what the default writes.
Requiring a lot number is the status quo and the conservative reading: every
row that exists today already had one demanded of it, so defaulting true means
this migration changes the behaviour of exactly nothing until somebody
deliberately turns an item off. Defaulting false would silently relax a GxP
control on 27 live items, which is not a thing a migration should do quietly.

Nothing else moves. ``lots.lot_number`` stays ``NOT NULL`` — a lot without a
number is not a smaller lot, it is an untrackable one, and roughly 270 places
in the codebase read that column expecting a string. Non-lot items get a
*synthesized* number instead, generated server-side at receive.

Revision ID: lot01
Revises: uom01
Create Date: 2026-08-21 16:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "lot01"
down_revision: str | None = "uom01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "is_lot_controlled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        schema="app",
    )


def downgrade() -> None:
    # Dropping the column loses which items had been opted out of lot control.
    # Any AUTO- lot numbers already synthesized under it survive as ordinary
    # lot numbers, which is the correct outcome: they are real received stock
    # and the receipts that created them are signed.
    op.drop_column("items", "is_lot_controlled", schema="app")
