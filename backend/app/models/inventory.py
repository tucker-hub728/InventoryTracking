"""Inventory ORM — suppliers, UOMs, items, locations, lots.

Schema and constraints follow ``docs/backend-data-structure.md`` §4–§6.1
verbatim, with the additions / omissions documented in the migrations.

Ledger entries (``app.stock_movements``) are still deferred — they land
with the next chunk and FK back to ``items``, ``lots``, ``locations``.
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
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.identity import User


class Supplier(Base):
    """Sourcing partner. Items optionally reference one."""

    __tablename__ = "suppliers"
    __table_args__ = (
        Index("uq_suppliers_name", func.lower(text("name")), unique=True),
        Index("ix_suppliers_active", "is_active"),
        {"schema": "meta"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    contact_email: Mapped[str | None] = mapped_column(CITEXT, nullable=True)
    phone: Mapped[str | None] = mapped_column(Text, nullable=True)
    address: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("TRUE"),
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
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


# Item-category kind (requirements v2 §6). A category is either:
#   * purchased — its items are bought as-is (raw components / materials)
#   * built     — its items are assembled from a BOM (sub-assemblies, finished
#                 goods). Surfaced in the UI as "Product".
# The kind is fixed at creation and decides whether an item may carry a BOM.
ITEM_CATEGORY_KINDS: tuple[str, ...] = ("purchased", "built")


class ItemCategory(Base):
    """A user-managed item category (finished goods, sub-assemblies, …).

    Every :class:`Item` belongs to exactly one category. The category's
    ``kind`` (purchased vs built) is inherited by its items and governs BOM
    eligibility. Seeded with the five client categories; users can add more.
    """

    __tablename__ = "item_categories"
    __table_args__ = (
        Index(
            "uq_item_categories_name",
            func.lower(text("name")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_item_categories_updated_at_desc", text("updated_at DESC")),
        CheckConstraint(
            "char_length(trim(name)) > 0",
            name="ck_item_categories_name_not_blank",
        ),
        CheckConstraint(
            "kind IN ('purchased', 'built')",
            name="ck_item_categories_kind",
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
    # 'purchased' | 'built' — immutable after creation (enforced in the route).
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Display colour token ('neutral' | 'accent' | 'success' | 'warning' |
    # 'danger'); cosmetic only.
    tone: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'neutral'")
    )
    # Seeded categories may be renamed/recoloured but are protected from
    # deletion of the canonical five (enforced in the route).
    is_seeded: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("FALSE")
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
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Nullable so the migration can seed the 5 default categories with no
    # creator (system seed). App-created categories always set these.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )


class Item(Base):
    """Inventory catalogue row. One per Excel master tracker line.

    Quantities are NOT on this table — they're derived from the ledger
    once the movements module ships. ``status`` is similarly derived.

    Every item belongs to an :class:`ItemCategory`; the category's ``kind``
    decides whether the item is *built* (may carry a BOM via
    :class:`BomLine`) or *purchased*.
    """

    __tablename__ = "items"
    __table_args__ = (
        # No CHECK on item_number — it's free-form, uniqueness only (§3.1).
        # The partial-unique index ``uq_items_item_number`` is the sole guard.
        CheckConstraint(
            "reorder_threshold >= 0",
            name="ck_items_reorder_threshold_nonneg",
        ),
        CheckConstraint(
            "near_expiry_threshold_days >= 0",
            name="ck_items_near_expiry_threshold_days_nonneg",
        ),
        Index(
            "uq_items_item_number",
            "item_number",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_items_updated_at_desc", text("updated_at DESC")),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )

    item_number: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # Every item is categorised (requirements v2 §6). The category's ``kind``
    # (purchased/built) governs whether this item may carry a BOM.
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.item_categories.id", ondelete="RESTRICT"),
        nullable=False,
    )

    # An item's assigned suppliers live in ``meta.item_suppliers`` (the ``suppliers``
    # relationship below). There is no single default-supplier column — the list
    # is the source of truth for which suppliers an item can be received against.
    avg_lead_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reorder_threshold: Mapped[Decimal] = mapped_column(
        Numeric(14, 3),
        nullable=False,
        server_default=text("0"),
    )
    # Near-expiry window (days). Lots on this item whose expiration falls
    # within this many days are flagged "near expiry" on the unit ledger;
    # already-past lots are "expired". Per-item so each material can carry
    # its own shelf-life sensitivity. Default 30.
    near_expiry_threshold_days: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default=text("30"),
    )
    must_order_flag: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("FALSE"),
    )
    last_updated_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    row_version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default=text("1"),
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
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
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

    # ── Relationships (read-only views) ───────────────────────────────
    # ``suppliers`` (the assigned-supplier list) is defined after ItemSupplier
    # below, mirroring the ``stock`` relationship pattern.
    creator: Mapped[User] = relationship(
        foreign_keys=[created_by_user_id],
        viewonly=True,
    )
    updater: Mapped[User] = relationship(
        foreign_keys=[updated_by_user_id],
        viewonly=True,
    )
    # Eager-joined so a read hydrates the category (name/kind/tone) in one query.
    category: Mapped[ItemCategory] = relationship(
        foreign_keys=[category_id],
        lazy="joined",
        viewonly=True,
    )


class BomLine(Base):
    """One bill-of-materials line: ``parent_item`` consumes ``qty_per_run`` of
    ``child_item`` per production run.

    Self-referencing over :class:`Item`, so a child may itself be a built item
    with its own BOM — this is what enables multi-level / nested BOMs
    (requirements v2 §6). A parent should be a *built*-category item; cycle
    prevention (A→B→A) is enforced in the route, not by a DB constraint.
    """

    __tablename__ = "bom_lines"
    __table_args__ = (
        Index(
            "uq_bom_lines_parent_child",
            "parent_item_id",
            "child_item_id",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_bom_lines_parent_item_id", "parent_item_id"),
        Index("ix_bom_lines_child_item_id", "child_item_id"),
        CheckConstraint(
            "parent_item_id <> child_item_id",
            name="ck_bom_lines_no_self_reference",
        ),
        CheckConstraint("qty_per_run > 0", name="ck_bom_lines_qty_per_run_positive"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    parent_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    child_item_id: Mapped[uuid.UUID] = mapped_column(
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

    # The child item eager-joins its stock + category so a BOM read reaches
    # ``child.stock.qty_on_hand`` and the child's category in one query.
    child_item: Mapped[Item] = relationship(
        foreign_keys=[child_item_id], lazy="joined", viewonly=True
    )
    parent_item: Mapped[Item] = relationship(
        foreign_keys=[parent_item_id], viewonly=True
    )


# Single source of truth for lot status values. Keep in sync with the
# DB CHECK and the Pydantic enum.
#
# Two core statuses per the client's order model — "Quarantine" was
# explicitly rejected (audit vs. physical-area discrepancy), and expiry
# is handled by ``expiration_date`` (date-driven), not a manual status:
#   * available — received & usable stock
#   * on_order  — placed on a PO, not yet received (set manually)
# How Released / QC Hold / Rejected ultimately fold in is TBD with the team.
LOT_STATUSES: tuple[str, ...] = (
    "on_order",
    "available",
)


class Lot(Base):
    """Manufacturer batch of an item.

    Scoped per ``item_id`` because the same supplier can issue identical
    lot numbers for different products. The partial-unique index keys
    on ``(item_id, lot_number)`` and ignores soft-deleted rows.
    """

    __tablename__ = "lots"
    __table_args__ = (
        Index(
            "uq_lots_item_lot_number",
            "item_id",
            "lot_number",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_lots_item_id", "item_id"),
        Index("ix_lots_supplier_id", "supplier_id"),
        Index("ix_lots_status", "status"),
        Index(
            "ix_lots_receipt_transaction_id",
            "receipt_transaction_id",
            postgresql_where=text("receipt_transaction_id IS NOT NULL"),
        ),
        Index(
            "ix_lots_parent_lot_id",
            "parent_lot_id",
            postgresql_where=text("parent_lot_id IS NOT NULL"),
        ),
        Index(
            "ix_lots_receipt_transaction_line_id",
            "receipt_transaction_line_id",
            postgresql_where=text("receipt_transaction_line_id IS NOT NULL"),
        ),
        Index(
            "ix_lots_expiration_date",
            "expiration_date",
            postgresql_where=text("status IN ('available', 'on_order')"),
        ),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in LOT_STATUSES) + ")",
            name="ck_lots_status",
        ),
        CheckConstraint(
            "char_length(trim(lot_number)) > 0",
            name="ck_lots_lot_number_not_blank",
        ),
        CheckConstraint(
            "expiration_date IS NULL OR manufacture_date IS NULL "
            "OR expiration_date >= manufacture_date",
            name="ck_lots_dates_ordered",
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
    lot_number: Mapped[str] = mapped_column(Text, nullable=False)
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.suppliers.id", ondelete="RESTRICT"),
        nullable=True,
    )
    manufacture_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    expiration_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'available'"),
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Receipt Admin v2 (docs/modules/receipt-admin.md §1.4) ──────────
    # The lot is the source of truth for the price paid and the PO it was
    # ordered against.
    unit_price_amount: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2),
        nullable=True,
    )
    po_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Ordered quantity captured at intake (planning data for ON_ORDER lots) —
    # whole units only (integer). It also caps total unit-IN: a lot's placed
    # quantity across all locations may not exceed ordered_qty. The *received*
    # / on-hand quantity stays ledger-derived (summed from app.stock_movements
    # via app.v_item_stock) — this is NOT that.
    ordered_qty: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
    )
    # The intake that created this lot (NULL for seeded / direct-receipt lots).
    receipt_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_transactions.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Split lineage — set on child lots produced when a receipt is split.
    parent_lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="SET NULL"),
        nullable=True,
    )
    # The Order line this lot was received against (Requirements v3). Lots are
    # created at receive, each tied to exactly one line (one lot per
    # line × receive-event).
    receipt_transaction_line_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_transaction_lines.id", ondelete="SET NULL"),
        nullable=True,
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
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
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

    # ── Relationships (read-only views) ────────────────────────────────
    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    supplier: Mapped[Supplier | None] = relationship(lazy="joined", viewonly=True)


# Single source of truth for accepted movement types. Keep aligned with
# the DB CHECK + Pydantic ``MovementType`` enum.
MOVEMENT_TYPES: tuple[str, ...] = (
    "receipt",
    "dispense",
    "adjustment",
    "discard",
    "transfer_out",
    "transfer_in",
)


class StockMovement(Base):
    """One row in the append-only stock ledger.

    Immutable at the DB level — BEFORE UPDATE / BEFORE DELETE triggers
    raise on any attempt to mutate. Written by the Location System:
    place = unit-IN (receipt), transfer = transfer_out/in pair, consume =
    unit-OUT (dispense, recording the consuming flat location as ``to``).
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        Index(
            "ix_movements_item_id_performed_at",
            "item_id",
            text("performed_at DESC"),
        ),
        Index(
            "ix_movements_lot_id",
            "lot_id",
            postgresql_where=text("lot_id IS NOT NULL"),
        ),
        Index("ix_movements_type", "movement_type"),
        Index("ix_movements_performed_at_desc", text("performed_at DESC")),
        Index(
            "ix_movements_from_location_node_id",
            "from_location_node_id",
            postgresql_where=text("from_location_node_id IS NOT NULL"),
        ),
        Index(
            "ix_movements_to_location_node_id",
            "to_location_node_id",
            postgresql_where=text("to_location_node_id IS NOT NULL"),
        ),
        CheckConstraint(
            "movement_type IN (" + ", ".join(f"'{t}'" for t in MOVEMENT_TYPES) + ")",
            name="ck_movements_type",
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
    lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    # Location System (Requirements v2 §4.1) node references — the only
    # location columns. A unit-IN (place) / transfer / unit-OUT (consume) sets
    # these; ``ck_movements_locations`` enforces the per-type rules.
    from_location_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    to_location_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    movement_type: Mapped[str] = mapped_column(Text, nullable=False)
    # Whole units only (integer). qty_delta is signed; qty_abs is the magnitude.
    qty_delta: Mapped[int] = mapped_column(Integer, nullable=False)
    qty_abs: Mapped[int] = mapped_column(Integer, nullable=False)
    # Mandatory comment (§3) captured on every e-signed place / transfer /
    # consume — the rationale for the action.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Links the second leg of a transfer back at the first. Only set on
    # the ``transfer_in`` row (the ``transfer_out`` is inserted first and
    # stays unlinked — the inverse lookup gets you to the partner).
    paired_movement_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.stock_movements.id", ondelete="RESTRICT"),
        nullable=True,
    )
    # The reauth-event row that authorised this movement (Chunk 4+).
    # Nullable because Chunk 2 smoke-test rows pre-date e-sign; new
    # rows from the receipt endpoint always populate it.
    reauth_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
        nullable=True,
    )
    performed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    performed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    # ── Relationships (read-only views) ────────────────────────────────
    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    lot: Mapped[Lot | None] = relationship(lazy="joined", viewonly=True)
    # Joined eagerly so the ledger and audit-timeline can show "by
    # <full_name>" without a per-row N+1.
    performed_by: Mapped[User] = relationship(
        foreign_keys=[performed_by_user_id],
        lazy="joined",
        viewonly=True,
    )


