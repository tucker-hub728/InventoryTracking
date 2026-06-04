"""movement_destination_text

Adds ``app.stock_movements.destination_text`` — the free-text "where did it go"
captured on a unit-out (dispense), by both the dispense wizard and the ``/ln2``
Empty-position action. Additive + nullable: safe on a populated table and
unaffected by the append-only UPDATE/DELETE guards (``ADD COLUMN`` is DDL, not a
row mutation).

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "a2b3c4d5e6f7"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "stock_movements",
        sa.Column("destination_text", sa.Text(), nullable=True),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("stock_movements", "destination_text", schema="app")
