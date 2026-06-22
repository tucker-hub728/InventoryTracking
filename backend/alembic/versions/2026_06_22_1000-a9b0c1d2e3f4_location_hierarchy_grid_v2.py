"""location_hierarchy_grid_v2

Requirements v2 §4.1 LN2 hierarchy rework. See docs/modules/locations.md.

What changes:

  * ``meta.location_nodes``
      - node_type enum gains ``cassette`` + ``cryo_box_rack`` (the single
        ``cassette_rack`` is split into two distinct container types); legacy
        ``cassette_rack`` / ``sub_slot`` are kept in the enum for any old rows
        but are no longer creatable.
      - The **Box** becomes the grid-bearing leaf storage node: new
        ``grid_rows`` / ``grid_cols`` (present iff node_type='box').
      - Quadrant dedication (advisory): ``dedicated_customer_id`` /
        ``dedicated_product_id`` (customer XOR product, only on a quadrant).
  * ``app.lot_allocations`` — a lot is placed into a Box cell: new
    ``grid_row`` / ``grid_col`` + a partial-unique index giving one active
    allocation per cell (manual placement, intentional gaps).
  * ``app.stock_movements`` — gains ``from_location_node_id`` /
    ``to_location_node_id`` so node placement/transfer/consume live in the GxP
    ledger; ``ck_movements_locations`` widened to accept the node columns.
  * ``app.allocation_movements`` — **dropped**. Quantity events move to
    ``stock_movements``; place/transfer audit goes to ``audit.audit_events``.

Existing Location-System seed rows on the dev DB are **wiped** (decided
2026-06-22) — old box/sub_slot nodes can't satisfy the new grid CHECK, and
there is no node data worth migrating. Harmless on an empty DB.

Reversible. **Not auto-applied** — run ``alembic upgrade head`` after review.

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "a9b0c1d2e3f4"
down_revision: str | None = "f8a9b0c1d2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Full node_type enums (CHECK), old and new.
_NODE_TYPES_NEW = (
    "'tank_quadrant', 'rack', 'cassette', 'cryo_box_rack', 'box', 'flat', "
    "'cassette_rack', 'sub_slot'"
)
_NODE_TYPES_OLD = (
    "'tank_quadrant', 'rack', 'cassette_rack', 'box', 'sub_slot', 'flat'"
)

# Deepest-first wipe order — respects the self-referential RESTRICT parent FK.
_WIPE_ORDER = (
    "sub_slot",
    "box",
    "cryo_box_rack",
    "cassette",
    "cassette_rack",
    "rack",
    "tank_quadrant",
    "flat",
)

# ck_movements_locations — widened to accept the node columns (exactly one
# location kind per occupied side).
_LOC_RULE_V2 = """
(movement_type = 'receipt'
    AND from_location_id IS NULL AND from_location_node_id IS NULL
    AND NOT (to_location_id IS NOT NULL AND to_location_node_id IS NOT NULL))
OR (movement_type IN ('dispense', 'discard')
    AND to_location_id IS NULL AND to_location_node_id IS NULL
    AND ((from_location_id IS NOT NULL) <> (from_location_node_id IS NOT NULL)))
OR (movement_type = 'transfer_out'
    AND to_location_id IS NULL AND to_location_node_id IS NULL
    AND ((from_location_id IS NOT NULL) <> (from_location_node_id IS NOT NULL)))
OR (movement_type = 'transfer_in'
    AND from_location_id IS NULL AND from_location_node_id IS NULL
    AND ((to_location_id IS NOT NULL) <> (to_location_node_id IS NOT NULL)))
