"""drop_vendor_avg_lead_days

Removes the now-unused ``meta.vendors.avg_lead_days`` column. Lead time
is tracked per inventory item (``app.items.avg_lead_days``), so the
vendor-level field was redundant; it has been dropped from the API,
schemas, and UI. The seeded workbook rows never populated it, so no
data is lost.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "d0e1f2a3b4c5"
down_revision: str | None = "c9d0e1f2a3b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("vendors", "avg_lead_days", schema="meta")


def downgrade() -> None:
    # Re-add as a nullable column (the original definition). Historical
    # values are not restored — they were never populated in production.
    op.add_column(
        "vendors",
        sa.Column("avg_lead_days", sa.Integer(), nullable=True),
        schema="meta",
    )
