"""drop_legacy_locations_storage

Phase C — decommission the legacy location/storage stack (user-approved
2026-06-22). Unit-IN / transfer / unit-OUT now live entirely in the Location
System (node-based ``stock_movements``); the old flat ``meta.locations`` +
rack/position grid and the legacy location columns are gone.

Drops:
  * view ``app.v_lot_stock`` (per-location stock — superseded by node placement)
  * ``stock_movements.from_location_id`` / ``to_location_id`` (legacy FK cols)
    and rewrites ``ck_movements_locations`` to a node-only rule
  * ``app.storage_assignment_events`` → ``app.storage_positions`` →
    ``meta.storage_racks`` → ``meta.locations`` (dependency order)

**Irreversible** — this is a one-way decommission. Existing ledger rows keep
their node columns; legacy from/to location data is dropped. Run
``alembic upgrade head`` after review.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "f5a6b7c8d9e0"
down_revision: str | None = "e4f5a6b7c8d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Node-only location rule. Permissive about NULLs so pre-existing legacy rows
# (whose node columns are NULL after the legacy columns are dropped) still
# validate, while constraining the "wrong side" for new node movements.
_LOC_RULE_NODE = """
(movement_type = 'receipt'      AND from_location_node_id IS NULL)
OR (movement_type IN ('dispense', 'discard') AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_node_id IS NULL)
OR (movement_type = 'adjustment')
"""


def upgrade() -> None:
    # 1) Per-location stock view — superseded by node placement.
    op.execute("DROP VIEW IF EXISTS app.v_lot_stock;")

    # 2) stock_movements legacy location columns + node-only CHECK.
    #    Drop the CHECK first (it references the columns), then the columns
    #    (Postgres cascades their FK constraints), then the new node-only CHECK.
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.drop_column("stock_movements", "from_location_id", schema="app")
    op.drop_column("stock_movements", "to_location_id", schema="app")
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE_NODE, schema="app"
    )

    # 3) Legacy storage + flat-locations tables, children first.
    op.drop_table("storage_assignment_events", schema="app")
    op.drop_table("storage_positions", schema="app")
    op.drop_table("storage_racks", schema="meta")
    op.drop_table("locations", schema="meta")


def downgrade() -> None:
    raise NotImplementedError(
        "Irreversible: the legacy location/storage stack was decommissioned "
        "(migration f5a6b7c8d9e0). Restore from a backup if you need it back."
    )
