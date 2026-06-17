"""item_stock_available_excl_expired

Add ``qty_available`` to ``app.v_item_stock`` and base ``status_code`` on it.

Expired units must drop out of the *available* inventory count (so
forecasting and reorder logic are accurate) but stay physically
on-hand and visible until they're scrapped (a ``discard`` movement).
A lot is "expired" purely by date — ``expiration_date < CURRENT_DATE``
— which is objective and always current (no reliance on someone
flipping the lot's status flag).

The view now returns BOTH counts:

  * ``qty_on_hand``  — SUM of every movement's qty_delta (physical;
                       includes expired). Unchanged from before.
  * ``qty_available``— SUM excluding units in lots whose date has
                       passed. ``status_code`` is computed from this.

Movements with no lot (``lot_id IS NULL`` — book adjustments / opening
balances) have no expiry and always count as available.

Rebuilt with DROP + CREATE (atomic under transactional DDL) rather than
CREATE OR REPLACE, because the new ``qty_available`` column lands in the
middle of the column list — CREATE OR REPLACE only allows appending.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "e3f4a5b6c7d8"
down_revision: str | None = "d2e3f4a5b6c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_NEW_VIEW = """
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
        COALESCE(SUM(m.qty_delta), 0)::numeric(14, 3) AS qty_on_hand,
        COALESCE(SUM(
            CASE
                WHEN l.expiration_date IS NOT NULL
                     AND l.expiration_date < CURRENT_DATE
                THEN 0
                ELSE m.qty_delta
            END
        ), 0)::numeric(14, 3) AS qty_available,
        MAX(m.performed_at) AS last_movement_at
    FROM app.items i
    LEFT JOIN app.stock_movements m ON m.item_id = i.id
    LEFT JOIN app.lots l ON l.id = m.lot_id
    WHERE i.deleted_at IS NULL
    GROUP BY i.id, i.reorder_threshold
) s;
"""

# Definition exactly as it stood before this migration (qty_on_hand only,
# status_code derived from on-hand). Restored on downgrade.
_OLD_VIEW = """
CREATE VIEW app.v_item_stock AS
SELECT
    i.id AS item_id,
    COALESCE(SUM(m.qty_delta), 0)::numeric(14, 3) AS qty_on_hand,
    CASE
        WHEN COALESCE(SUM(m.qty_delta), 0) <= 0
            THEN 'out_of_stock'
        WHEN COALESCE(SUM(m.qty_delta), 0) <= i.reorder_threshold
            THEN 'low_stock'
        ELSE 'available'
    END AS status_code,
    MAX(m.performed_at) AS last_movement_at
FROM app.items i
LEFT JOIN app.stock_movements m ON m.item_id = i.id
WHERE i.deleted_at IS NULL
GROUP BY i.id, i.reorder_threshold;
"""


def upgrade() -> None:
    op.execute("DROP VIEW IF EXISTS app.v_item_stock;")
    op.execute(_NEW_VIEW)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS app.v_item_stock;")
    op.execute(_OLD_VIEW)