class ItemStock(Base):
    """Read-only mapping of the ``app.v_item_stock`` view.

    Backs an eager ``Item.stock`` relationship so list / detail reads
    pick up real ``qty_on_hand`` / ``status_code`` / ``last_movement_at``
    in a single query, with no manual JOIN logic in the repository.

    Marked as a view in two places:
      * ``__mapper_args__`` so SQLAlchemy doesn't expect INSERT/UPDATE
        capability on it;
      * the relationship is ``viewonly=True`` so flush ordering doesn't
        try to write into it.
    """

    __tablename__ = "v_item_stock"
    __table_args__ = {"schema": "app"}
    __mapper_args__ = {"eager_defaults": False}

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id"),
        primary_key=True,  # not a real PK on the view, just a mapper requirement
    )
    qty_on_hand: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    # Available = on-hand minus units in date-expired lots. Drives
    # status_code, reorder and forecasting; on-hand stays for visibility.
    qty_available: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    status_code: Mapped[str] = mapped_column(Text, nullable=False)
    last_movement_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# Eager-loaded ``Item.stock`` — single LEFT JOIN against the view on
# every list/get. Defined here (not on Item) so the forward reference
# to ItemStock resolves cleanly without a string lookup.
Item.stock = relationship(  # type: ignore[assignment]
    ItemStock,
    primaryjoin=Item.id == ItemStock.item_id,
    foreign_keys=[ItemStock.item_id],
    uselist=False,
    lazy="joined",
    viewonly=True,
)


