"""Product-module ORM — products, their materials (BOM), customers, links.

A **product** is a sellable/buildable finished good, identified by its UUID
primary key + a name (no human SKU code). Its bill of materials —
``product_materials`` — lists the inventory ``items`` consumed per
production run. **Customers** link to products many-to-many via
``customer_products``.

Inventory ``items`` stay the raw materials/components (unchanged). Schema +
constraints mirror the ``products_customers`` migration 1:1 and follow the
``app.models.inventory`` conventions (UUID PKs, ``deleted_at`` soft-delete,
audit columns, view-only joined relationships).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.inventory import Item


class Product(Base):
    """A finished good built from inventory items via its BOM.

    Minimal by design: just a name. Materials live on
    :class:`ProductMaterial`; customer links on :class:`CustomerProduct`.
    """

    __tablename__ = "products"
    __table_args__ = (
        Index(
            "uq_products_name",
            func.lower(text("name")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(
            "uq_products_sku",
            func.lower(text("sku")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_products_updated_at_desc", text("updated_at DESC")),
        CheckConstraint(
            "char_length(trim(name)) > 0",
            name="ck_products_name_not_blank",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Unique code derived from the name at creation (uppercase slug, deduped).
    sku: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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


class ProductMaterial(Base):
    """One BOM line: a product consumes ``qty_per_run`` of an inventory item.

    Unique per ``(product, item)`` among live rows. ``sku_id`` is gone —
    materials hang off the product directly now.
    """

    __tablename__ = "product_materials"
    __table_args__ = (
        Index(
            "uq_product_materials_product_id_item_id",
            "product_id",
            "item_id",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_product_materials_product_id", "product_id"),
        Index("ix_product_materials_item_id", "item_id"),
        CheckConstraint(
            "qty_per_run > 0",
            name="ck_product_materials_qty_per_run_positive",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.products.id", ondelete="RESTRICT"),
        nullable=False,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    qty_per_run: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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

    # ``Item`` eager-joins its stock, so a material read reaches live
    # ``item.stock.qty_on_hand`` for the Available column in one query.
    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    product: Mapped[Product] = relationship(lazy="joined", viewonly=True)


class Customer(Base):
    """A customer who orders products. Linked to products many-to-many."""

    __tablename__ = "customers"
    __table_args__ = (
        Index(
            "uq_customers_name",
            func.lower(text("name")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_customers_updated_at_desc", text("updated_at DESC")),
        CheckConstraint(
            "char_length(trim(name)) > 0",
            name="ck_customers_name_not_blank",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    contact_person: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(CITEXT, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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


class CustomerProduct(Base):
    """Many-to-many link between a customer and a product.

    A pure link row — the PK is ``(customer_id, product_id)``. Toggled when
    a customer's linked products are edited; rows are hard-inserted/deleted
    (the customer / product themselves soft-delete).
    """

    __tablename__ = "customer_products"
    __table_args__ = (
        Index("ix_customer_products_product_id", "product_id"),
        {"schema": "app"},
    )

    customer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.customers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.products.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
