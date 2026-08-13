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

# Storage (REQ-2026-08-04-LOC-001/004, the "standardized location template"): the
# Room → CATEGORY → Group → Unit chain. It is FREEZER_LEVELS with one level
# inserted above it, and that is the whole point — from the group down, Storage
# is byte-identical to Cold Storage, so it reuses the same create route, the same
# dialogs and the same components. The client intends Storage to replace the Cold
# Storage structure later, so the two are deliberately the same idiom.
#
#   Storage            room              the room (seeded, code STG)
#   └ Materials Mgmt   storage_category  what the client calls a "location"
#     ├ Shelf          room_location     a template group
#     │ └ T123213B     sub_location      the equipment unit — stock lives here
#     ├ Refrigerator   room_location
#     └ Freezer        room_location
#
# The category is a real node rather than a UI facet because LOC-001 says the
# client "may rename these": a tab you can rename and that carries its own units
# is a node. Which groups a category uses is simply WHICH GROUP NODES EXIST — an
# unused sub-type is an absent node, and an empty tab is a group with no
# children. There is deliberately no flag, no JSON blob and no second source of
# truth to drift.
STORAGE_LEVELS: tuple[str, ...] = (
    "room",
    "storage_category",
    "room_location",
    "sub_location",
)
# The room's seeded code. Every screen resolves a room by code, never by
# position — ``/location-nodes/freezer-tree`` returns them all.
STORAGE_ROOM_CODE = "STG"
# The template's three groups, fixed at three (LOC-001 names exactly these).
# ``(key, code, default name)`` — the CODE is the stable identity used in URLs
# and to tell the groups apart after a rename; the NAME is the client's to change.
STORAGE_GROUPS: tuple[tuple[str, str, str], ...] = (
    ("shelf", "SHF", "Shelf"),
    ("refrigerator", "REF", "Refrigerator"),
    ("freezer", "FRZ", "Freezer"),
)
STORAGE_GROUP_CODES: tuple[str, ...] = tuple(code for _, code, _ in STORAGE_GROUPS)
# Warehouse (LOC-005): Warehouse One → Shelf (A–Z), the free-storage leaf. A
# shelf holds units freely — no bins, positions or slots below it. Warehouse One
# is no longer a root: LOC-005 places it INSIDE the Materials Management room,
# as a peer of the Cold Storage locations.
WAREHOUSE_LEVELS: tuple[str, ...] = ("warehouse", "shelf")

# Kanban (REQ-2026-07-01-LOC-006, "a Kanban shall be representable as a named
# location"; client 2026-08-10): a NAMED station inside a production area, so
# one clean room can hold "Kanban 1" and "Kanban 2" as separate places. Its
# parent is the ``flat``/``production`` area — see PARENT_OF below.
#
# Not a storage node: under the client's consume-at-issue model (Option A) a
# Kanban holds no lot allocations. It is the ADDRESS a ``consumable_issue``
# movement and its ``app.consumable_issues`` register row point at, not a
# balance. Adding it to STORAGE_NODE_TYPES is the whole of the Option B switch
# if the client ever wants live Kanban on-hand.
#
# NB the ``kanban`` entry in FLAT_CATEGORIES below is a DIFFERENT, legacy thing
# and must stay unused — a ``flat`` node is forced to be a root by
# ck_location_nodes_root_parentage, so it could never hang under a clean room.
KANBAN_LEVELS: tuple[str, ...] = ("kanban",)

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
    # Only the level STORAGE_LEVELS adds — the other three it names are already
    # in FREEZER_LEVELS, and NODE_TYPES drives the CHECK constraint, so a
    # duplicate would widen the enum with a repeat.
    "storage_category",
    *WAREHOUSE_LEVELS,
    *KANBAN_LEVELS,
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
    # LOC-001: a Storage category hangs under the Storage room. The route checks
    # the parent really is the STG room — ``room`` alone would also match Cold
    # Storage, which is exempt from the template.
    "storage_category": ("room",),
    # A group is a peer of a Cold Storage location; under Storage it hangs off a
    # category instead of straight off the room. Same type, one level deeper.
    "room_location": ("room", "storage_category"),
    "sub_location": ("room_location",),
    # LOC-005: Warehouse One is a location INSIDE a room, not a root of its own.
    "warehouse": ("room",),
    "shelf": ("warehouse",),
    # LOC-006: a Kanban hangs under a production area. ``flat`` is retired for
    # general creation but is still the type a production area carries, and a
    # Kanban is only ever created through the dedicated super-admin route
    # (``POST /location-nodes/{id}/kanbans``), which checks the parent really is
    # a production area — ``flat`` alone would also match a legacy Lab/QC node.
    "kanban": ("flat",),
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

