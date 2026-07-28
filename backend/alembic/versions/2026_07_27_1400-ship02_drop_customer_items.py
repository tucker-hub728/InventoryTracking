"""ship02: drop app.customer_items (customers are no longer linked to items)

Per the client's "Customers / Vendor List" note, customers must NOT be linked to
inventory items — the part number is the source of truth for inventory identity.
The many-to-many link table is removed; a shipment names a customer at ship time
instead. Pure master-data / link removal — no stock data is affected.

Revision ID: ship02
Revises: ship01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "ship02"
down_revision: str | None = "ship01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_customer_items_item_id", table_name="customer_items", schema="app")
    op.drop_table("customer_items", schema="app")


def downgrade() -> None:
    op.create_table(
        "customer_items",
        sa.Column("customer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["app.customers.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["item_id"], ["app.items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["app.users.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("customer_id", "item_id"),
        schema="app",
    )
    op.create_index(
        "ix_customer_items_item_id", "customer_items", ["item_id"], schema="app"
    )
