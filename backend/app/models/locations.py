"""Location system ORM — strict LN2 hierarchy + flat locations + allocations.

Implements the client's Location System rules (Requirements v2 §4.1):

* ``meta.location_nodes`` — one tree for everything. LN2 is
  ``tank_quadrant → rack → (cassette | cryo_box_rack) → box``; the **Box** is
  the grid-bearing leaf (``grid_rows × grid_cols``). Cassette / Cryo Box Rack
  are navigation containers. Flat operational locations (Kanban / Lab / QC /
  Engineering / Materials) are parent-less single nodes. Only ``box`` and
  ``flat`` nodes can store inventory. A ``tank_quadrant`` may be dedicated to a
  customer XOR a product (advisory; descendants inherit it).
* ``app.lot_allocations`` — a lot is *mapped* to a storage node (it does not
  "live inside" it). For a Box it carries the ``(grid_row, grid_col)`` cell —
  one active allocation per cell (single-occupancy, manual placement, gaps).
  A lot split across N cells/locations = N allocation rows.

Movement history is NOT kept here — quantity-changing operations (consume /
transfer) are written to the GxP ledger ``app.stock_movements`` (via its
``from_location_node_id`` / ``to_location_node_id`` columns); placement is
audited in ``audit.audit_events``.

Design principle: Location = physical truth, Lot = inventory lifecycle,
Ledger = quantity + audit history — linked only by reference.
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
    SmallInteger,
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
# LN2 levels (REQ-2026-07-15-LOC-001): TANK (the root, identified by its main
# tank number) → QUADRANT (``tank_quadrant``, capped at four per tank) → RACK →
# BOX. The **Box** is the grid-bearing leaf storage node — a lot is placed into
# one of its ``(row, col)`` cells (the "sub-slot", a coordinate on the
# allocation, not a node of its own).
#
# The quadrant kept its ``tank_quadrant`` type name: it is literally a quadrant
# OF a tank, and renaming it would churn the dedication CHECK constraints for no
# behavioural gain. The UI labels it "Quadrant".
#
# Cassette / Cryo Box Rack used to sit between Rack and Box. The client dropped
# them on 2026-07-29 so the cascade matches LOC-004's four levels exactly, and a
# Box now hangs directly off a Rack. Note this contradicts the Transaction Spec
# of 2026-07-01, which addresses a location as "Tank 2, Cassette X" — raised
# with the client, who chose to drop them anyway. Phase 2 (the configurable
# cascade) will let them add the level back without a code change.
LN2_LEVELS: tuple[str, ...] = (
    "tank",
    "tank_quadrant",
    "rack",
    "box",
)
# Room area (SRS 2026-07-15 LOC-005/LOC-006): Room → Location → Sub-location.
# The Room is what LOC-005 calls a "location category" (Materials Management);
# a Location is an area inside it; the Sub-location is the free-storage leaf.
# Units are placed at the sub-location (free placement, no grid); there are no
# positions inside — physical placement is controlled by labeling.
#
# A room's Locations come in two flavours, which are separate node types only so
# the UI can tab between them; structurally they are PEERS under the same room:
#   * ``warehouse`` — ambient shelving (Warehouse One), whose leaves are shelves
#   * ``room_location`` — Cold Storage (LOC-002: −20 °C, −80 °C, 2–8 °C fridges),
#     whose leaves are the equipment units
FREEZER_LEVELS: tuple[str, ...] = ("room", "room_location", "sub_location")
# Warehouse (LOC-005): Warehouse One → Shelf (A–Z), the free-storage leaf. A
# shelf holds units freely — no bins, positions or slots below it. Warehouse One
# is no longer a root: LOC-005 places it INSIDE the Materials Management room,
# as a peer of the Cold Storage locations.
WAREHOUSE_LEVELS: tuple[str, ...] = ("warehouse", "shelf")

# Retired but kept in the CHECK enum so any pre-existing rows still validate
# (retire-not-drop). Not creatable: absent from ``PARENT_OF``.
#
# ``flat`` is retired: the LN2 area keeps only its storage hierarchy, and
# free-placement moved to the Freezer / Warehouse areas above.
# ``cassette`` / ``cryo_box_rack`` retired 2026-07-29 — see LN2_LEVELS.
LEGACY_NODE_TYPES: tuple[str, ...] = (
    "flat",
    "cassette",
    "cryo_box_rack",
    "cassette_rack",
    "sub_slot",
)
NODE_TYPES: tuple[str, ...] = (
    *LN2_LEVELS,
    *FREEZER_LEVELS,
    *WAREHOUSE_LEVELS,
    *LEGACY_NODE_TYPES,
)

# node_type → allowed parent node_type(s) (None = must be a root). Only the
# keys here are *creatable*; a Box may hang under either container type.
# ``flat`` is intentionally absent — it is retired (not creatable).
PARENT_OF: dict[str, tuple[str, ...] | None] = {
    "tank": None,
    "tank_quadrant": ("tank",),
    "rack": ("tank_quadrant",),
    "box": ("rack",),
    "room": None,
    "room_location": ("room",),
    "sub_location": ("room_location",),
    # LOC-005: Warehouse One is a location INSIDE a room, not a root of its own.
    "warehouse": ("room",),
    "shelf": ("warehouse",),
}

# Node types that are roots (parent_id must be NULL). ``flat`` kept for legacy
# rows. Drives ``ck_location_nodes_root_parentage``. ``warehouse`` left this set
# in migration ``mmroom01`` — LOC-005 puts Warehouse One under a room; and
# ``tank_quadrant`` left it in ``ln2tank01`` — LOC-001 puts a Tank above it.
ROOT_NODE_TYPES: tuple[str, ...] = ("tank", "room", "flat")

# REQ-2026-07-15-LOC-001: "four quadrants per tank". Enforced as a hard cap in
# the create route (the client chose a strict limit over a soft default), so a
# tank can never carry a fifth. Quadrants are added by hand, one at a time.
MAX_QUADRANTS_PER_TANK = 4

# Node types that can hold a lot allocation. The Box is the LN2 grid leaf;
# freezer sub-locations and warehouse shelves are free (qty) storage leaves.
STORAGE_NODE_TYPES: frozenset[str] = frozenset({"box", "sub_location", "shelf"})

# Node types that carry a configurable rows×cols grid. Only the Box.
GRID_NODE_TYPES: frozenset[str] = frozenset({"box"})

# Flat operational location categories. The legacy set (kanban…materials) is
# kept for the DB CHECK + reading pre-existing flat rows. ``production`` was
# added for kitting (docs/modules/kitting.md §4.1) — the advisory production
# floors a kit is issued to (Clean Room 1/2, Manufacturing Floor, PD Lab One/Two).
FLAT_CATEGORIES: tuple[str, ...] = (
    "kanban",
    "lab",
    "qc",
    "engineering",
    "materials",
    "production",
)


def can_store(node_type: str) -> bool:
    """True iff a node of this type may hold a lot allocation."""
    return node_type in STORAGE_NODE_TYPES


def is_grid_node(node_type: str) -> bool:
    """True iff a node of this type carries a rows×cols grid (the Box)."""
    return node_type in GRID_NODE_TYPES


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
        # Roots (tank_quadrant / room / warehouse; flat legacy) have no parent.
        CheckConstraint(
            "(node_type IN ("
            + ", ".join(f"'{t}'" for t in ROOT_NODE_TYPES)
            + ")) = (parent_id IS NULL)",
            name="ck_location_nodes_root_parentage",
        ),
        # Grid dimensions exist on (and only on) a Box. The Box-under-Cassette
        # rule (grid_cols = 1) needs the parent's type, so it's enforced in the
        # route, not here.
        CheckConstraint(
            "(node_type = 'box') = (grid_rows IS NOT NULL AND grid_cols IS NOT NULL)",
            name="ck_location_nodes_grid_presence",
        ),
        CheckConstraint(
            "(grid_rows IS NULL OR grid_rows >= 1) "
            "AND (grid_cols IS NULL OR grid_cols >= 1)",
            name="ck_location_nodes_grid_positive",
        ),
        # Quadrant dedication: at most one of customer / product, and only on a
        # tank_quadrant. Advisory — placement is never blocked by it.
        CheckConstraint(
            "NOT (dedicated_customer_id IS NOT NULL "
            "AND dedicated_product_id IS NOT NULL)",
            name="ck_location_nodes_dedication_exclusive",
        ),
        CheckConstraint(
            "(dedicated_customer_id IS NULL AND dedicated_product_id IS NULL) "
            "OR node_type = 'tank_quadrant'",
            name="ck_location_nodes_dedication_quadrant_only",
        ),
        Index(
            "ix_location_nodes_dedicated_customer",
            "dedicated_customer_id",
            postgresql_where=text("dedicated_customer_id IS NOT NULL"),
        ),
        Index(
            "ix_location_nodes_dedicated_product",
            "dedicated_product_id",
            postgresql_where=text("dedicated_product_id IS NOT NULL"),
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
    # Grid dimensions — only a Box carries them (CHECK above). A Box under a
    # Cassette is single-column (grid_cols = 1, enforced in the route).
    grid_rows: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    grid_cols: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Quadrant dedication (§4.1) — advisory link to a customer XOR a product;
    # only on a tank_quadrant. Descendants inherit it (resolved in the route).
    dedicated_customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.customers.id", ondelete="RESTRICT"),
        nullable=True,
    )
    # Now points at a finished-good Item (unified catalogue) rather than the
    # retired products table.
    dedicated_product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=True,
    )
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
        # One active allocation per Box cell — gives single-occupancy, manual
        # placement and intentional gaps for free (a gap is just an unfilled
        # (row, col)). Flat allocations have NULL coordinates and are excluded.
        Index(
            "uq_lot_allocations_cell",
            "location_node_id",
            "grid_row",
            "grid_col",
            unique=True,
            postgresql_where=text("is_active AND grid_row IS NOT NULL"),
        ),
        # >= 0 (not > 0): a fully consumed/transferred allocation is kept as a
        # deactivated 0-qty record so the split history survives. Creation
        # enforces qty > 0 at the op layer.
        CheckConstraint("qty >= 0", name="ck_lot_allocations_qty_nonneg"),
        # Cell coordinates are both-or-neither (grid nodes set them, flat
        # nodes leave them NULL). Bounds + qty=1 are enforced at the op layer.
        CheckConstraint(
            "(grid_row IS NULL) = (grid_col IS NULL)",
            name="ck_lot_allocations_cell_pairing",
        ),
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
    # Whole units only (integer). For a Box cell this is always 1.
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    # 1-based cell within the parent Box's grid. NULL for flat allocations.
    grid_row: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    grid_col: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
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
