"""unified_catalog_categories_bom

Unify products + items into a single catalogue (requirements v2 §6–§7).

* ``app.item_categories`` — NEW. User-managed categories with a ``kind``
  (``purchased`` | ``built``) and a display ``tone``. Seeded with the five
  client categories (system-created → null audit user). Built categories are
  surfaced as "Product" in the UI.
* ``app.items.category_id`` — NEW NOT-NULL FK. Existing items are back-filled to
  the seeded "Non-Custom Components / Materials" (purchased) category.
* ``app.bom_lines`` — NEW self-referencing BOM (``parent_item_id`` →
  ``child_item_id`` × ``qty_per_run``), replacing ``product_materials`` and
  enabling multi-level / nested BOMs.
* ``app.customer_items`` — NEW M2M (customer ↔ finished-good item), replacing
  ``customer_products``.
* ``app.forecast_entries.product_id`` and ``meta.location_nodes`` dedication FKs
  are **repointed** from ``app.products`` to ``app.items``.
* ``app.products`` and ``app.product_materials`` are **retired** (dropped).

START-FRESH per the design decision: no data is migrated. Existing
``forecast_entries`` and ``customer_products`` rows are cleared, and any
location dedication to a product is reset to NULL, because the products they
referenced are being dropped.

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID


revision: str = "e0f1a2b3c4d5"
down_revision: str | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SEED_CATEGORIES = [
    ("Non-Custom Components / Materials", "purchased", "neutral"),
    ("Custom Components / Materials", "purchased", "warning"),
    ("Sub-Assemblies", "built", "accent"),
    ("Finished Goods – Engineering Products", "built", "success"),
    ("Finished Goods – Drug Product", "built", "danger"),
]
BACKFILL_CATEGORY = "Non-Custom Components / Materials"


def _audit_cols() -> list[sa.Column]:
    return [
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
    ]


def upgrade() -> None:
    # ── app.item_categories ────────────────────────────────────────────
    op.create_table(
        "item_categories",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "tone", sa.Text(), nullable=False, server_default=sa.text("'neutral'")
        ),
        sa.Column(
            "is_seeded",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        *_audit_cols(),
        # Nullable: seed rows are system-created (no user).
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_item_categories_created_by_user_id_users",
            ),
            nullable=True,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_item_categories_updated_by_user_id_users",
            ),
            nullable=True,
        ),
        sa.CheckConstraint(
            "char_length(trim(name)) > 0", name="ck_item_categories_name_not_blank"
        ),
        sa.CheckConstraint(
            "kind IN ('purchased', 'built')", name="ck_item_categories_kind"
        ),
        schema="app",
    )
    op.create_index(
        "uq_item_categories_name",
        "item_categories",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "ix_item_categories_updated_at_desc",
        "item_categories",
        [sa.text("updated_at DESC")],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_item_categories_touch_updated_at
        BEFORE UPDATE ON app.item_categories
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # Seed the five default categories (system-created).
    for name, kind, tone in SEED_CATEGORIES:
        op.execute(
            sa.text(
                "INSERT INTO app.item_categories (name, kind, tone, is_seeded) "
                "VALUES (:name, :kind, :tone, TRUE)"
            ).bindparams(name=name, kind=kind, tone=tone)
        )

    # ── app.items.category_id (nullable → backfill → NOT NULL) ─────────
    op.add_column(
        "items",
        sa.Column("category_id", UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.create_foreign_key(
        "fk_items_category_id_item_categories",
        "items",
        "item_categories",
        ["category_id"],
        ["id"],
        ondelete="RESTRICT",
        source_schema="app",
        referent_schema="app",
    )
    op.execute(
        sa.text(
            "UPDATE app.items SET category_id = "
            "(SELECT id FROM app.item_categories WHERE name = :name) "
            "WHERE category_id IS NULL"
        ).bindparams(name=BACKFILL_CATEGORY)
    )
    op.alter_column("items", "category_id", nullable=False, schema="app")
    op.create_index(
        "ix_items_category_id", "items", ["category_id"], schema="app"
    )

    # ── app.bom_lines (self-referencing BOM) ───────────────────────────
    op.create_table(
        "bom_lines",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "parent_item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_bom_lines_parent_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column(
            "child_item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_bom_lines_child_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column("qty_per_run", sa.Numeric(14, 3), nullable=False),
        *_audit_cols(),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_bom_lines_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_bom_lines_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.CheckConstraint(
            "parent_item_id <> child_item_id",
            name="ck_bom_lines_no_self_reference",
        ),
        sa.CheckConstraint(
            "qty_per_run > 0", name="ck_bom_lines_qty_per_run_positive"
        ),
        schema="app",
    )
    op.create_index(
        "uq_bom_lines_parent_child",
        "bom_lines",
        ["parent_item_id", "child_item_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "ix_bom_lines_parent_item_id", "bom_lines", ["parent_item_id"], schema="app"
    )
    op.create_index(
        "ix_bom_lines_child_item_id", "bom_lines", ["child_item_id"], schema="app"
    )
    op.execute(
        """
        CREATE TRIGGER tg_bom_lines_touch_updated_at
        BEFORE UPDATE ON app.bom_lines
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # ── app.customer_items (M2M), replacing customer_products ──────────
    op.create_table(
        "customer_items",
        sa.Column(
            "customer_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.customers.id",
                ondelete="CASCADE",
                name="fk_customer_items_customer_id_customers",
            ),
            primary_key=True,
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="CASCADE",
                name="fk_customer_items_item_id_items",
            ),
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_customer_items_created_by_user_id_users",
            ),
            nullable=False,
        ),
        schema="app",
    )
    op.create_index(
        "ix_customer_items_item_id", "customer_items", ["item_id"], schema="app"
    )
    op.drop_table("customer_products", schema="app")

    # ── Repoint forecast_entries.product_id → app.items (start fresh) ──
    op.execute("DELETE FROM app.forecast_entries")
    op.drop_constraint(
        "fk_forecast_entries_product_id_products",
        "forecast_entries",
        schema="app",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_forecast_entries_product_id_items",
        "forecast_entries",
        "items",
        ["product_id"],
        ["id"],
        ondelete="CASCADE",
        source_schema="app",
        referent_schema="app",
    )

    # ── Repoint location_nodes.dedicated_product_id → app.items ────────
    op.execute("UPDATE meta.location_nodes SET dedicated_product_id = NULL")
    op.drop_constraint(
        "fk_location_nodes_dedicated_product_id_products",
        "location_nodes",
        schema="meta",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_location_nodes_dedicated_product_id_items",
        "location_nodes",
        "items",
        ["dedicated_product_id"],
        ["id"],
        ondelete="RESTRICT",
        source_schema="meta",
        referent_schema="app",
    )

    # ── Retire products + product_materials ───────────────────────────
    op.execute(
        "DROP TRIGGER IF EXISTS tg_product_materials_touch_updated_at "
        "ON app.product_materials;"
    )
    op.drop_table("product_materials", schema="app")
    op.execute(
        "DROP TRIGGER IF EXISTS tg_products_touch_updated_at ON app.products;"
    )
    op.drop_table("products", schema="app")


