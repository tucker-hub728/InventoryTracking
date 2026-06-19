"""location_system

Client Location System (Requirements v2 §5–§13). Non-destructive — adds new
tables and leaves the legacy ``meta.storage_racks`` / ``app.storage_positions``
grid in place (now unused).

  1. ``meta.location_nodes``       — strict LN2 hierarchy + flat locations
  2. ``app.lot_allocations``       — lot ↔ storage-node placement (splits)
  3. ``app.allocation_movements``  — append-only place/transfer/consume log

Reversible. Downgrade drops the three tables in dependency order.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "d6e7f8a9b0c1"
down_revision: str | None = "c5d6e7f8a9b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NODE_TYPES = "'tank_quadrant', 'rack', 'cassette_rack', 'box', 'sub_slot', 'flat'"
_FLAT_CATS = "'kanban', 'lab', 'qc', 'engineering', 'materials'"
_MOVE_KINDS = "'place', 'transfer', 'consume'"


def upgrade() -> None:
    # 1) meta.location_nodes — the tree.
    op.create_table(
        "location_nodes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("node_type", sa.Text(), nullable=False),
        sa.Column("flat_category", sa.Text(), nullable=True),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("TRUE"), nullable=False
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "metadata_",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["meta.location_nodes.id"],
            name="fk_location_nodes_parent_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_location_nodes_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            f"node_type IN ({_NODE_TYPES})", name="ck_location_nodes_node_type"
        ),
        sa.CheckConstraint(
            "(node_type = 'flat') = (flat_category IS NOT NULL)",
            name="ck_location_nodes_flat_category_presence",
        ),
        sa.CheckConstraint(
            f"flat_category IS NULL OR flat_category IN ({_FLAT_CATS})",
            name="ck_location_nodes_flat_category",
        ),
        sa.CheckConstraint(
            "(node_type IN ('tank_quadrant', 'flat')) = (parent_id IS NULL)",
            name="ck_location_nodes_root_parentage",
        ),
        sa.UniqueConstraint(
            "parent_id", "code", name="uq_location_nodes_parent_code"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_location_nodes"),
        schema="meta",
    )
    op.create_index(
        "ix_location_nodes_parent_id", "location_nodes", ["parent_id"], schema="meta"
    )
    op.create_index(
        "ix_location_nodes_node_type", "location_nodes", ["node_type"], schema="meta"
    )
    op.create_index(
        "ix_location_nodes_flat_category",
        "location_nodes",
        ["flat_category"],
        schema="meta",
    )
    op.create_index(
        "ix_location_nodes_active", "location_nodes", ["is_active"], schema="meta"
    )

    # 2) app.lot_allocations — lot ↔ storage node.
    op.create_table(
        "lot_allocations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("lot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "location_node_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("qty", sa.Numeric(14, 3), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("TRUE"), nullable=False
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["lot_id"], ["app.lots.id"], name="fk_lot_allocations_lot", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["location_node_id"],
            ["meta.location_nodes.id"],
            name="fk_lot_allocations_node",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_lot_allocations_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("qty >= 0", name="ck_lot_allocations_qty_nonneg"),
        sa.PrimaryKeyConstraint("id", name="pk_lot_allocations"),
        schema="app",
    )
    op.create_index(
        "ix_lot_allocations_lot_id", "lot_allocations", ["lot_id"], schema="app"
    )
    op.create_index(
        "ix_lot_allocations_node_id",
        "lot_allocations",
        ["location_node_id"],
        schema="app",
    )
    op.create_index(
        "ix_lot_allocations_active_node",
        "lot_allocations",
        ["location_node_id"],
        schema="app",
        postgresql_where=sa.text("is_active"),
    )

    # 3) app.allocation_movements — append-only audit log.
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
            f"movement_kind IN ({_MOVE_KINDS})", name="ck_allocation_movements_kind"
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
    # Append-only is enforced at the app layer (the repository only ever
    # INSERTs these rows) — consistent with how the location system stays
    # decoupled from the trigger-protected legacy ledger.


def downgrade() -> None:
    op.drop_table("allocation_movements", schema="app")
    op.drop_table("lot_allocations", schema="app")
    op.drop_table("location_nodes", schema="meta")