# ── Item suppliers ───────────────────────────────────────────────────────
#
# An item's assigned suppliers — a plain many-to-many list. These ARE the
# suppliers an item can be received against (no separate approval concept).


class ItemSupplier(Base):
    """One supplier assigned to an item (zero-or-more per item).

    The set of these rows is an item's complete supplier list. Receipt intake
    only offers suppliers from this list — there is no on-the-fly supplier
    creation and no ``approval_status``.
    """

    __tablename__ = "item_suppliers"
    __table_args__ = (
        UniqueConstraint(
            "item_id", "supplier_id", name="uq_item_suppliers_item_supplier"
        ),
        Index("ix_item_suppliers_item_id", "item_id"),
        Index("ix_item_suppliers_supplier_id", "supplier_id"),
        {"schema": "meta"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="CASCADE"),
        nullable=False,
    )
    supplier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.suppliers.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    supplier: Mapped[Supplier] = relationship(lazy="joined", viewonly=True)


# Eager-loaded ``Item.suppliers`` — the assigned-supplier list, supplier joined.
# Defined here (not on Item) so the forward reference to ItemSupplier resolves
# without a string lookup, mirroring ``Item.stock``.
Item.suppliers = relationship(  # type: ignore[assignment]
    ItemSupplier,
    primaryjoin=Item.id == ItemSupplier.item_id,
    foreign_keys=[ItemSupplier.item_id],
    order_by=ItemSupplier.created_at,
    lazy="selectin",
    viewonly=True,
)


