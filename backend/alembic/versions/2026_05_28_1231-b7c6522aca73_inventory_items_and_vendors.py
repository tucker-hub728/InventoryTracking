"""inventory_items_and_vendors

Creates the inventory catalog tables — ``meta.vendors``,
``meta.units_of_measure`` (with seed rows), and ``app.items``. Item
numbers are prefix-constrained at the DB level: only ``CM-``, ``NM-``,
``CR-``, ``AY-`` are accepted (per
``docs/backend-data-structure.md`` §4.1). The 2-letter prefix is the
sole grouping signal — there is deliberately no ``meta.categories``.

Lots, batches, and the ledger are out of scope for this migration.
Until they ship, every item appears as ``qty_on_hand = 0`` /
``status = out_of_stock``.

Revision ID: b7c6522aca73
Revises: f0cc0b641382
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID


revision: str = "b7c6522aca73"
down_revision: str | None = "f0cc0b641382"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Allowed ``item_number`` prefixes. Kept here (not as Python imports) so
# the migration is replayable on a fresh DB without the app.
ALLOWED_PREFIXES: tuple[str, ...] = ("CM-", "NM-", "CR-", "AY-")

UOM_SEED: list[dict[str, str | bool]] = [
    {"code": "unit", "label": "Unit", "is_discrete": True},
    {"code": "vial", "label": "Vial", "is_discrete": True},
    {"code": "bag", "label": "Bag", "is_discrete": True},
    {"code": "bottle", "label": "Bottle", "is_discrete": True},
    {"code": "mL", "label": "Millilitre", "is_discrete": False},
    {"code": "L", "label": "Litre", "is_discrete": False},
    {"code": "g", "label": "Gram", "is_discrete": False},
    {"code": "mg", "label": "Milligram", "is_discrete": False},
    {"code": "ug", "label": "Microgram", "is_discrete": False},
]


def upgrade() -> None:
    # ── meta.units_of_measure ────────────────────────────────────────────
    op.create_table(
        "units_of_measure",
        sa.Column("code", sa.Text(), primary_key=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "is_discrete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("TRUE"),
        ),
        schema="meta",
    )
    op.bulk_insert(
        sa.table(
            "units_of_measure",
            sa.column("code", sa.Text()),
            sa.column("label", sa.Text()),
            sa.column("is_discrete", sa.Boolean()),
            schema="meta",
        ),
        UOM_SEED,
    )

    # ── meta.vendors ─────────────────────────────────────────────────────
    op.create_table(
        "vendors",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("contact_email", sa.Text(), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column("address", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("avg_lead_days", sa.Integer(), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("TRUE"),
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        schema="meta",
    )
    op.create_index(
        "uq_vendors_name", "vendors", [sa.text("lower(name)")], unique=True, schema="meta"
    )
    op.create_index(
        "ix_vendors_active", "vendors", ["is_active"], schema="meta"
    )

    # ── app.items ────────────────────────────────────────────────────────
    prefix_check = " OR ".join(
        f"item_number LIKE '{p}%'" for p in ALLOWED_PREFIXES
    )
    op.create_table(
        "items",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("item_number", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "vendor_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.vendors.id",
                ondelete="RESTRICT",
                name="fk_items_vendor_id_vendors",
            ),
            nullable=True,
        ),
        sa.Column("avg_lead_days", sa.Integer(), nullable=True),
        sa.Column(
            "reorder_threshold",
            sa.Numeric(14, 3),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("unit_price_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("units_per_package", sa.Integer(), nullable=True),
        sa.Column("price_per_package_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column(
            "uom_code",
            sa.Text(),
            sa.ForeignKey(
                "meta.units_of_measure.code",
                ondelete="RESTRICT",
                name="fk_items_uom_code_units_of_measure",
            ),
            nullable=False,
            server_default=sa.text("'unit'"),
        ),
        sa.Column("po_note", sa.Text(), nullable=True),
        sa.Column("po_due_text", sa.Text(), nullable=True),
        sa.Column(
            "must_order_flag",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        sa.Column("last_updated_on", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "metadata_",  # avoid clashing with SQLAlchemy's reserved ``metadata`` attr
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
            key="metadata_",
        ),
        sa.Column(
            "row_version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_items_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_items_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        # ── Hard rules at the DB level ─────────────────────────────────
        # Prefix is the grouping signal — no category FK. Doc §4.1.
        sa.CheckConstraint(prefix_check, name="ck_items_item_number_prefix"),
        # Item numbers we generate are always ``XX-NNNN`` (4 digits). The
        # CHECK matches the prefix above plus a numeric tail; we allow
        # any number of digits ≥1 so manually-typed legacy numbers fit too.
        sa.CheckConstraint(
            "item_number ~ '^(CM|NM|CR|AY)-[0-9]+$'",
            name="ck_items_item_number_format",
        ),
        sa.CheckConstraint(
            "reorder_threshold >= 0",
            name="ck_items_reorder_threshold_nonneg",
        ),
        sa.CheckConstraint(
            "unit_price_amount IS NULL OR unit_price_amount >= 0",
            name="ck_items_unit_price_nonneg",
        ),
        schema="app",
    )

    # ``item_number`` is unique among non-deleted rows; soft-deleted rows
    # keep their number so the audit trail still resolves it.
    op.create_index(
        "uq_items_item_number",
        "items",
        ["item_number"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index("ix_items_vendor_id", "items", ["vendor_id"], schema="app")
    # Prefix-group filter on the list view. Postgres can use this for the
    # ``WHERE item_number LIKE 'CM-%'`` query.
    op.create_index(
        "ix_items_item_number_prefix",
        "items",
        [sa.text("substring(item_number from 1 for 2)")],
        schema="app",
    )
    # Full-text search on description for the search bar.
    op.create_index(
        "ix_items_description_fts",
        "items",
        [sa.text("to_tsvector('english', description)")],
        postgresql_using="gin",
        schema="app",
    )
    op.create_index(
        "ix_items_updated_at_desc",
        "items",
        [sa.text("updated_at DESC")],
        schema="app",
    )

    # ── updated_at trigger (reuse the identity-module function) ──────────
    op.execute(
        """
        CREATE TRIGGER tg_items_touch_updated_at
        BEFORE UPDATE ON app.items
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_vendors_touch_updated_at
        BEFORE UPDATE ON meta.vendors
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tg_items_touch_updated_at ON app.items;")
    op.execute("DROP TRIGGER IF EXISTS tg_vendors_touch_updated_at ON meta.vendors;")
    op.drop_index("ix_items_updated_at_desc", table_name="items", schema="app")
    op.drop_index("ix_items_description_fts", table_name="items", schema="app")
    op.drop_index("ix_items_item_number_prefix", table_name="items", schema="app")
    op.drop_index("ix_items_vendor_id", table_name="items", schema="app")
    op.drop_index("uq_items_item_number", table_name="items", schema="app")
    op.drop_table("items", schema="app")
    op.drop_index("ix_vendors_active", table_name="vendors", schema="meta")
    op.drop_index("uq_vendors_name", table_name="vendors", schema="meta")
    op.drop_table("vendors", schema="meta")
    op.drop_table("units_of_measure", schema="meta")
