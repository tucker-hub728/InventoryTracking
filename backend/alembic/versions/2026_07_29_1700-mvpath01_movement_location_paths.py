"""mvpath01: freeze the location address on every ledger row

``app.stock_movements`` records WHERE something moved as node ids. That answers
"where is that node now" — which stopped being the same question as "where was
the material at the time" once an LN2 node can be re-hung under a new parent
(REQ-2026-07-22-LOC-004). Moving a rack to another quadrant rewrites the
rendered address of every historical movement in the boxes beneath it.

So each row now also stores the address as TEXT, resolved when the row is
written: "Tank 2 / Quadrant 1 / Rack 1 / Box 1". A snapshot, not a reference —
nothing joins on it, and it never changes afterwards. The node ids stay for
every existing query and index.

Both columns are nullable: NULL on the empty side of a one-sided movement (a
receipt has no source, a customer shipment no destination), and on any row
written before this migration. No backfill is attempted — the ledger is
append-only behind a trigger, and backfilling would write today's addresses onto
historical rows, which is exactly the lie these columns exist to prevent.

Revision ID: mvpath01
Revises: ln2tank01
Create Date: 2026-07-29 17:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "mvpath01"
down_revision: str | None = "ln2tank01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "stock_movements",
        sa.Column("from_location_path", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements",
        sa.Column("to_location_path", sa.Text(), nullable=True),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("stock_movements", "to_location_path", schema="app")
    op.drop_column("stock_movements", "from_location_path", schema="app")
