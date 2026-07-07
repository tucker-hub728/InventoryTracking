"""add_item_description

Adds an optional free-text ``description`` column to ``app.items`` (week 2 —
surfaced on the New / Edit Raw Material forms). Nullable, so existing rows are
unaffected and no backfill is required.

Revision ID: itemdesc01
Revises: week1reset01
Create Date: 2026-07-07 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "itemdesc01"
down_revision: str | None = "week1reset01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("description", sa.Text(), nullable=True),
        schema="app",
    )


def downgrade() -> None:
    op.drop_column("items", "description", schema="app")
