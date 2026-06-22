"""lot_ordered_qty_drop_coa_metadata

Simplify ``app.lots`` (user request, 2026-06-22):

  * Add ``ordered_qty NUMERIC(14,3) NULL`` — the ordered quantity for ON_ORDER
    lots, promoted out of the ``metadata_`` JSON blob into a first-class column.
    Received / on-hand quantity stays ledger-derived (``app.v_item_stock``).
  * Drop ``coa_url`` — no longer tracked.
  * Drop ``metadata_`` — the JSON blob (and the two non-status vendor flags it
    held: ``unverified_vendor_for_item`` /
    ``vendor_not_previously_associated_with_item``) is removed. ``ordered_qty``
    is backfilled from it first.

Reversible. **Not auto-applied** — run ``alembic upgrade head`` after review.
The vendor flags are NOT restored on downgrade (only ordered_qty round-trips).

Revision ID: b0c1d2e3f4a5
Revises: a9b0c1d2e3f4
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "b0c1d2e3f4a5"
down_revision: str | None = "a9b0c1d2e3f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "lots",
        sa.Column("ordered_qty", sa.Numeric(14, 3), nullable=True),
        schema="app",
    )
    # Promote the ordered_qty value out of metadata_ before dropping it.
    op.execute(
        "UPDATE app.lots SET ordered_qty = (metadata_->>'ordered_qty')::numeric "
        "WHERE metadata_ ? 'ordered_qty'"
    )
    op.drop_column("lots", "coa_url", schema="app")
    op.drop_column("lots", "metadata_", schema="app")


def downgrade() -> None:
    op.add_column(
        "lots",
        sa.Column("coa_url", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "lots",
        sa.Column(
            "metadata_",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        schema="app",
    )
    # Round-trip ordered_qty back into metadata_ (vendor flags are not restored).
    op.execute(
        "UPDATE app.lots "
        "SET metadata_ = jsonb_build_object('ordered_qty', ordered_qty::text) "
        "WHERE ordered_qty IS NOT NULL"
    )
    op.drop_column("lots", "ordered_qty", schema="app")
