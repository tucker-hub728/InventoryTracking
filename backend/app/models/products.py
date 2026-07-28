"""Customer module ORM — the **Customer** master-data entity.

Historically this module also held ``Product`` / ``ProductMaterial`` (gone under
the unified catalogue — a "product" is now an :class:`~app.models.inventory.Item`
in a *built* tier) and a ``CustomerItem`` link table. Customers are no longer
linked to items (the part number is the source of truth for inventory identity);
a shipment names a customer at ship time. What remains here is just the
**Customer**.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Customer(Base):
    """A customer who orders finished-good items. Linked many-to-many."""

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
