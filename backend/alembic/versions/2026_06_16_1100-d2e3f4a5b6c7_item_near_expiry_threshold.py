"""item_near_expiry_threshold

Add ``app.items.near_expiry_threshold_days`` — the per-item near-expiry
window (in days) that drives the colour-coded expiry indicators on the
inventory unit ledger: a lot expiring within this many days renders
"near expiry" (amber), an already-past lot "expired" (red), anything
further out "ok" (green).

Additive + non-null with a server default of ``30``, so it backfills
every existing row safely on a populated table. A non-negative CHECK
mirrors the existing ``reorder_threshold`` guard; the API also rejects
negatives at the edge (Pydantic ``ge=0``), so the CHECK is a backstop.

The CHECK name carries the doubled ``ck_items_`` prefix to match the
metadata naming convention already in force on this table (see
``ck_items_ck_items_reorder_threshold_nonneg``).

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "d2e3f4a5b6c7"
down_revision: str | None = "c1d2e3f4a5b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Convention-wrapped constraint name, matching the sibling checks already
# on app.items (the metadata naming convention doubles the ck_items_ prefix).
_CK_NAME = "ck_items_ck_items_near_expiry_threshold_days_nonneg"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "near_expiry_threshold_days",
            sa.Integer(),
            nullable=False,
            server_default="30",
        ),
        schema="app",
    )
    op.execute(
        f"ALTER TABLE app.items ADD CONSTRAINT {_CK_NAME} "
        "CHECK (near_expiry_threshold_days >= 0)"
    )


def downgrade() -> None:
    op.execute(f"ALTER TABLE app.items DROP CONSTRAINT IF EXISTS {_CK_NAME}")
    op.drop_column("items", "near_expiry_threshold_days", schema="app")
