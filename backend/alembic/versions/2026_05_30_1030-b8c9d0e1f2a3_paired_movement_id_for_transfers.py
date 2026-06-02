"""paired_movement_id_for_transfers

Add ``paired_movement_id`` to ``app.stock_movements`` so the two legs of
a transfer can point at each other. Only the second-written leg
(``transfer_in``) gets populated; the ``transfer_out`` row stays linked
via the inverse lookup (``WHERE paired_movement_id = X``). This is
deliberate — the append-only trigger forbids back-filling the column on
the already-inserted ``transfer_out`` row.

Why a dedicated column instead of joining on identical
(performed_at, item_id, lot_id, qty_abs):

  * The audit module needs to render "Transfer 5 of L-123 from LN2-A
    to LN2-B" as a single timeline entry. Heuristic joins are fragile
    when two operators happen to transfer the same lot in the same
    second.
  * Reversal needs to know "this is half of a pair" so it can refuse
    a partial reverse, or reverse both legs atomically.

Nullable because:
  * Existing rows (receipts, dispenses, discards, adjustments) have no
    pair.
  * Even on a transfer, the ``transfer_out`` row is inserted before the
    ``transfer_in`` exists, so it stays NULL forever.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "b8c9d0e1f2a3"
down_revision: str | None = "a7b8c9d0e1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "stock_movements",
        sa.Column(
            "paired_movement_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app.stock_movements.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        schema="app",
    )
    # No self-pair. The matching no-self check for ``reversal_of_id`` is
    # already in place from migration a1b2c3d4e5f6.
    op.create_check_constraint(
        "ck_movements_no_self_pair",
        "stock_movements",
        "paired_movement_id IS NULL OR paired_movement_id <> id",
        schema="app",
    )
    # Per-leg lookup index — "show me the partner of this row".
    op.create_index(
        "ix_movements_paired_movement_id",
        "stock_movements",
        ["paired_movement_id"],
        postgresql_where=sa.text("paired_movement_id IS NOT NULL"),
        schema="app",
    )


def downgrade() -> None:
    op.drop_index(
        "ix_movements_paired_movement_id",
        table_name="stock_movements",
        schema="app",
    )
    op.drop_constraint(
        "ck_movements_no_self_pair",
        "stock_movements",
        type_="check",
        schema="app",
    )
    op.drop_column("stock_movements", "paired_movement_id", schema="app")
