"""Location ORM — ``app.locations``.

Week-1 reset (2026-07-06): the strict LN2-tank tree + allocations model is
gone. A location is a single self-referencing row: a top-level location
(``parent_location_id IS NULL``) or a shelf sub-location under one
(``parent_location_id`` → its parent). ``location_type`` is a free-form,
admin-extensible category (Materials Management, Lab, QC, Engineering,
PD Lab One/Two, …) per REQ-2026-07-01-LOC-002/ADM-001.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Controlled location categories (LOC-002). A native ``app.location_category``
# enum. Extending it requires a migration (ALTER TYPE ... ADD VALUE) — keep this
# tuple in lock-step with that migration and the frontend LOCATION_CATEGORIES.
# 2026-07-08: added Analytical Lab / Sterility Lab / PD for the freezer import.
LOCATION_CATEGORIES: tuple[str, ...] = (
    "Materials Management",
    "Lab",
    "QC",
    "Engineering",
    "PD Lab One",
    "PD Lab Two",
    "Analytical Lab",
    "Sterility Lab",
    "PD",
)

# ``create_type=False`` — the migration owns the enum type; the ORM references it.
location_category_enum = ENUM(
    *LOCATION_CATEGORIES, name="location_category", schema="app", create_type=False
)


class Location(Base):
    """One controlled location or shelf sub-location.

    Self-referencing hierarchy: parent location → child shelf. Selected from
    a controlled list at receipt (LOC-004) and changeable later (LOC-001).
    """

    __tablename__ = "locations"
    __table_args__ = (
        Index("ix_locations_parent_location_id", "parent_location_id"),
        Index("ix_locations_is_active", "is_active"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    location_name: Mapped[str] = mapped_column(Text, nullable=False)
    # NULL = top-level location; set = shelf sub-location under a parent.
    parent_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    # One of the fixed ``app.location_category`` values (LOC-002).
    location_type: Mapped[str] = mapped_column(location_category_enum, nullable=False)
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

    parent: Mapped[Location | None] = relationship(
        remote_side="Location.id",
        viewonly=True,
    )
