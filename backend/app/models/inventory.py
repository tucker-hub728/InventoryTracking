"""Inventory ORM — items, stock balances, and transactions.

Week-1 reset (2026-07-06). Four tables, all in the ``app`` schema, matching
the Week-1 ERD:

* :class:`Item` — the catalogue row. ``tier`` distinguishes CR / AY / FG;
  only CR is created in Week 1, but the CHECK admits all three so AY/FG can
  be added later without a migration (the "foundation for future tiers").
  ``unit_of_measure`` is a plain string (no UOM table).
* :class:`InventoryStock` — on-hand quantity per item per location, with an
  optional receipt-time lot number and expiration date.
* :class:`InventoryTransaction` / :class:`InventoryTransactionLine` — the
  terminal record of stock entering / moving (Receipt / Transfer now;
  Return / Adjustment reserved in the enum).

Lots are NOT traced through to finished goods (REQ-2026-07-01-TRC-*): the
lot number is a receipt-time reference captured on stock + lines only.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.identity import User
from app.models.locations import Location

# Item tiers. CR = raw material (Week 1), AY = sub-assembly, FG = finished
# good. All three are values of the native ``app.item_tier`` enum so the later
# tiers need no schema change; Week-1 code only writes CR.
ITEM_TIERS: tuple[str, ...] = ("CR", "AY", "FG")

# ``create_type=False`` — the migration owns the enum type; the ORM references it.
item_tier_enum = ENUM(*ITEM_TIERS, name="item_tier", schema="app", create_type=False)

# Transaction types. Receipt + Transfer are built in Week 1; Return +
# Adjustment are reserved in the enum as the DB foundation.
TRANSACTION_TYPES: tuple[str, ...] = ("RECEIPT", "TRANSFER", "RETURN", "ADJUSTMENT")


class Item(Base):
    """Catalogue row. One per SKU, differentiated by ``tier``."""

    __tablename__ = "items"
    __table_args__ = (
        Index(
            "uq_items_item_code",
            func.lower(text("item_code")),
            unique=True,
        ),
        Index("ix_items_tier", "tier"),
        Index("ix_items_is_active", "is_active"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    item_code: Mapped[str] = mapped_column(Text, nullable=False)
    item_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Optional free-text description (added week 2). Nullable — pre-existing
    # rows and consumables without a blurb simply carry NULL.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tier: Mapped[str] = mapped_column(item_tier_enum, nullable=False)
    is_consumable: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("FALSE"),
    )
    # Plain string, e.g. 'each' / 'box' / 'mL' — no UOM lookup table.
    unit_of_measure: Mapped[str] = mapped_column(Text, nullable=False)
    default_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.locations.id", ondelete="SET NULL"),
        nullable=True,
    )
    track_expiry: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("FALSE"),
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("TRUE"),
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    default_location: Mapped[Location | None] = relationship(
        foreign_keys=[default_location_id],
        lazy="joined",
        viewonly=True,
    )


class InventoryStock(Base):
    """On-hand balance of one item at one location (optionally one lot)."""

    __tablename__ = "inventory_stock"
    __table_args__ = (
        Index("ix_inventory_stock_item_id", "item_id"),
        Index("ix_inventory_stock_location_id", "location_id"),
        Index(
            "ix_inventory_stock_expiry_date",
            "expiry_date",
            postgresql_where=text("expiry_date IS NOT NULL"),
        ),
        # One balance row per (item, location, lot). A NULL lot is a distinct
        # bucket; enforced with COALESCE so lot-less stock still de-duplicates.
        Index(
            "uq_inventory_stock_item_location_lot",
            "item_id",
            "location_id",
            text("COALESCE(lot_number, '')"),
            unique=True,
        ),
        CheckConstraint(
            "quantity_available >= 0",
            name="ck_inventory_stock_qty_nonneg",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.locations.id", ondelete="RESTRICT"),
        nullable=False,
    )
    lot_number: Mapped[str | None] = mapped_column(Text, nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    quantity_available: Mapped[Decimal] = mapped_column(
        Numeric(14, 3),
        nullable=False,
        server_default=text("0"),
    )
    unit_of_measure: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    location: Mapped[Location] = relationship(lazy="joined", viewonly=True)


class InventoryTransaction(Base):
    """Header for one stock movement (Receipt / Transfer / Return / Adjustment)."""

    __tablename__ = "inventory_transactions"
    __table_args__ = (
        Index("uq_inventory_transactions_transaction_no", "transaction_no", unique=True),
        Index("ix_inventory_transactions_type", "transaction_type"),
        Index(
            "ix_inventory_transactions_transaction_date_desc",
            text("transaction_date DESC"),
        ),
        Index("ix_inventory_transactions_created_by", "created_by"),
        CheckConstraint(
            "transaction_type IN ("
            + ", ".join(f"'{t}'" for t in TRANSACTION_TYPES)
            + ")",
            name="ck_inventory_transactions_type",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    transaction_no: Mapped[str] = mapped_column(Text, nullable=False)
    transaction_type: Mapped[str] = mapped_column(Text, nullable=False)
    transaction_date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    reference_no: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    created_by_user: Mapped[User] = relationship(
        foreign_keys=[created_by],
        lazy="joined",
        viewonly=True,
    )
    lines: Mapped[list[InventoryTransactionLine]] = relationship(
        back_populates="transaction",
        order_by="InventoryTransactionLine.created_at",
        viewonly=True,
    )


class InventoryTransactionLine(Base):
    """One item line on a transaction.

    ``from_location_id`` / ``to_location_id`` express direction:
      * Receipt  — ``to`` set, ``from`` NULL (stock in)
      * Transfer — both set (out of ``from`` into ``to``)
      * Return   — ``to`` set (stock back in)
      * Adjustment — one side set depending on sign
    """

    __tablename__ = "inventory_transaction_lines"
    __table_args__ = (
        Index("ix_inventory_transaction_lines_transaction_id", "transaction_id"),
        Index("ix_inventory_transaction_lines_item_id", "item_id"),
        Index("ix_inventory_transaction_lines_from_location_id", "from_location_id"),
        Index("ix_inventory_transaction_lines_to_location_id", "to_location_id"),
        CheckConstraint("quantity > 0", name="ck_inventory_transaction_lines_qty_pos"),
        CheckConstraint(
            "from_location_id IS NOT NULL OR to_location_id IS NOT NULL",
            name="ck_inventory_transaction_lines_has_location",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.inventory_transactions.id",
            ondelete="CASCADE",
            name="fk_inv_txn_lines_transaction_id",
        ),
        nullable=False,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    from_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    to_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    lot_number: Mapped[str | None] = mapped_column(Text, nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    unit_of_measure: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    transaction: Mapped[InventoryTransaction] = relationship(
        back_populates="lines",
        viewonly=True,
    )
    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    from_location: Mapped[Location | None] = relationship(
        foreign_keys=[from_location_id], lazy="joined", viewonly=True
    )
    to_location: Mapped[Location | None] = relationship(
        foreign_keys=[to_location_id], lazy="joined", viewonly=True
    )