def downgrade() -> None:
    # Recreate app.products (name + sku, as of head d9e0f1a2b3c4).
    op.create_table(
        "products",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        *_audit_cols(),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_products_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_products_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(trim(name)) > 0", name="ck_products_name_not_blank"
        ),
        schema="app",
    )
    op.create_index(
        "uq_products_name",
        "products",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "uq_products_sku",
        "products",
        [sa.text("lower(sku)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "ix_products_updated_at_desc",
        "products",
        [sa.text("updated_at DESC")],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_products_touch_updated_at
        BEFORE UPDATE ON app.products
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # Recreate app.product_materials.
    op.create_table(
        "product_materials",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "product_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.products.id",
                ondelete="RESTRICT",
                name="fk_product_materials_product_id_products",
            ),
            nullable=False,
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_product_materials_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column("qty_per_run", sa.Numeric(14, 3), nullable=False),
        *_audit_cols(),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_product_materials_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_product_materials_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.CheckConstraint(
            "qty_per_run > 0", name="ck_product_materials_qty_per_run_positive"
        ),
        schema="app",
    )
    op.create_index(
        "uq_product_materials_product_id_item_id",
        "product_materials",
        ["product_id", "item_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "ix_product_materials_product_id",
        "product_materials",
        ["product_id"],
        schema="app",
    )
    op.create_index(
        "ix_product_materials_item_id",
        "product_materials",
        ["item_id"],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_product_materials_touch_updated_at
        BEFORE UPDATE ON app.product_materials
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # Repoint location_nodes back to products.
    op.execute("UPDATE meta.location_nodes SET dedicated_product_id = NULL")
    op.drop_constraint(
        "fk_location_nodes_dedicated_product_id_items",
        "location_nodes",
        schema="meta",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_location_nodes_dedicated_product_id_products",
        "location_nodes",
        "products",
        ["dedicated_product_id"],
        ["id"],
        ondelete="RESTRICT",
        source_schema="meta",
        referent_schema="app",
    )

    # Repoint forecast_entries back to products.
    op.execute("DELETE FROM app.forecast_entries")
    op.drop_constraint(
        "fk_forecast_entries_product_id_items",
        "forecast_entries",
        schema="app",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_forecast_entries_product_id_products",
        "forecast_entries",
        "products",
        ["product_id"],
        ["id"],
        ondelete="CASCADE",
        source_schema="app",
        referent_schema="app",
    )

    # Recreate customer_products, drop customer_items.
    op.create_table(
        "customer_products",
        sa.Column(
            "customer_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.customers.id",
                ondelete="CASCADE",
                name="fk_customer_products_customer_id_customers",
            ),
            primary_key=True,
        ),
        sa.Column(
            "product_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.products.id",
                ondelete="CASCADE",
                name="fk_customer_products_product_id_products",
            ),
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_customer_products_created_by_user_id_users",
            ),
            nullable=False,
        ),
        schema="app",
    )
    op.create_index(
        "ix_customer_products_product_id",
        "customer_products",
        ["product_id"],
        schema="app",
    )
    op.drop_table("customer_items", schema="app")

    # Drop bom_lines.
    op.execute(
        "DROP TRIGGER IF EXISTS tg_bom_lines_touch_updated_at ON app.bom_lines;"
    )
    op.drop_table("bom_lines", schema="app")

    # Drop items.category_id.
    op.drop_index("ix_items_category_id", table_name="items", schema="app")
    op.drop_constraint(
        "fk_items_category_id_item_categories",
        "items",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("items", "category_id", schema="app")

    # Drop item_categories.
    op.execute(
        "DROP TRIGGER IF EXISTS tg_item_categories_touch_updated_at "
        "ON app.item_categories;"
    )
    op.drop_table("item_categories", schema="app")