# Lifecycle of an Order (receipt transaction). Derived, never hand-set:
# ``open`` = no receive events yet; ``partially_received`` = some received,
# some still outstanding; ``received`` = every line fully received;
# ``cancelled`` = abandoned. Keep in lock-step with the DB CHECK + enum.
# (Requirements v3 — multi-item / partial / blanket Orders.)
RECEIPT_TRANSACTION_STATUSES: tuple[str, ...] = (
    "open",
    "partially_received",
    "received",
    "cancelled",
)


class ReceiptTransaction(Base):
    """Header for one **Order** (Requirements v3, multi-item / blanket).

    Groups one-or-more item ``lines`` and the dated ``events`` that receive
    them. Item now lives on the lines (the header carries no ``item_id``).
    Blanket Orders carry ``is_blanket`` + a ``valid_from``/``valid_to`` window
    and are drawn down by many receive events until fully received.
    """

    __tablename__ = "receipt_transactions"
    __table_args__ = (
        Index("ix_receipt_transactions_status", "status"),
        Index("ix_receipt_transactions_created_at_desc", text("created_at DESC")),
        Index(
            "uq_receipt_transactions_po_reference",
            "po_reference",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        CheckConstraint(
            "status IN ("
            + ", ".join(f"'{s}'" for s in RECEIPT_TRANSACTION_STATUSES)
            + ")",
            name="ck_receipt_transactions_status",
        ),
        CheckConstraint(
            "valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from",
            name="ck_receipt_transactions_valid_window",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'open'"),
    )
    po_reference: Mapped[str] = mapped_column(Text, nullable=False)
    is_blanket: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("false"),
    )
    valid_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    valid_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Stamped on the final receive that completes the Order.
    received_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
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

    # The Order's item lines (oldest-first), read-only.
    lines: Mapped[list[ReceiptTransactionLine]] = relationship(
        "ReceiptTransactionLine",
        primaryjoin=(
            "ReceiptTransaction.id == "
            "foreign(ReceiptTransactionLine.receipt_transaction_id)"
        ),
        order_by="ReceiptTransactionLine.line_no",
        viewonly=True,
    )
    # The dated receive events (newest-first), read-only.
    events: Mapped[list[ReceiptEvent]] = relationship(
        "ReceiptEvent",
        primaryjoin=(
            "ReceiptTransaction.id == foreign(ReceiptEvent.receipt_transaction_id)"
        ),
        order_by="ReceiptEvent.received_at",
        viewonly=True,
    )
    # The lots received under this Order (via its lines), read-only.
    lots: Mapped[list[Lot]] = relationship(
        "Lot",
        primaryjoin="ReceiptTransaction.id == foreign(Lot.receipt_transaction_id)",
        order_by="Lot.created_at",
        viewonly=True,
    )


class ReceiptTransactionLine(Base):
    """One item ordered on an Order (Requirements v3).

    Carries the item, the per-line supplier (∈ the item's ``meta.item_suppliers``),
    the ordered quantity and the agreed unit price. The *same* item may appear
    on several lines (split sourcing) — there is intentionally no
    ``UNIQUE(receipt_transaction_id, item_id)``. Received quantity is derived
    (summed from ``receipt_event_lines``), never stored here.
    """

    __tablename__ = "receipt_transaction_lines"
    __table_args__ = (
        Index("ix_receipt_transaction_lines_txn_id", "receipt_transaction_id"),
        Index("ix_receipt_transaction_lines_item_id", "item_id"),
        CheckConstraint(
            "ordered_qty > 0",
            name="ck_receipt_transaction_lines_ordered_qty_pos",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    receipt_transaction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_transactions.id", ondelete="CASCADE"),
        nullable=False,
    )
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    supplier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.suppliers.id", ondelete="RESTRICT"),
        nullable=False,
    )
    ordered_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price_amount: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2),
        nullable=True,
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

    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    supplier: Mapped[Supplier] = relationship(lazy="joined", viewonly=True)
    # The event-lines (draws) against this line — drives received/outstanding.
    event_lines: Mapped[list[ReceiptEventLine]] = relationship(
        "ReceiptEventLine",
        primaryjoin=(
            "ReceiptTransactionLine.id == "
            "foreign(ReceiptEventLine.receipt_transaction_line_id)"
        ),
        viewonly=True,
    )


