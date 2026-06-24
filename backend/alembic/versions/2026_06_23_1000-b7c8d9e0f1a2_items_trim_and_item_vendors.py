"""items_trim_and_item_vendors

Items refactor (user request 2026-06-23):

  1. New ``meta.item_vendors`` — a plain many-to-many list of the vendors
     assigned to an item (replaces ``meta.item_approved_vendors``). No
     ``approval_status`` / ``pending`` concept: an item's vendors simply ARE
     the vendors it can be received against. Backfilled, for live (non
     soft-deleted) items only, from the union of the old single
     ``items.vendor_id`` and the ``item_approved_vendors`` rows so existing
     associations carry over.

  2. Drop the now-unused / superseded ``app.items`` columns:
       * ``vendor_id``                — replaced by ``meta.item_vendors``
       * ``uom_code``                 — UOM removed entirely
       * ``category``                 — unused
       * ``po_note`` / ``po_due_text``— unused
       * ``notes``                    — unused
       * ``metadata_``                — unused
       * ``unit_price_amount``        — pricing now lives on the lot
       * ``units_per_package``        — unused
       * ``price_per_package_amount`` — derived from the removed price fields

  3. Drop ``meta.item_approved_vendors`` (superseded by ``item_vendors``) and
     ``meta.units_of_measure`` (UOM removed; nothing FKs it anymore).

Inventory $ and on-order $ are now computed from the lot's ``unit_price_amount``
(see the inventory routes), so ``items.unit_price_amount`` is no longer the
source of valuation.

Reversible. The downgrade recreates the dropped columns / tables (without the
original data — it is data-lossy) so the schema round-trips. **Not auto-applied.**

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = "b7c8d9e0f1a2"
down_revision: str | None = "a6b7c8d9e0f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Re-used by the downgrade to restore ``meta.units_of_measure`` seed rows.
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

# Dropped ``app.items`` columns, in the order the downgrade re-adds them.
_DROPPED_ITEM_COLUMNS = (
    "category",
    "vendor_id",
    "unit_price_amount",
    "units_per_package",
    "price_per_package_amount",
    "uom_code",
    "po_note",
    "po_due_text",
    "notes",
    "metadata_",
)


def upgrade() -> None:
    # 1) meta.item_vendors — plain item↔vendor assignment list.
    op.create_table(
        "item_vendors",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("item_id", UUID(as_uuid=True), nullable=False),
        sa.Column("vendor_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_user_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_item_vendors_item_id_items",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["meta.vendors.id"],
            name="fk_item_vendors_vendor_id_vendors",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app.users.id"],
            name="fk_item_vendors_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "item_id", "vendor_id", name="uq_item_vendors_item_vendor"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_item_vendors"),
        schema="meta",
    )
    op.create_index(
        "ix_item_vendors_item_id", "item_vendors", ["item_id"], schema="meta"
    )
    op.create_index(
        "ix_item_vendors_vendor_id", "item_vendors", ["vendor_id"], schema="meta"
    )

    # 2) Backfill from the union of the old single default vendor and the
    #    approved-vendor mappings. ON CONFLICT dedups the overlap.
    op.execute(
        """
        INSERT INTO meta.item_vendors (item_id, vendor_id, created_by_user_id)
        SELECT i.id, i.vendor_id, i.created_by_user_id
        FROM app.items i
        WHERE i.vendor_id IS NOT NULL
          AND i.deleted_at IS NULL
        ON CONFLICT (item_id, vendor_id) DO NOTHING;
        """
    )
    op.execute(
        """
        INSERT INTO meta.item_vendors (item_id, vendor_id, created_by_user_id)
        SELECT iav.item_id, iav.vendor_id, iav.created_by_user_id
        FROM meta.item_approved_vendors iav
        JOIN app.items i ON i.id = iav.item_id
        WHERE i.deleted_at IS NULL
        ON CONFLICT (item_id, vendor_id) DO NOTHING;
        """
    )

    # 3) Drop the item-column FKs / index that block the column drops.
    op.drop_constraint(
        "fk_items_uom_code_units_of_measure",
        "items",
        schema="app",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_items_vendor_id_vendors",
        "items",
        schema="app",
        type_="foreignkey",
    )
    op.drop_index("ix_items_vendor_id", table_name="items", schema="app")

    # 4) Drop the superseded / unused item columns. ``ck_items_unit_price_nonneg``
    #    is dropped automatically with ``unit_price_amount``.
    for col in _DROPPED_ITEM_COLUMNS:
        op.drop_column("items", col, schema="app")

    # 5) Drop the old approved-vendor mapping (replaced by item_vendors).
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

    # 6) Drop the unit-of-measure lookup — nothing references it anymore.
    op.drop_table("units_of_measure", schema="meta")


def downgrade() -> None:
    # 6) Recreate meta.units_of_measure (+ seed).
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

    # 5) Recreate meta.item_approved_vendors (+ indexes).
    op.create_table(
        "item_approved_vendors",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("item_id", UUID(as_uuid=True), nullable=False),
        sa.Column("vendor_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "approval_status",
            sa.Text(),
            server_default=sa.text("'approved'"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", UUID(as_uuid=True), nullable=False),
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

    # 4) Re-add the dropped item columns.
    op.add_column(
        "items", sa.Column("category", sa.Text(), nullable=True), schema="app"
    )
    op.add_column(
        "items",
        sa.Column("vendor_id", UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column("unit_price_amount", sa.Numeric(14, 2), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column("units_per_package", sa.Integer(), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column("price_per_package_amount", sa.Numeric(14, 2), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column(
            "uom_code",
            sa.Text(),
            server_default=sa.text("'unit'"),
            nullable=False,
        ),
        schema="app",
    )
    op.add_column(
        "items", sa.Column("po_note", sa.Text(), nullable=True), schema="app"
    )
    op.add_column(
        "items", sa.Column("po_due_text", sa.Text(), nullable=True), schema="app"
    )
    op.add_column(
        "items", sa.Column("notes", sa.Text(), nullable=True), schema="app"
    )
    op.add_column(
        "items",
        sa.Column(
            "metadata_",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
            key="metadata_",
        ),
        schema="app",
    )

    # Restore the FKs / index / check the columns originally carried.
    op.create_foreign_key(
        "fk_items_vendor_id_vendors",
        "items",
        "vendors",
        ["vendor_id"],
        ["id"],
        source_schema="app",
        referent_schema="meta",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_items_uom_code_units_of_measure",
        "items",
        "units_of_measure",
        ["uom_code"],
        ["code"],
        source_schema="app",
        referent_schema="meta",
        ondelete="RESTRICT",
    )
    op.create_index("ix_items_vendor_id", "items", ["vendor_id"], schema="app")
    op.create_check_constraint(
        "ck_items_unit_price_nonneg",
        "items",
        "unit_price_amount IS NULL OR unit_price_amount >= 0",
        schema="app",
    )

    # 1) Drop meta.item_vendors.
    op.drop_index(
        "ix_item_vendors_vendor_id", table_name="item_vendors", schema="meta"
    )
    op.drop_index(
        "ix_item_vendors_item_id", table_name="item_vendors", schema="meta"
    )
    op.drop_table("item_vendors", schema="meta")
