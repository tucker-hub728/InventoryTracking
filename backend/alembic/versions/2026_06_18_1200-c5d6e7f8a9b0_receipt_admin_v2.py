"""receipt_admin_v2

Requirements v2 (Receipt Admin). Adds, in dependency order:

  1. ``app.items.category``                  — free-form optional label
  2. ``app.receipt_transactions``            — inbound event header
  3. ``meta.item_approved_vendors``          — zero-or-more approved vendors/item
  4. ``app.lots`` columns:
       * ``unit_price_amount``               — price paid (lot = source of truth)
       * ``po_reference``                    — manual PO text
       * ``metadata_`` (JSONB)               — unverified/unassociated flags
       * ``receipt_transaction_id``          — FK → receipt_transactions
       * ``parent_lot_id``                   — split lineage (self-FK)

Quantity is intentionally NOT added to ``lots`` — it stays ledger-derived
(``app.stock_movements``). See docs/modules/receipt-admin.md.

Reversible. The downgrade drops everything in the reverse order. It is
data-lossy for the new columns/tables but functional.

Revision ID: c5d6e7f8a9b0
Revises: f4a5b6c7d8e9
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "c5d6e7f8a9b0"
down_revision: str | None = "f4a5b6c7d8e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1) items.category — free-form, optional, no lookup / no CHECK.
    op.add_column(
        "items",
        sa.Column("category", sa.Text(), nullable=True),
        schema="app",
    )

    # 2) app.receipt_transactions — inbound event header.
    op.create_table(
        "receipt_transactions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            server_default=sa.text("'open'"),
            nullable=False,
        ),
        sa.Column("po_reference", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "received_by_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
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
            ["item_id"],
            ["app.items.id"],
            name="fk_receipt_transactions_item_id_items",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_receipt_transactions_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["received_by_user_id"],
            ["app.users.id"],
            name="fk_receipt_transactions_received_by_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "status IN ('open', 'received', 'cancelled')",
            name="ck_receipt_transactions_status",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_receipt_transactions"),
        schema="app",
    )
    op.create_index(
        "ix_receipt_transactions_item_id",
        "receipt_transactions",
        ["item_id"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_transactions_status",
        "receipt_transactions",
        ["status"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_transactions_created_at_desc",
        "receipt_transactions",
        [sa.text("created_at DESC")],
        schema="app",
    )

    # 3) meta.item_approved_vendors — approved-vendor mapping.
    op.create_table(
        "item_approved_vendors",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("vendor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "approval_status",
            sa.Text(),
            server_default=sa.text("'approved'"),
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
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_item_approved_vendors_item_id_items",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["meta.vendors.id"],
            name="fk_item_approved_vendors_vendor_id_vendors",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_item_approved_vendors_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "approval_status IN ('approved', 'pending')",
            name="ck_item_approved_vendors_status",
        ),
        sa.UniqueConstraint(
            "item_id", "vendor_id", name="uq_item_approved_vendors_item_vendor"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_item_approved_vendors"),
        schema="meta",
    )
    op.create_index(
        "ix_item_approved_vendors_item_id",
        "item_approved_vendors",
        ["item_id"],
        schema="meta",
    )
    op.create_index(
        "ix_item_approved_vendors_vendor_id",
        "item_approved_vendors",
        ["vendor_id"],
        schema="meta",
    )

    # 4) app.lots — per-lot price / PO / flags / lineage.
    op.add_column(
        "lots",
        sa.Column("unit_price_amount", sa.Numeric(14, 2), nullable=True),
        schema="app",
    )
    op.add_column(
        "lots",
        sa.Column("po_reference", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "lots",
        sa.Column(
            "metadata_",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        schema="app",
    )
    op.add_column(
        "lots",
        sa.Column(
            "receipt_transaction_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        schema="app",
    )
    op.add_column(
        "lots",
        sa.Column("parent_lot_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.create_foreign_key(
        "fk_lots_receipt_transaction_id_receipt_transactions",
        "lots",
        "receipt_transactions",
        ["receipt_transaction_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_lots_parent_lot_id_lots",
        "lots",
        "lots",
        ["parent_lot_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_lots_receipt_transaction_id",
        "lots",
        ["receipt_transaction_id"],
        schema="app",
        postgresql_where=sa.text("receipt_transaction_id IS NOT NULL"),
    )
    op.create_index(
        "ix_lots_parent_lot_id",
        "lots",
        ["parent_lot_id"],
        schema="app",
        postgresql_where=sa.text("parent_lot_id IS NOT NULL"),
    )


def downgrade() -> None:
    # Reverse order: lot columns first (they FK receipt_transactions), then
    # the new tables, then items.category.
    op.drop_index("ix_lots_parent_lot_id", table_name="lots", schema="app")
    op.drop_index(
        "ix_lots_receipt_transaction_id", table_name="lots", schema="app"
    )
    op.drop_constraint(
        "fk_lots_parent_lot_id_lots", "lots", schema="app", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_lots_receipt_transaction_id_receipt_transactions",
        "lots",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("lots", "parent_lot_id", schema="app")
    op.drop_column("lots", "receipt_transaction_id", schema="app")
    op.drop_column("lots", "metadata_", schema="app")
    op.drop_column("lots", "po_reference", schema="app")
    op.drop_column("lots", "unit_price_amount", schema="app")

    op.drop_index(
        "ix_item_approved_vendors_vendor_id",
        table_name="item_approved_vendors",
        schema="meta",
    )
    op.drop_index(
        "ix_item_approved_vendors_item_id",
        table_name="item_approved_vendors",
        schema="meta",
    )
    op.drop_table("item_approved_vendors", schema="meta")

    op.drop_index(
        "ix_receipt_transactions_created_at_desc",
        table_name="receipt_transactions",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_transactions_status",
        table_name="receipt_transactions",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_transactions_item_id",
        table_name="receipt_transactions",
        schema="app",
    )
    op.drop_table("receipt_transactions", schema="app")

    op.drop_column("items", "category", schema="app")