OR (movement_type = 'adjustment')
"""

# Prior rule (legacy meta.locations only) — restored on downgrade. Matches
# f8a9b0c1d2e3 (receipt destination optional).
_LOC_RULE_V1 = """
(movement_type = 'receipt'      AND from_location_id IS NULL)
OR (movement_type IN ('dispense', 'discard') AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_out' AND from_location_id IS NOT NULL AND to_location_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_id IS NULL AND to_location_id IS NOT NULL)
OR (movement_type = 'adjustment')
"""


def upgrade() -> None:
    # 0) Drop the retired audit table, then wipe seeded location data so the
    #    new grid CHECK can be added cleanly (old 'box' rows have no grid).
    op.drop_table("allocation_movements", schema="app")
    op.execute("DELETE FROM app.lot_allocations")
    for nt in _WIPE_ORDER:
        # nt is a hardcoded constant from _WIPE_ORDER, not user input.
        op.execute(f"DELETE FROM meta.location_nodes WHERE node_type = '{nt}'")  # noqa: S608

    # 1) location_nodes — new columns.
    op.add_column(
        "location_nodes",
        sa.Column("grid_rows", sa.SmallInteger(), nullable=True),
        schema="meta",
    )
    op.add_column(
        "location_nodes",
        sa.Column("grid_cols", sa.SmallInteger(), nullable=True),
        schema="meta",
    )
    op.add_column(
        "location_nodes",
        sa.Column(
            "dedicated_customer_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        schema="meta",
    )
    op.add_column(
        "location_nodes",
        sa.Column(
            "dedicated_product_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        schema="meta",
    )
    op.create_foreign_key(
        "fk_location_nodes_dedicated_customer_id_customers",
        "location_nodes",
        "customers",
        ["dedicated_customer_id"],
        ["id"],
        source_schema="meta",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_location_nodes_dedicated_product_id_products",
        "location_nodes",
        "products",
        ["dedicated_product_id"],
        ["id"],
        source_schema="meta",
        referent_schema="app",
        ondelete="RESTRICT",
    )

    # 2) location_nodes — node_type enum (add cassette / cryo_box_rack).
    op.drop_constraint(
        "ck_location_nodes_node_type", "location_nodes", schema="meta", type_="check"
    )
    op.create_check_constraint(
        "ck_location_nodes_node_type",
        "location_nodes",
        f"node_type IN ({_NODE_TYPES_NEW})",
        schema="meta",
    )

    # 3) location_nodes — grid + dedication CHECKs.
    op.create_check_constraint(
        "ck_location_nodes_grid_presence",
        "location_nodes",
        "(node_type = 'box') = (grid_rows IS NOT NULL AND grid_cols IS NOT NULL)",
        schema="meta",
    )
    op.create_check_constraint(
        "ck_location_nodes_grid_positive",
        "location_nodes",
        "(grid_rows IS NULL OR grid_rows >= 1) "
        "AND (grid_cols IS NULL OR grid_cols >= 1)",
        schema="meta",
    )
    op.create_check_constraint(
        "ck_location_nodes_dedication_exclusive",
        "location_nodes",
        "NOT (dedicated_customer_id IS NOT NULL "
        "AND dedicated_product_id IS NOT NULL)",
        schema="meta",
    )
    op.create_check_constraint(
        "ck_location_nodes_dedication_quadrant_only",
        "location_nodes",
        "(dedicated_customer_id IS NULL AND dedicated_product_id IS NULL) "
        "OR node_type = 'tank_quadrant'",
        schema="meta",
    )
    op.create_index(
        "ix_location_nodes_dedicated_customer",
        "location_nodes",
        ["dedicated_customer_id"],
        schema="meta",
        postgresql_where=sa.text("dedicated_customer_id IS NOT NULL"),
    )
    op.create_index(
        "ix_location_nodes_dedicated_product",
        "location_nodes",
        ["dedicated_product_id"],
        schema="meta",
        postgresql_where=sa.text("dedicated_product_id IS NOT NULL"),
    )

    # 4) lot_allocations — cell coordinates.
    op.add_column(
        "lot_allocations",
        sa.Column("grid_row", sa.SmallInteger(), nullable=True),
        schema="app",
    )
    op.add_column(
        "lot_allocations",
        sa.Column("grid_col", sa.SmallInteger(), nullable=True),
        schema="app",
    )
    op.create_check_constraint(
        "ck_lot_allocations_cell_pairing",
        "lot_allocations",
        "(grid_row IS NULL) = (grid_col IS NULL)",
        schema="app",
    )
    op.create_index(
        "uq_lot_allocations_cell",
        "lot_allocations",
        ["location_node_id", "grid_row", "grid_col"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("is_active AND grid_row IS NOT NULL"),
    )

    # 5) stock_movements — node references + widened location CHECK.
    op.add_column(
        "stock_movements",
        sa.Column(
            "from_location_node_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        schema="app",
    )
    op.add_column(
        "stock_movements",
        sa.Column(
            "to_location_node_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        schema="app",
    )
    op.create_foreign_key(
        "fk_stock_movements_from_location_node_id_location_nodes",
        "stock_movements",
        "location_nodes",
        ["from_location_node_id"],
        ["id"],
        source_schema="app",
        referent_schema="meta",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_stock_movements_to_location_node_id_location_nodes",
        "stock_movements",
        "location_nodes",
        ["to_location_node_id"],
        ["id"],
        source_schema="app",
        referent_schema="meta",
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_movements_from_location_node_id",
        "stock_movements",
        ["from_location_node_id"],
        schema="app",
        postgresql_where=sa.text("from_location_node_id IS NOT NULL"),
    )
    op.create_index(
        "ix_movements_to_location_node_id",
        "stock_movements",
        ["to_location_node_id"],
        schema="app",
        postgresql_where=sa.text("to_location_node_id IS NOT NULL"),
    )
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE_V2, schema="app"
    )


def downgrade() -> None:
    # 5) stock_movements — restore legacy-only location rule + drop node cols.
    op.drop_constraint(
        "ck_movements_locations", "stock_movements", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE_V1, schema="app"
    )
    op.drop_index(
        "ix_movements_to_location_node_id", "stock_movements", schema="app"
    )
    op.drop_index(
        "ix_movements_from_location_node_id", "stock_movements", schema="app"
    )
    op.drop_constraint(
        "fk_stock_movements_to_location_node_id_location_nodes",
        "stock_movements",
        schema="app",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_stock_movements_from_location_node_id_location_nodes",
        "stock_movements",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("stock_movements", "to_location_node_id", schema="app")
    op.drop_column("stock_movements", "from_location_node_id", schema="app")

    # 4) lot_allocations — drop cell coordinates.
    op.drop_index("uq_lot_allocations_cell", "lot_allocations", schema="app")
    op.drop_constraint(
        "ck_lot_allocations_cell_pairing",
        "lot_allocations",
        schema="app",
        type_="check",
    )
    op.drop_column("lot_allocations", "grid_col", schema="app")
    op.drop_column("lot_allocations", "grid_row", schema="app")

    # 3+2) location_nodes — drop grid/dedication CHECKs + restore enum.
    op.drop_index(
        "ix_location_nodes_dedicated_product", "location_nodes", schema="meta"
    )
    op.drop_index(
        "ix_location_nodes_dedicated_customer", "location_nodes", schema="meta"
    )
    op.drop_constraint(
        "ck_location_nodes_dedication_quadrant_only",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.drop_constraint(
        "ck_location_nodes_dedication_exclusive",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.drop_constraint(
        "ck_location_nodes_grid_positive",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.drop_constraint(
        "ck_location_nodes_grid_presence",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.drop_constraint(
        "ck_location_nodes_node_type", "location_nodes", schema="meta", type_="check"
    )
    op.create_check_constraint(
        "ck_location_nodes_node_type",
        "location_nodes",
        f"node_type IN ({_NODE_TYPES_OLD})",
        schema="meta",
    )

    # 1) location_nodes — drop dedication/grid columns.
    op.drop_constraint(
        "fk_location_nodes_dedicated_product_id_products",
        "location_nodes",
        schema="meta",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_location_nodes_dedicated_customer_id_customers",
        "location_nodes",
        schema="meta",
        type_="foreignkey",
    )
    op.drop_column("location_nodes", "dedicated_product_id", schema="meta")
    op.drop_column("location_nodes", "dedicated_customer_id", schema="meta")
    op.drop_column("location_nodes", "grid_cols", schema="meta")
    op.drop_column("location_nodes", "grid_rows", schema="meta")

    # 0) Recreate the dropped allocation_movements table (as in d6e7f8a9b0c1).
    op.create_table(
        "allocation_movements",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("lot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("movement_kind", sa.Text(), nullable=False),
        sa.Column("from_node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("to_node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("qty", sa.Numeric(14, 3), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "performed_by_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "performed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["lot_id"],
            ["app.lots.id"],
            name="fk_allocation_movements_lot",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["from_node_id"],
            ["meta.location_nodes.id"],
            name="fk_allocation_movements_from_node",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["to_node_id"],
            ["meta.location_nodes.id"],
            name="fk_allocation_movements_to_node",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by_user_id"],
            ["app.users.id"],
            name="fk_allocation_movements_performed_by_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "movement_kind IN ('place', 'transfer', 'consume')",
            name="ck_allocation_movements_kind",
        ),
        sa.CheckConstraint("qty > 0", name="ck_allocation_movements_qty_positive"),
        sa.PrimaryKeyConstraint("id", name="pk_allocation_movements"),
        schema="app",
    )
    op.create_index(
        "ix_allocation_movements_lot_id",
        "allocation_movements",
        ["lot_id"],
        schema="app",
    )
    op.create_index(
        "ix_allocation_movements_from_node",
        "allocation_movements",
        ["from_node_id"],
        schema="app",
    )
    op.create_index(
        "ix_allocation_movements_to_node",
        "allocation_movements",
        ["to_node_id"],
        schema="app",
    )
    op.create_index(
        "ix_allocation_movements_performed_at",
        "allocation_movements",
        [sa.text("performed_at DESC")],
        schema="app",
    )
