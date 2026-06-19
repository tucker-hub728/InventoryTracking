"""receipt_movement_optional_location

Allow a ``receipt`` stock movement to have NO destination location.

Receiving is now a pure inventory-lifecycle event: confirming a physical
receipt flips the lot ON_ORDER → AVAILABLE and records the received
quantity in the ledger, but no longer pins the stock to a physical
location. Physical placement happens separately in the Location System
(``app.lot_allocations`` / ``allocation_movements`` — the ``/allocations/place``
flow). See docs/modules/receipt-admin.md §5.

Only the ``receipt`` clause of ``ck_movements_locations`` changes: a
receipt must still have NO ``from_location_id`` but may now omit
``to_location_id`` (NULL = received, not yet placed). On-hand quantity
stays ledger-derived — ``app.v_item_stock`` sums ``qty_delta`` per item
regardless of location, so a no-location receipt still counts as
available. ``app.v_lot_stock`` (per-lot-per-location) continues to
exclude location-less rows, so the lot is simply "unplaced" until the
Location System maps it to a node.

Rebuilt with DROP + ADD CONSTRAINT (atomic under transactional DDL).

NOTE on the migration chain: this revises ``d6e7f8a9b0c1``
(location_system), the current dev-DB head. The short-lived node-based
receive migration ``e7f8a9b0c1d2`` was reverted (its column-adding,
constraint-relaxing approach is superseded by this simpler location-less
receive), so ``d6e7f8a9b0c1`` is the head this builds on.

Revision ID: f8a9b0c1d2e3
Revises: d6e7f8a9b0c1
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "f8a9b0c1d2e3"
down_revision: str | None = "d6e7f8a9b0c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Receipts only need an empty ``from`` side; the destination is optional.
_NEW_RULE = """
(movement_type = 'receipt'      AND from_location_id IS NULL)
OR (movement_type IN ('dispense', 'discard') AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_out' AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_id IS NULL AND to_location_id IS NOT NULL)
OR (movement_type = 'adjustment')
"""

# Original rule: a receipt was required to carry a destination.
_OLD_RULE = """
(movement_type = 'receipt'      AND from_location_id IS NULL AND to_location_id IS NOT NULL)
OR (movement_type IN ('dispense', 'discard') AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_out' AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_id IS NULL AND to_location_id IS NOT NULL)
OR (movement_type = 'adjustment')
"""


def upgrade() -> None:
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _NEW_RULE, schema="app"
    )


def downgrade() -> None:
    # Will fail if any location-less receipt rows exist (they violate the
    # restored rule); reverse those movements before downgrading.
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _OLD_RULE, schema="app"
    )
