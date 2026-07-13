"""week1_reset_schema

WEEK-1 HARD RESET (2026-07-06). The data model is ~90% new, so this migration
drops the entire application schema and rebuilds it from the Week-1 ERD:

    DROP SCHEMA app  CASCADE   -- all prior tables/views/triggers/functions
    DROP SCHEMA meta CASCADE   -- suppliers, item_suppliers, location_nodes
    DROP SCHEMA audit CASCADE  -- audit_events, reauth_events, consumptions
    CREATE SCHEMA app          -- fresh, then create the six Week-1 tables

``alembic_version`` lives in the ``public`` schema (see alembic/env.py
``version_table_schema="public"``), so it is NOT touched by the drops — Alembic
keeps its bookmark and records this revision normally. ``public`` extensions
(citext / pgcrypto) survive too; they're re-ensured defensively.

Six tables, all in ``app``:
    users, locations, items, inventory_stock,
    inventory_transactions, inventory_transaction_lines

Deliberate deviations from the ERD (client decisions, 2026-07-06):
    * no ``roles`` table          -> ``users.role`` is a CHECK-constrained enum
    * no ``units_of_measure`` tbl -> ``unit_of_measure`` is a TEXT column
    * auth stays on Cognito       -> ``users.cognito_sub`` (no password_hash)

This is a one-way reset: ``downgrade`` is intentionally not implemented.

Revision ID: week1reset01
Revises: f7a8b9c0d1e2
Create Date: 2026-07-06 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "week1reset01"
down_revision: str | None = "f7a8b9c0d1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Keep these in lock-step with app.models (ROLES / ITEM_TIERS / TRANSACTION_TYPES).
ROLES = ("super_admin", "admin", "operator")
ITEM_TIERS = ("CR", "AY", "FG")
TRANSACTION_TYPES = ("RECEIPT", "TRANSFER", "RETURN", "ADJUSTMENT")


def _in_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    # ── Wipe the old world ────────────────────────────────────────────────
    # CASCADE handles every FK / view / trigger dependency in one shot, so we
    # don't have to order the drops. ``public`` (alembic_version + extensions)
    # is left alone.
    op.execute("DROP SCHEMA IF EXISTS app CASCADE")
    op.execute("DROP SCHEMA IF EXISTS meta CASCADE")
    op.execute("DROP SCHEMA IF EXISTS audit CASCADE")
    op.execute("CREATE SCHEMA app")

    # Re-ensure extensions (idempotent). citext backs users.email;
    # pgcrypto backs gen_random_uuid() defaults.
    op.execute('CREATE EXTENSION IF NOT EXISTS "citext"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')

    # Shared updated_at trigger function (dropped with schema app above).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION app.tg_touch_updated_at()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $$;
        """
    )

    # ── app.users ─────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("cognito_sub", sa.Text(), nullable=False),
        sa.Column("email", CITEXT(), nullable=False),
        sa.Column("first_name", sa.Text(), nullable=False),
        sa.Column("last_name", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")
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
        sa.CheckConstraint(f"role IN ({_in_list(ROLES)})", name="ck_users_role"),
        schema="app",
    )
    op.create_index(
        "uq_users_cognito_sub", "users", ["cognito_sub"], unique=True, schema="app"
    )
    op.create_index(
        "uq_users_email",
        "users",
        [sa.text("lower(email)")],
        unique=True,
        schema="app",
    )

    # ── app.locations ─────────────────────────────────────────────────────
    op.create_table(
        "locations",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("location_code", sa.Text(), nullable=False),
        sa.Column("location_name", sa.Text(), nullable=False),
        sa.Column(
            "parent_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.locations.id",
                ondelete="RESTRICT",
                name="fk_locations_parent_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column("location_type", sa.Text(), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")
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
        schema="app",
    )
    op.create_index(
        "uq_locations_location_code",
        "locations",
        [sa.text("lower(location_code)")],
        unique=True,
        schema="app",
    )
    op.create_index(
        "ix_locations_parent_location_id",
        "locations",
        ["parent_location_id"],
        schema="app",
    )
    op.create_index(
        "ix_locations_is_active", "locations", ["is_active"], schema="app"
    )

    # ── app.items ─────────────────────────────────────────────────────────
    op.create_table(
        "items",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("item_code", sa.Text(), nullable=False),
        sa.Column("item_name", sa.Text(), nullable=False),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column(
            "is_consumable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        sa.Column("unit_of_measure", sa.Text(), nullable=False),
        sa.Column(
            "default_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.locations.id",
                ondelete="SET NULL",
                name="fk_items_default_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column(
            "track_expiry",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")
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
        sa.CheckConstraint(f"tier IN ({_in_list(ITEM_TIERS)})", name="ck_items_tier"),
        schema="app",
    )
    op.create_index(
        "uq_items_item_code",
        "items",
        [sa.text("lower(item_code)")],
        unique=True,
        schema="app",
    )
    op.create_index("ix_items_tier", "items", ["tier"], schema="app")
    op.create_index("ix_items_is_active", "items", ["is_active"], schema="app")

    # ── app.inventory_stock ───────────────────────────────────────────────
    op.create_table(
        "inventory_stock",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_inventory_stock_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column(
            "location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.locations.id",
                ondelete="RESTRICT",
                name="fk_inventory_stock_location_id_locations",
            ),
            nullable=False,
        ),
        sa.Column("lot_number", sa.Text(), nullable=True),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column(
            "quantity_available",
            sa.Numeric(14, 3),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("unit_of_measure", sa.Text(), nullable=False),
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
        sa.CheckConstraint(
            "quantity_available >= 0", name="ck_inventory_stock_qty_nonneg"
        ),
        schema="app",
    )
    op.create_index(
        "ix_inventory_stock_item_id", "inventory_stock", ["item_id"], schema="app"
    )
    op.create_index(
        "ix_inventory_stock_location_id",
        "inventory_stock",
        ["location_id"],
        schema="app",
    )
    op.create_index(
        "ix_inventory_stock_expiry_date",
        "inventory_stock",
        ["expiry_date"],
        postgresql_where=sa.text("expiry_date IS NOT NULL"),
        schema="app",
    )
    op.create_index(
        "uq_inventory_stock_item_location_lot",
        "inventory_stock",
        ["item_id", "location_id", sa.text("COALESCE(lot_number, '')")],
        unique=True,
        schema="app",
    )

    # ── app.inventory_transactions ────────────────────────────────────────
    op.create_table(
        "inventory_transactions",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("transaction_no", sa.Text(), nullable=False),
        sa.Column("transaction_type", sa.Text(), nullable=False),
        sa.Column(
            "transaction_date",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_inventory_transactions_created_by_users",
            ),
            nullable=False,
        ),
        sa.Column("reference_no", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            f"transaction_type IN ({_in_list(TRANSACTION_TYPES)})",
            name="ck_inventory_transactions_type",
        ),
        schema="app",
    )
    op.create_index(
        "uq_inventory_transactions_transaction_no",
        "inventory_transactions",
        ["transaction_no"],
        unique=True,
        schema="app",
    )
    op.create_index(
        "ix_inventory_transactions_type",
        "inventory_transactions",
        ["transaction_type"],
        schema="app",
    )
    op.create_index(
        "ix_inventory_transactions_transaction_date_desc",
        "inventory_transactions",
        [sa.text("transaction_date DESC")],
        schema="app",
    )
    op.create_index(
        "ix_inventory_transactions_created_by",
        "inventory_transactions",
        ["created_by"],
        schema="app",
    )

    # ── app.inventory_transaction_lines ───────────────────────────────────
    op.create_table(
        "inventory_transaction_lines",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "transaction_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.inventory_transactions.id",
                ondelete="CASCADE",
                name="fk_inv_txn_lines_transaction_id",
            ),
            nullable=False,
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_inventory_transaction_lines_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column(
            "from_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.locations.id",
                ondelete="RESTRICT",
                name="fk_inventory_transaction_lines_from_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column(
            "to_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.locations.id",
                ondelete="RESTRICT",
                name="fk_inventory_transaction_lines_to_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column("lot_number", sa.Text(), nullable=True),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column("quantity", sa.Numeric(14, 3), nullable=False),
        sa.Column("unit_of_measure", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "quantity > 0", name="ck_inventory_transaction_lines_qty_pos"
        ),
        sa.CheckConstraint(
            "from_location_id IS NOT NULL OR to_location_id IS NOT NULL",
            name="ck_inventory_transaction_lines_has_location",
        ),
        schema="app",
    )
    op.create_index(
        "ix_inventory_transaction_lines_transaction_id",
        "inventory_transaction_lines",
        ["transaction_id"],
        schema="app",
    )
    op.create_index(
        "ix_inventory_transaction_lines_item_id",
        "inventory_transaction_lines",
        ["item_id"],
        schema="app",
    )
    op.create_index(
        "ix_inventory_transaction_lines_from_location_id",
        "inventory_transaction_lines",
        ["from_location_id"],
        schema="app",
    )
    op.create_index(
        "ix_inventory_transaction_lines_to_location_id",
        "inventory_transaction_lines",
        ["to_location_id"],
        schema="app",
    )

    # ── updated_at triggers (tables that carry updated_at) ────────────────
    for tbl in ("users", "locations", "items", "inventory_stock"):
        op.execute(
            f"""
            CREATE TRIGGER tg_{tbl}_touch_updated_at
            BEFORE UPDATE ON app.{tbl}
            FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
            """
        )


def downgrade() -> None:
    raise NotImplementedError(
        "week1_reset_schema is a one-way hard reset; there is no downgrade."
    )
