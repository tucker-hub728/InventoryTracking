"""v_lot_stock_view

Per-lot-per-location balance view, used by the dispense wizard's lot
picker and by the dispense endpoint to verify "you can't take more than
you have." Sum of ``qty_delta`` grouped by ``(item, lot, location)``,
where ``location`` is whichever of ``from_location_id`` /
``to_location_id`` the row sets (they're mutually exclusive per the
``ck_movements_locations`` CHECK for every non-adjustment type).

Movements with ``lot_id IS NULL`` or no location are excluded —
they're book-only adjustments that don't change physical stock at
any specific (lot, location).

Negative balances are *not* filtered out here; the dispense endpoint
treats ``< 0`` as a programmer bug (since the API rejects overdraws)
but reports it accurately if it ever shows up.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "f2a3b4c5d6e7"
down_revision: str | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE VIEW app.v_lot_stock AS
        SELECT
            m.item_id,
            m.lot_id,
            COALESCE(m.from_location_id, m.to_location_id) AS location_id,
            COALESCE(SUM(m.qty_delta), 0)::numeric(14, 3) AS qty_available,
            MAX(m.performed_at) AS last_movement_at
        FROM app.stock_movements m
        WHERE m.lot_id IS NOT NULL
          AND COALESCE(m.from_location_id, m.to_location_id) IS NOT NULL
        GROUP BY
            m.item_id,
            m.lot_id,
            COALESCE(m.from_location_id, m.to_location_id);
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS app.v_lot_stock;")
