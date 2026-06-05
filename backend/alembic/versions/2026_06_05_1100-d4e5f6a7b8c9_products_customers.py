"""products_customers

Week-2 Product module (revised). Replaces the earlier skus/bom_lines design.

* ``app.products`` — a sellable/buildable finished good. Just a name
  (identified by UUID; no human SKU code). Soft-deleted via ``deleted_at``,
  name unique among live rows.
* ``app.product_materials`` — the bill of materials: a product consumes
  ``qty_per_run`` of an inventory ``item``. Unique per ``(product, item)``
  among live rows.
* ``app.customers`` — a customer (name, contact person, email).
* ``app.customer_products`` — many-to-many link between customers and
  products (the customer's linked products).

Inventory ``items`` are unchanged (raw materials/components). Follows the
vendor/lot conventions: UUID PKs, audit columns → ``app.users``, the shared
``app.tg_touch_updated_at`` trigger, partial-unique indexes that ignore
soft-deleted rows.

Revision ID: d4e5f6a7b8c9
Revises: b2c3d4e5f6a7
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID


revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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
    # ── app.products ───────────────────────────────────────────────────
    op.create_table(
        "products",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
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

    # ── app.customers ──────────────────────────────────────────────────
    op.create_table(
        "customers",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("contact_person", sa.Text(), nullable=True),
        sa.Column("email", CITEXT(), nullable=True),
        *_audit_cols(),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_customers_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_customers_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(trim(name)) > 0", name="ck_customers_name_not_blank"
        ),
        schema="app",
    )
    op.create_index(
        "uq_customers_name",
        "customers",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    op.create_index(
        "ix_customers_updated_at_desc",
        "customers",
        [sa.text("updated_at DESC")],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_customers_touch_updated_at
        BEFORE UPDATE ON app.customers
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # ── app.product_materials (BOM) ────────────────────────────────────
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

    # ── app.customer_products (M2M link) ───────────────────────────────
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


def downgrade() -> None:
    op.drop_table("customer_products", schema="app")
    op.execute(
        "DROP TRIGGER IF EXISTS tg_product_materials_touch_updated_at "
        "ON app.product_materials;"
    )
    op.drop_table("product_materials", schema="app")
    op.execute(
        "DROP TRIGGER IF EXISTS tg_customers_touch_updated_at ON app.customers;"
    )
    op.drop_table("customers", schema="app")
    op.execute(
        "DROP TRIGGER IF EXISTS tg_products_touch_updated_at ON app.products;"
    )
    op.drop_table("products", schema="app")
