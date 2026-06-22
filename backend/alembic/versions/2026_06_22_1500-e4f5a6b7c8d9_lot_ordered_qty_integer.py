"""lot_ordered_qty_integer

Make ``app.lots.ordered_qty`` whole-units only (user request 2026-06-22):
change the type from ``NUMERIC(14,3)`` to ``INTEGER``. Ordered quantity is a
count of units and also caps total unit-IN, so it must be an integer.

Existing values are cast with ``::integer`` (they are whole numbers in
practice). Reversible.

Revision ID: e4f5a6b7c8d9
Revises: b0c1d2e3f4a5
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "e4f5a6b7c8d9"
down_revision: str | None = "b0c1d2e3f4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "lots",
        "ordered_qty",
        type_=sa.Integer(),
        existing_type=sa.Numeric(14, 3),
        existing_nullable=True,
        postgresql_using="ordered_qty::integer",
        schema="app",
    )


def downgrade() -> None:
    op.alter_column(
        "lots",
        "ordered_qty",
        type_=sa.Numeric(14, 3),
        existing_type=sa.Integer(),
        existing_nullable=True,
        schema="app",
    )