# The only node type that may carry ``is_scrap`` (issue01) — a LOCATION, the
# level the client names "PD" or "QC 1".
#
# Debit-and-gone (REQ-2026-08-04-TRX-001/002) is a TRANSACTION, not a location
# type: the client's rule is that one physical area supports both actions, and
# which happened is the operator's choice, not the destination's nature —
#
#     Transfer → QC 1 › Freezer 1     stock stays tracked at the new node
#     Issue    → QC 1                 stock leaves controlled inventory
#
# So a scrap location is an ORDINARY ``storage_category``: same page, same
# template groups, and it still RECEIVES transfers into its shelves and freezers.
# ``is_scrap`` decides one thing only — whether Issue may target it.
#
# That the two destination sets are DISJOINT is what makes "issued and stored"
# unrepresentable rather than merely rejected: a transfer takes a
# STORAGE_NODE_TYPES node, an issue takes this one, and no node is both.
SCRAP_NODE_TYPE = "storage_category"

# Node types that carry a configurable rows×cols grid. Only the Box.
GRID_NODE_TYPES: frozenset[str] = frozenset({"box"})

# Flat operational location categories. The legacy set (kanban…materials) is
# kept for the DB CHECK + reading pre-existing flat rows. ``production`` was
# added for kitting (docs/modules/kitting.md §4.1) — the advisory production
# floors a kit is issued to (Clean Room 1/2, Manufacturing Floor, PD Lab One/Two).
#
# ``kanban`` here is DEAD and must stay that way (consum01). A real Kanban is the
# ``kanban`` NODE TYPE, a child of a production area. Reviving this category
# would make a Kanban a parent-less root — the root-parentage CHECK forces every
# ``flat`` node to have no parent — which is exactly the model the client
# rejected on 2026-08-10 ("always to the kanban", inside the room).
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


def is_kanban_node(node_type: str) -> bool:
    """True iff a node of this type is a Kanban station (LOC-006) — the only
    legal destination for a consumable issue."""
    return node_type in KANBAN_LEVELS


def is_scrap_location(node: LocationNode) -> bool:
    """True iff this node is a debit-and-gone destination (TRX-001/002).

    Both halves are checked, not just the flag: the node type is what keeps the
    Issue and Transfer destination sets disjoint, and a CHECK constraint alone
    would not stop a caller reading the flag off the wrong row.
    """
    return bool(node.is_scrap) and node.node_type == SCRAP_NODE_TYPE


class LocationNode(Base):
    """One node in the location tree (LN2 level or flat location).

    Strict hierarchy is enforced by the repository on create (parent must
    be the exact type ``PARENT_OF[node_type]``); the DB adds CHECKs for the
    enums and a sibling-uniqueness constraint. ``node_type`` and the
    LN2/flat distinction are immutable after creation (§10).
    """

    __tablename__ = "location_nodes"
    __table_args__ = (
        # Sibling codes are unique under a parent, among ACTIVE rows only (NULLs
        # distinct, so roots are checked in the repository instead).
        #
        # Partial on ``is_active`` to match the two NAME indexes from
        # ``locname01``, so a delete frees a unit's code and its name together
        # (``loccode01``). It was unconditional until 2026-08-12, which meant a
        # deleted equipment number could never be re-added — the name was freed,
        # the code was not, and for a sub_location the name IS the code.
        Index(
            "uq_location_nodes_parent_code",
            "parent_id",
            "code",
            unique=True,
            postgresql_where=text("is_active"),
        ),
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
            "(grid_rows IS NULL OR grid_rows >= 1) " "AND (grid_cols IS NULL OR grid_cols >= 1)",
            name="ck_location_nodes_grid_positive",
        ),
        # Only a LOCATION can be a scrap destination (issue01). Marking a shelf,
        # a box or a room would put a node in the Issue destination list that is
        # simultaneously a legal TRANSFER target — the exact ambiguity the
        # disjoint-destination rule exists to prevent.
        CheckConstraint(
            f"NOT is_scrap OR node_type = '{SCRAP_NODE_TYPE}'",
            name="ck_location_nodes_scrap_category_only",
        ),
        # Quadrant dedication: at most one of customer / product, and only on a
        # tank_quadrant. Advisory — placement is never blocked by it.
        CheckConstraint(
            "NOT (dedicated_customer_id IS NOT NULL " "AND dedicated_product_id IS NOT NULL)",
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
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("TRUE"))
    # Debit-and-gone marker (REQ-2026-08-04-TRX-001/002, issue01) — see
    # :func:`is_scrap_location`. Set at creation, immutable afterwards.
    is_scrap: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("FALSE"))
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

    parent: Mapped[LocationNode | None] = relationship(remote_side="LocationNode.id", viewonly=True)


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
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("TRUE"))
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
