"""kitting01: kits, kit_lines, and kit stock-movement types

Adds the Kitting / back-flush data layer (docs/modules/kitting.md):

  * ``app.kit_number_seq`` — sequence feeding the human id ``KIT-0001``.
  * ``app.kits`` and ``app.kit_lines``.
  * ``app.stock_movements``: ``kit_id`` / ``kit_line_id`` trace FKs (nullable)
    + ``ix_movements_kit_id``, and four new ``movement_type`` values
    (``kit_issue``, ``kit_additional_issue``, ``production_output``,
    ``backflush``) folded into the type / sign / locations CHECKs. Issue types
    are unit-OUT (from source, delta < 0); output/backflush are unit-IN
    (to a node, delta > 0).
  * ``meta.location_nodes``: ``production`` added to the ``flat_category``
    CHECK, and the five advisory production floors seeded as ``flat`` nodes.

No stock table is introduced — on-hand stays derived through
``app.v_item_stock``, which already sums every ``qty_delta``.

Reversible. **Not auto-applied.**

Revision ID: kitting01
Revises: prefixes02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "kitting01"
down_revision: str | None = "prefixes02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ── movement_type CHECK rules (extend the live constraints) ──────────────────
_TYPE_RULE = (
    "movement_type IN ('receipt', 'dispense', 'adjustment', 'discard', "
    "'transfer_out', 'transfer_in', 'kit_issue', 'kit_additional_issue', "
    "'production_output', 'backflush')"
)
_TYPE_RULE_PREV = (
    "movement_type IN ('receipt', 'dispense', 'adjustment', 'discard', "
    "'transfer_out', 'transfer_in')"
)

_SIGN_RULE = """
(movement_type IN ('receipt', 'transfer_in', 'production_output', 'backflush') AND qty_delta > 0)
OR (movement_type IN ('dispense', 'discard', 'transfer_out', 'kit_issue', 'kit_additional_issue') AND qty_delta < 0)
OR (movement_type = 'adjustment')
"""
_SIGN_RULE_PREV = """
(movement_type IN ('receipt', 'transfer_in') AND qty_delta > 0)
OR (movement_type IN ('dispense', 'discard', 'transfer_out') AND qty_delta < 0)
OR (movement_type = 'adjustment')
"""

_LOC_RULE = """
(movement_type = 'receipt'      AND from_location_node_id IS NULL)
OR (movement_type IN ('dispense', 'discard'))
OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_node_id IS NULL)
OR (movement_type = 'adjustment')
OR (movement_type IN ('kit_issue', 'kit_additional_issue') AND from_location_node_id IS NOT NULL AND to_location_node_id IS NULL)
OR (movement_type IN ('production_output', 'backflush') AND from_location_node_id IS NULL AND to_location_node_id IS NOT NULL)
"""
_LOC_RULE_PREV = """
(movement_type = 'receipt'      AND from_location_node_id IS NULL)
OR (movement_type IN ('dispense', 'discard'))
OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL)
OR (movement_type = 'transfer_in'  AND from_location_node_id IS NULL)
OR (movement_type = 'adjustment')
"""

_FLAT_RULE = (
    "flat_category IS NULL OR flat_category IN "
    "('kanban', 'lab', 'qc', 'engineering', 'materials', 'production')"
)
_FLAT_RULE_PREV = (
    "flat_category IS NULL OR flat_category IN "
    "('kanban', 'lab', 'qc', 'engineering', 'materials')"
)

# Advisory production floors (§4.1) are seeded in ``upgrade`` as flat/root nodes
# owned by the earliest user (created_by_user_id is NOT NULL); a no-op if there
# are no users yet.


def upgrade() -> None:
    op.execute("CREATE SEQUENCE app.kit_number_seq")

    # ── app.kits ─────────────────────────────────────────────────────────
    op.create_table(
        "kits",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("kit_number", sa.Text(), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_qty", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'draft'"), nullable=False),
        sa.Column(
            "production_location_node_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("output_location_node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("good_qty", sa.Integer(), nullable=True),
        sa.Column("scrap_qty", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("issued_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_kits"),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_kits_item_id_items",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["production_location_node_id"],
            ["meta.location_nodes.id"],
            name="fk_kits_production_location_node_id_location_nodes",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["output_location_node_id"],
            ["meta.location_nodes.id"],
            name="fk_kits_output_location_node_id_location_nodes",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["issued_by_user_id"],
            ["app.users.id"],
            name="fk_kits_issued_by_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["closed_by_user_id"],
            ["app.users.id"],
            name="fk_kits_closed_by_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_kits_created_by_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"],
            ["app.users.id"],
            name="fk_kits_updated_by_user_id_users",
            ondelete="RESTRICT",
        ),
        schema="app",
    )
    op.create_check_constraint(
        "ck_kits_target_qty_positive", "kits", "target_qty > 0", schema="app"
    )
    op.create_check_constraint(
        "ck_kits_good_qty_nonneg",
        "kits",
        "good_qty IS NULL OR good_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kits_scrap_qty_nonneg",
        "kits",
        "scrap_qty IS NULL OR scrap_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kits_status",
        "kits",
        "status IN ('draft', 'issued', 'in_production', 'closed', 'cancelled')",
        schema="app",
    )
    op.create_index(
        "uq_kits_kit_number",
        "kits",
        ["kit_number"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index("ix_kits_status", "kits", ["status"], schema="app")
    op.create_index("ix_kits_item_id", "kits", ["item_id"], schema="app")
    op.create_index("ix_kits_created_at_desc", "kits", [sa.text("created_at DESC")], schema="app")

    # ── app.kit_lines ────────────────────────────────────────────────────
    op.create_table(
        "kit_lines",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("kit_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qty_per_unit", sa.Numeric(14, 3), nullable=False),
        sa.Column("issued_qty", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "additional_issued_qty",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("used_qty", sa.Integer(), nullable=True),
        sa.Column("source_location_node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("return_location_node_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_kit_lines"),
        sa.ForeignKeyConstraint(
            ["kit_id"],
            ["app.kits.id"],
            name="fk_kit_lines_kit_id_kits",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_kit_lines_item_id_items",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["source_location_node_id"],
            ["meta.location_nodes.id"],
            name="fk_kit_lines_source_location_node_id_location_nodes",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["return_location_node_id"],
            ["meta.location_nodes.id"],
            name="fk_kit_lines_return_location_node_id_location_nodes",
            ondelete="RESTRICT",
        ),
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_qty_per_unit_positive",
        "kit_lines",
        "qty_per_unit > 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_issued_qty_nonneg",
        "kit_lines",
        "issued_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_additional_issued_qty_nonneg",
        "kit_lines",
        "additional_issued_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_used_qty_nonneg",
        "kit_lines",
        "used_qty IS NULL OR used_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_no_overuse",
        "kit_lines",
        "used_qty IS NULL OR used_qty <= issued_qty + additional_issued_qty",
        schema="app",
    )
    op.create_index("ix_kit_lines_kit_id", "kit_lines", ["kit_id"], schema="app")
    op.create_index(
        "uq_kit_lines_kit_item",
        "kit_lines",
        ["kit_id", "item_id"],
        unique=True,
        schema="app",
    )
    op.create_index(
        "uq_kit_lines_kit_line_no",
        "kit_lines",
        ["kit_id", "line_no"],
        unique=True,
        schema="app",
    )

    # ── app.stock_movements: kit trace links + extended CHECKs ───────────
    op.add_column(
        "stock_movements",
        sa.Column("kit_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements",
        sa.Column("kit_line_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.create_foreign_key(
        "fk_stock_movements_kit_id_kits",
        "stock_movements",
        "kits",
        ["kit_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_stock_movements_kit_line_id_kit_lines",
        "stock_movements",
        "kit_lines",
        ["kit_line_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_movements_kit_id",
        "stock_movements",
        ["kit_id"],
        schema="app",
        postgresql_where=sa.text("kit_id IS NOT NULL"),
    )

    op.drop_constraint("ck_movements_type", "stock_movements", schema="app", type_="check")
    op.create_check_constraint("ck_movements_type", "stock_movements", _TYPE_RULE, schema="app")
    op.drop_constraint("ck_movements_type_sign", "stock_movements", schema="app", type_="check")
    op.create_check_constraint(
        "ck_movements_type_sign", "stock_movements", _SIGN_RULE, schema="app"
    )
    op.drop_constraint("ck_movements_locations", "stock_movements", schema="app", type_="check")
    op.create_check_constraint("ck_movements_locations", "stock_movements", _LOC_RULE, schema="app")

    # ── meta.location_nodes: allow the 'production' flat category ─────────
    # Schema only — the production areas themselves are seeded by a SCRIPT
    # (scripts/seed_production.py), not here, so they aren't tied to the
    # migration and can be re-seeded / extended independently.
    op.drop_constraint(
        "ck_location_nodes_flat_category",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.create_check_constraint(
        "ck_location_nodes_flat_category",
        "location_nodes",
        _FLAT_RULE,
        schema="meta",
    )


def downgrade() -> None:
    # stock_movements: revert CHECKs + drop kit trace links (before the tables).
    op.drop_constraint("ck_movements_locations", "stock_movements", schema="app", type_="check")
    op.create_check_constraint(
        "ck_movements_locations", "stock_movements", _LOC_RULE_PREV, schema="app"
    )
    op.drop_constraint("ck_movements_type_sign", "stock_movements", schema="app", type_="check")
    op.create_check_constraint(
        "ck_movements_type_sign", "stock_movements", _SIGN_RULE_PREV, schema="app"
    )
    op.drop_constraint("ck_movements_type", "stock_movements", schema="app", type_="check")
    op.create_check_constraint(
        "ck_movements_type", "stock_movements", _TYPE_RULE_PREV, schema="app"
    )
    op.drop_index("ix_movements_kit_id", "stock_movements", schema="app")
    op.drop_constraint(
        "fk_stock_movements_kit_line_id_kit_lines",
        "stock_movements",
        schema="app",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_stock_movements_kit_id_kits",
        "stock_movements",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("stock_movements", "kit_line_id", schema="app")
    op.drop_column("stock_movements", "kit_id", schema="app")

    op.drop_table("kit_lines", schema="app")
    op.drop_table("kits", schema="app")
    op.execute("DROP SEQUENCE IF EXISTS app.kit_number_seq")

    # location_nodes: clear any production areas (script-seeded or admin-added;
    # no more kit FK refs by now) so the prior flat_category CHECK — which lacks
    # 'production' — can be restored without violating existing rows.
    op.execute(
        "DELETE FROM meta.location_nodes "
        "WHERE node_type = 'flat' AND flat_category = 'production'"
    )
    op.drop_constraint(
        "ck_location_nodes_flat_category",
        "location_nodes",
        schema="meta",
        type_="check",
    )
    op.create_check_constraint(
        "ck_location_nodes_flat_category",
        "location_nodes",
        _FLAT_RULE_PREV,
        schema="meta",
    )
