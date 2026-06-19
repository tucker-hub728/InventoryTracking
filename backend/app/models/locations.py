"""Location system ORM — strict LN2 hierarchy + flat locations + allocations.

Implements the client's Location System rules (Requirements v2 §5–§13):

* ``meta.location_nodes`` — one tree for everything. LN2 is a strict
  5-level hierarchy (tank_quadrant → rack → cassette_rack → box → sub_slot);
  flat operational locations (Kanban / Lab / QC / Engineering / Materials)
  are parent-less single nodes. Only ``sub_slot`` and ``flat`` nodes can
  store inventory; the rest are navigation-only.
* ``app.lot_allocations`` — a lot is *mapped* to a storage node (it does
  not "live inside" it). A lot split across N locations = N allocation
  rows. Sub-slots are single-occupancy (one vial).
* ``app.allocation_movements`` — append-only place / transfer / consume
  audit log, decoupled from the legacy ``stock_movements`` ledger.

Design principle (§12): Location = physical truth, Lot = inventory
lifecycle, Transfer = audit history — decoupled, linked only by reference.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.inventory import Lot

# ── Node taxonomy ───────────────────────────────────────────────────────
#
# LN2 levels in strict top-down order. The parent of each level is the
# level immediately above it; ``tank_quadrant`` and ``flat`` are roots.
LN2_LEVELS: tuple[str, ...] = (
    "tank_quadrant",
    "rack",
    "cassette_rack",
    "box",
    "sub_slot",
)
NODE_TYPES: tuple[str, ...] = (*LN2_LEVELS, "flat")

# node_type → required parent node_type (None = must be a root).
PARENT_OF: dict[str, str | None] = {
    "tank_quadrant": None,
    "rack": "tank_quadrant",
    "cassette_rack": "rack",
    "box": "cassette_rack",
    "sub_slot": "box",
    "flat": None,
}

# Only these node types can hold a lot allocation (§7).
STORAGE_NODE_TYPES: frozenset[str] = frozenset({"sub_slot", "flat"})

# Flat operational location categories (§ location rules B).
FLAT_CATEGORIES: tuple[str, ...] = (
    "kanban",
    "lab",
    "qc",
    "engineering",
    "materials",
)

# Append-only movement kinds for the allocation audit log (§9).
ALLOCATION_MOVEMENT_KINDS: tuple[str, ...] = ("place", "transfer", "consume")


def can_store(node_type: str) -> bool:
    """True iff a node of this type may hold a lot allocation."""
    return node_type in STORAGE_NODE_TYPES


class LocationNode(Base):
    """One node in the location tree (LN2 level or flat location).

    Strict hierarchy is enforced by the repository on create (parent must
    be the exact type ``PARENT_OF[node_type]``); the DB adds CHECKs for the
    enums and a sibling-uniqueness constraint. ``node_type`` and the
    LN2/flat distinction are immutable after creation (§10).
    """

    __tablename__ = "location_nodes"
    __table_args__ = (
        # Sibling codes are unique under a parent (NULLs distinct, so roots
        # are checked in the repository instead).
        UniqueConstraint("parent_id", "code", name="uq_location_nodes_parent_code"),
        Index("ix_location_nodes_parent_id", "parent_id"),
        Index("ix_location_nodes_node_type", "node_type"),
        Index("ix_location_nodes_flat_category", "flat_category"),
        Index("ix_location_nodes_active", "is_active"),
        CheckConstraint(
            "node_type IN (" + ", ".join(f"'{t}'" for t in NODE_TYPES) + ")",
            name="ck_location_nodes_node_type",
        ),
        CheckConstraint(
            "(node_type = 'flat') = (flat_category IS NOT NULL)",
            name="ck_location_nodes_flat_category_presence",
        ),
        CheckConstraint(
            "flat_category IS NULL OR flat_category IN ("
            + ", ".join(f"'{c}'" for c in FLAT_CATEGORIES)
            + ")",
            name="ck_location_nodes_flat_category",
        ),
        # Roots (tank_quadrant / flat) must have no parent.
        CheckConstraint(
            "(node_type IN ('tank_quadrant', 'flat')) = (parent_id IS NULL)",
            name="ck_location_nodes_root_parentage",
        ),
        {"schema": "meta"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    node_type: Mapped[str] = mapped_column(Text, nullable=False)
    flat_category: Mapped[str | None] = mapped_column(Text, nullable=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("TRUE")
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_: Mapped[dict] = mapped_column(
        "metadata_",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
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

    parent: Mapped[LocationNode | None] = relationship(
        remote_side="LocationNode.id", viewonly=True
    )


class LotAllocation(Base):
    """A lot mapped to a storage node with a quantity (§7).

    One lot split across multiple locations yields multiple rows. A
    sub-slot is single-occupancy: at most one *active* allocation may
    point at a given sub-slot (enforced in the repository, since the rule
    depends on the node's type).
    """

    __tablename__ = "lot_allocations"
    __table_args__ = (
        Index("ix_lot_allocations_lot_id", "lot_id"),
        Index("ix_lot_allocations_node_id", "location_node_id"),
        Index(
            "ix_lot_allocations_active_node",
            "location_node_id",
            postgresql_where=text("is_active"),
        ),
        # >= 0 (not > 0): a fully consumed/transferred allocation is kept as a
        # deactivated 0-qty record so the split history survives. Creation
        # enforces qty > 0 at the op layer.
        CheckConstraint("qty >= 0", name="ck_lot_allocations_qty_nonneg"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="RESTRICT"),
        nullable=False,
    )
    location_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=False,
    )
    qty: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("TRUE")
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
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

    lot: Mapped[Lot] = relationship(lazy="joined", viewonly=True)
    location_node: Mapped[LocationNode] = relationship(lazy="joined", viewonly=True)


class AllocationMovement(Base):
    """Append-only place / transfer / consume history (§9, §12).

    Decoupled from the legacy ``app.stock_movements`` ledger — this is the
    audit trail for the new location system. Transfers preserve lot
    identity and only record movement (no structural change).
    """

    __tablename__ = "allocation_movements"
    __table_args__ = (
        Index("ix_allocation_movements_lot_id", "lot_id"),
        Index("ix_allocation_movements_from_node", "from_node_id"),
        Index("ix_allocation_movements_to_node", "to_node_id"),
        Index("ix_allocation_movements_performed_at", text("performed_at DESC")),
        CheckConstraint(
            "movement_kind IN ("
            + ", ".join(f"'{k}'" for k in ALLOCATION_MOVEMENT_KINDS)
            + ")",
            name="ck_allocation_movements_kind",
        ),
        CheckConstraint("qty > 0", name="ck_allocation_movements_qty_positive"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="RESTRICT"),
        nullable=False,
    )
    movement_kind: Mapped[str] = mapped_column(Text, nullable=False)
    from_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    to_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    qty: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    performed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    performed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    lot: Mapped[Lot] = relationship(lazy="joined", viewonly=True)
