"""forecast_entries

Forecast module — planned production runs (product × customer × month).

* ``app.forecast_entries`` — one planning cell: for a ``product`` (optionally a
  ``customer``) in a given ``forecast_year`` + ``forecast_month`` (1-12), the
  number of production ``runs`` planned. Mirrors the SOT workbook "MFG Schedule
  and Forecast by Customer and Product (Runs)".

High-churn planning data, so — unlike the rest of ``app`` — these rows are NOT
soft-deleted: clearing a cell hard-deletes the row, and the upsert key is a
plain ``UNIQUE NULLS NOT DISTINCT (customer_id, product_id, forecast_year,
forecast_month)``. ``customer_id`` is nullable (NULL = product-level /
"Unassigned"). FKs to products/customers cascade (like ``customer_products``);
FKs to ``app.users`` restrict (audit). Uses the shared
``app.tg_touch_updated_at`` trigger.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "f6a7b8c9d0e1"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "forecast_entries",
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
                ondelete="CASCADE",
                name="fk_forecast_entries_product_id_products",
            ),
            nullable=False,
        ),
        # Optional — NULL = a product-level ("Unassigned") forecast.
        sa.Column(
            "customer_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.customers.id",
                ondelete="CASCADE",
                name="fk_forecast_entries_customer_id_customers",
            ),
            nullable=True,
        ),
        sa.Column("forecast_year", sa.Integer(), nullable=False),
        sa.Column("forecast_month", sa.Integer(), nullable=False),
        sa.Column("runs", sa.Integer(), nullable=False),
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
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_forecast_entries_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_forecast_entries_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        # One row per (customer-or-none, product, year, month). NULLS NOT
        # DISTINCT so a customer-less cell can't be duplicated.
        sa.UniqueConstraint(
            "customer_id",
            "product_id",
            "forecast_year",
            "forecast_month",
            name="uq_forecast_entries_cust_prod_year_month",
            postgresql_nulls_not_distinct=True,
        ),
        sa.CheckConstraint(
            "forecast_month BETWEEN 1 AND 12",
            name="ck_forecast_entries_month_range",
        ),
        sa.CheckConstraint(
            "forecast_year BETWEEN 2000 AND 2100",
            name="ck_forecast_entries_year_range",
        ),
        sa.CheckConstraint("runs > 0", name="ck_forecast_entries_runs_positive"),
        schema="app",
    )
    op.create_index(
        "ix_forecast_entries_forecast_year",
        "forecast_entries",
        ["forecast_year"],
        schema="app",
    )
    op.create_index(
        "ix_forecast_entries_product_id",
        "forecast_entries",
        ["product_id"],
        schema="app",
    )
    op.create_index(
        "ix_forecast_entries_customer_id",
        "forecast_entries",
        ["customer_id"],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_forecast_entries_touch_updated_at
        BEFORE UPDATE ON app.forecast_entries
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS tg_forecast_entries_touch_updated_at "
        "ON app.forecast_entries;"
    )
    op.drop_table("forecast_entries", schema="app")
