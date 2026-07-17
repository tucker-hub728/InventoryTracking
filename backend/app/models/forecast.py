"""Forecast-module ORM — planned production runs (product × customer × month).

A **forecast entry** is one planning cell from the SOT workbook ("MFG Schedule
and Forecast by Customer and Product (Runs)"): for a product — optionally tied
to a customer — in a given ``year`` + ``month``, how many production *runs* are
planned.

Unlike the rest of the app these rows are **not** soft-deleted: forecast cells
are high-churn planning numbers, so clearing a cell hard-deletes the row.
``customer_id`` is optional (``NULL`` = a product-level / "Unassigned" forecast).
One row per (customer-or-none, product, year, month), enforced by a
``UNIQUE NULLS NOT DISTINCT`` constraint so a customer-less cell still collapses
to a single row.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.inventory import Item
from app.models.products import Customer


class ForecastEntry(Base):
    """One planned production volume: product × (customer?) × month → runs."""

    __tablename__ = "forecast_entries"
    __table_args__ = (
        # NULLS NOT DISTINCT (Postgres 15+) so a customer-less cell still has
        # exactly one row per (product, year, month).
        UniqueConstraint(
            "customer_id",
            "product_id",
            "forecast_year",
            "forecast_month",
            name="uq_forecast_entries_cust_prod_year_month",
            postgresql_nulls_not_distinct=True,
        ),
        Index("ix_forecast_entries_forecast_year", "forecast_year"),
        Index("ix_forecast_entries_product_id", "product_id"),
        Index("ix_forecast_entries_customer_id", "customer_id"),
        CheckConstraint(
            "forecast_month BETWEEN 1 AND 12",
            name="ck_forecast_entries_month_range",
        ),
        CheckConstraint(
            "forecast_year BETWEEN 2000 AND 2100",
            name="ck_forecast_entries_year_range",
        ),
        CheckConstraint("runs > 0", name="ck_forecast_entries_runs_positive"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    # The forecasted finished good — a *built* tier item (enforced in the
    # route). Column name kept as ``product_id`` for continuity.
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Optional: NULL = a product-level ("Unassigned") forecast.
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.customers.id", ondelete="CASCADE"),
        nullable=True,
    )
    forecast_year: Mapped[int] = mapped_column(Integer, nullable=False)
    forecast_month: Mapped[int] = mapped_column(Integer, nullable=False)  # 1..12
    runs: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    updated_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )

    # Eager-joined so a read hydrates the finished good (item_number/description)
    # in one query. ``customer`` is optional. ``product`` keeps its name but now
    # points at the unified Item.
    product: Mapped[Item] = relationship(
        foreign_keys=[product_id], lazy="joined", viewonly=True
    )
    customer: Mapped[Customer | None] = relationship(
        foreign_keys=[customer_id], lazy="joined", viewonly=True
    )
