"""movements_trim_and_int_qty

Trim ``stock_movements`` to what the new flow uses + make quantities whole
units (user request 2026-06-22):

  * Drop ``reason_code``, ``reference``, ``destination_text`` and
    ``reversal_of_id`` (+ its self-FK and the no-self-reversal CHECK). Keep
    ``notes`` (the mandatory §3 comment) and ``paired_movement_id`` (transfer
    pairing).
  * ``stock_movements.qty_delta`` / ``qty_abs`` and ``lot_allocations.qty``
    → ``INTEGER`` (whole units only).
  * Relax ``ck_movements_locations`` so a ``dispense`` (consume) may carry a
    ``to_location_node_id`` — the Flat location that consumed the unit.
  * Recreate ``app.v_item_stock`` with integer casts.

Reversible. **Not auto-applied.**

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9e0
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "a6b7c8d9e0f1"
down_revision: str | None = "f5a6b7c8d9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Relaxed: dispense/discard may now carry a destination node (consume → flat).
_LOC_RULE = """
(movement_type = 'receipt'      AND from_location_node_id IS NULL)
OR (movement_type IN ('dispense', 'discard'))
OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_node_id IS NULL)
OR (movement_type = 'adjustment')
"""

# Previous rule (f5a6b7c8d9e0) — restored on downgrade.
_LOC_RULE_PREV = """
(movement_type = 'receipt'      AND from_location_node_id IS NULL)
OR (movement_type IN ('dispense', 'discard') AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_node_id IS NULL)
OR (movement_type = 'adjustment')
"""


def _view(cast: str) -> str:
    return f"""
CREATE VIEW app.v_item_stock AS
SELECT
    s.item_id,
    s.qty_on_hand,
    s.qty_available,
    CASE
        WHEN s.qty_available <= 0 THEN 'out_of_stock'
        WHEN s.qty_available <= s.reorder_threshold THEN 'low_stock'
        ELSE 'available'
    END AS status_code,
    s.last_movement_at
FROM (
    SELECT
        i.id AS item_id,
        i.reorder_threshold,
        COALESCE(SUM(m.qty_delta), 0)::{cast} AS qty_on_hand,
        COALESCE(SUM(
            CASE
                WHEN l.expiration_date IS NOT NULL
                     AND l.expiration_date < CURRENT_DATE
                THEN 0 ELSE m.qty_delta
            END
        ), 0)::{cast} AS qty_available,
        MAX(m.performed_at) AS last_movement_at
    FROM app.items i
    LEFT JOIN app.stock_movements m ON m.item_id = i.id
    LEFT JOIN app.lots l ON l.id = m.lot_id
    WHERE i.deleted_at IS NULL
    GROUP BY i.id, i.reorder_threshold
) s;
"""


def upgrade() -> None:
    # The view depends on qty_delta — drop before altering the column type.
    op.execute("DROP VIEW IF EXISTS app.v_item_stock;")

    # Drop the no-self-reversal CHECK, then the reversal/legacy columns.
    op.drop_constraint(
        "ck_movements_no_self_reversal", "stock_movements", schema="app", type_="check"
    )
    op.drop_column("stock_movements", "reversal_of_id", schema="app")
    op.drop_column("stock_movements", "destination_text", schema="app")
    op.drop_column("stock_movements", "reference", schema="app")
    op.drop_column("stock_movements", "reason_code", schema="app")

    # Whole-unit quantities.
    op.alter_column(
        "stock_movements", "qty_delta",
        type_=sa.Integer(), existing_type=sa.Numeric(14, 3),
        existing_nullable=False, postgresql_using="qty_delta::integer", schema="app",
    )
    op.alter_column(
        "stock_movements", "qty_abs",
        type_=sa.Integer(), existing_type=sa.Numeric(14, 3),
        existing_nullable=False, postgresql_using="qty_abs::integer", schema="app",
    )
    op.alter_column(
        "lot_allocations", "qty",
        type_=sa.Integer(), existing_type=sa.Numeric(14, 3),
        existing_nullable=False, postgresql_using="qty::integer", schema="app",
    )

    # Relax the location CHECK for consume → flat.
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE, schema="app"
    )

    op.execute(_view("integer"))


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS app.v_item_stock;")

    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE_PREV, schema="app"
    )

    op.alter_column(
        "lot_allocations", "qty",
        type_=sa.Numeric(14, 3), existing_type=sa.Integer(),
        existing_nullable=False, schema="app",
    )
    op.alter_column(
        "stock_movements", "qty_abs",
        type_=sa.Numeric(14, 3), existing_type=sa.Integer(),
        existing_nullable=False, schema="app",
    )
    op.alter_column(
        "stock_movements", "qty_delta",
        type_=sa.Numeric(14, 3), existing_type=sa.Integer(),
        existing_nullable=False, schema="app",
    )

    op.add_column(
        "stock_movements", sa.Column("reason_code", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements", sa.Column("reference", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements", sa.Column("destination_text", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements",
        sa.Column("reversal_of_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.create_foreign_key(
        "fk_movements_reversal_of_id", "stock_movements", "stock_movements",
        ["reversal_of_id"], ["id"], source_schema="app", referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_movements_no_self_reversal", "stock_movements",
        "reversal_of_id IS NULL OR reversal_of_id <> id", schema="app",
    )

    op.execute(_view("numeric(14, 3)"))
