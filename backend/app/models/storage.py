"""Storage ORM — racks and positions for the LN2 / Storage grid.

``Location → Rack(rows×cols) → Position`` — see ``docs/modules/storage.md``.
This sits on top of ``meta.locations`` (defined in :mod:`app.models.inventory`):
a storage location is a ``meta.locations`` row that owns one or more racks.

Design (from the contract):

* A rack is a fixed ``rows × cols`` grid. Its positions are *materialised*
  on creation and are **immutable** — there is no resize (delete & recreate).
* A position holds exactly **one unit** (vial). ``lot_id`` is traceability,
  not a quantity. Status is **binary** — ``empty`` / ``occupied``.
* ``storage_assignment_events`` is the append-only history (assign / empty /
  move) backing position history + the audit trail.

NB: this module is named ``app.models.storage`` — distinct from the
``app.storage`` package, which is the unrelated S3 object-storage facade.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.inventory import Lot

# Binary slot status — see storage.md §4.3. Kept in lock-step with the
# Pydantic ``PositionStatus`` enum and the DB CHECK below.
POSITION_STATUSES: tuple[str, ...] = ("empty", "occupied")

# Append-only history event kinds — storage.md §4.4. A move writes a pair
# (``move_out`` on the source, ``move_in`` on the destination).
STORAGE_EVENT_KINDS: tuple[str, ...] = ("assign", "move_out", "move_in", "empty")


class StorageRack(Base):
    """A ``rows × cols`` grid of positions under a ``meta.locations`` row."""

    __tablename__ = "storage_racks"
    __table_args__ = (
        UniqueConstraint(
            "location_id", "code", name="uq_storage_racks_location_id_code"
        ),
        Index("ix_storage_racks_location_id", "location_id"),
        CheckConstraint("rows BETWEEN 1 AND 26", name="ck_storage_racks_rows_range"),
        CheckConstraint("cols BETWEEN 1 AND 26", name="ck_storage_racks_cols_range"),
        CheckConstraint(
            "char_length(trim(name)) > 0", name="ck_storage_racks_name_not_blank"
        ),
        {"schema": "meta"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    location_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "meta.locations.id",
            ondelete="CASCADE",
            name="fk_storage_racks_location_id_locations",
        ),
        nullable=False,
    )
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Grid shape. Immutable after creation (positions are materialised once).
    rows: Mapped[int] = mapped_column(Integer, nullable=False)
    cols: Mapped[int] = mapped_column(Integer, nullable=False)
    position_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("TRUE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    positions: Mapped[list[StoragePosition]] = relationship(
        "StoragePosition",
        back_populates="rack",
        order_by="StoragePosition.seq",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class StoragePosition(Base):
    """One slot in a rack. Immutable coordinates; mutable occupancy."""

    __tablename__ = "storage_positions"
    __table_args__ = (
        UniqueConstraint(
            "rack_id",
            "row_idx",
            "col_idx",
            name="uq_storage_positions_rack_id_row_idx_col_idx",
        ),
        UniqueConstraint("rack_id", "seq", name="uq_storage_positions_rack_id_seq"),
        Index("ix_storage_positions_rack_id", "rack_id"),
        Index("ix_storage_positions_lot_id", "lot_id"),
        Index("ix_storage_positions_status", "status"),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in POSITION_STATUSES) + ")",
            name="ck_storage_positions_status",
        ),
        CheckConstraint("row_idx >= 1", name="ck_storage_positions_row_idx_min"),
        CheckConstraint("col_idx >= 1", name="ck_storage_positions_col_idx_min"),
        CheckConstraint("seq >= 1", name="ck_storage_positions_seq_min"),
        # Occupancy invariant: a slot holds a lot exactly when occupied.
        CheckConstraint(
            "(status = 'occupied') = (lot_id IS NOT NULL)",
            name="ck_storage_positions_occupancy",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    rack_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "meta.storage_racks.id",
            ondelete="CASCADE",
            name="fk_storage_positions_rack_id_storage_racks",
        ),
        nullable=False,
    )
    # 1-based grid coordinates + row-major sequence (= the user-facing
    # position number, e.g. 12). ``label`` is the human cell name (``C2``).
    row_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    col_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'empty'")
    )
    lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.lots.id",
            ondelete="RESTRICT",
            name="fk_storage_positions_lot_id_lots",
        ),
        nullable=True,
    )
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    rack: Mapped[StorageRack] = relationship(
        "StorageRack", back_populates="positions"
    )
    # Read-only hydration: position → lot → item → vendor. ``Lot`` already
    # eager-loads ``item`` and ``vendor`` (lazy="joined"), so the item card
    # is populated without extra round-trips.
    lot: Mapped[Lot | None] = relationship("Lot", lazy="joined", viewonly=True)


class StorageAssignmentEvent(Base):
    """Append-only history of position occupancy changes (21 CFR Part 11)."""

    __tablename__ = "storage_assignment_events"
    __table_args__ = (
        Index(
            "ix_storage_assignment_events_position_id_occurred_at",
            "position_id",
            "occurred_at",
        ),
        CheckConstraint(
            "event_kind IN (" + ", ".join(f"'{k}'" for k in STORAGE_EVENT_KINDS) + ")",
            name="ck_storage_assignment_events_event_kind",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    position_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.storage_positions.id",
            ondelete="CASCADE",
            name="fk_storage_assignment_events_position_id_storage_positions",
        ),
        nullable=False,
    )
    event_kind: Mapped[str] = mapped_column(Text, nullable=False)
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.lots.id",
            ondelete="RESTRICT",
            name="fk_storage_assignment_events_lot_id_lots",
        ),
        nullable=True,
    )
    # For a ``move``, the other slot in the pair (source ↔ destination).
    counterpart_position_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.storage_positions.id",
            ondelete="SET NULL",
            name="fk_storage_events_counterpart_position",
        ),
        nullable=True,
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.users.id",
            ondelete="RESTRICT",
            name="fk_storage_assignment_events_actor_id_users",
        ),
        nullable=False,
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