class ReceiptEvent(Base):
    """One dated, e-signed receive event against an Order (Requirements v3).

    Many per Order (the blanket / partial draws). Each carries the delivery
    date and the reauth event that authorised it.
    """

    __tablename__ = "receipt_events"
    __table_args__ = (
        Index("ix_receipt_events_txn_id", "receipt_transaction_id"),
        Index("ix_receipt_events_received_at_desc", text("received_at DESC")),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    receipt_transaction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_transactions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    received_at: Mapped[date] = mapped_column(Date, nullable=False)
    received_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    reauth_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
        nullable=False,
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    # The per-line draws made in this event (read-only).
    lines: Mapped[list[ReceiptEventLine]] = relationship(
        "ReceiptEventLine",
        primaryjoin="ReceiptEvent.id == foreign(ReceiptEventLine.receipt_event_id)",
        viewonly=True,
    )
    # Joined eagerly so the receive history can show "by <full_name>" instead of
    # a raw user id, without a per-row N+1.
    received_by: Mapped[User] = relationship(
        foreign_keys=[received_by_user_id],
        lazy="joined",
        viewonly=True,
    )


class ReceiptEventLine(Base):
    """The quantity received for one Order line in one receive event.

    Creates exactly one lot (``lot_id``). ``over_receipt_reason`` is set only
    when this draw pushes the line past its ordered quantity.
    """

    __tablename__ = "receipt_event_lines"
    __table_args__ = (
        Index("ix_receipt_event_lines_event_id", "receipt_event_id"),
        Index("ix_receipt_event_lines_line_id", "receipt_transaction_line_id"),
        Index("ix_receipt_event_lines_lot_id", "lot_id"),
        UniqueConstraint(
            "receipt_event_id",
            "receipt_transaction_line_id",
            name="uq_receipt_event_lines_event_line",
        ),
        CheckConstraint(
            "qty_received > 0",
            name="ck_receipt_event_lines_qty_pos",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    receipt_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    receipt_transaction_line_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.receipt_transaction_lines.id", ondelete="RESTRICT"),
        nullable=False,
    )
    qty_received: Mapped[int] = mapped_column(Integer, nullable=False)
    over_receipt_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="RESTRICT"),
        nullable=False,
    )

    lot: Mapped[Lot] = relationship(lazy="joined", viewonly=True)
