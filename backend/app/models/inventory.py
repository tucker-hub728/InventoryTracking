"""Inventory ORM — vendors, UOMs, items, locations, lots.

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


class Vendor(Base):
    """Sourcing partner. Items optionally reference one."""

    __tablename__ = "vendors"
    __table_args__ = (
        Index("uq_vendors_name", func.lower(text("name")), unique=True),
        Index("ix_vendors_active", "is_active"),
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


class Item(Base):
    """Inventory catalogue row. One per Excel master tracker line.

    Quantities are NOT on this table — they're derived from the ledger
    once the movements module ships. ``status`` is similarly derived.
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

    # An item's assigned vendors live in ``meta.item_vendors`` (the ``vendors``
    # relationship below). There is no single default-vendor column — the list
    # is the source of truth for which vendors an item can be received against.
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
    # ``vendors`` (the assigned-vendor list) is defined after ItemVendor
    # below, mirroring the ``stock`` relationship pattern.
    creator: Mapped[User] = relationship(
        foreign_keys=[created_by_user_id],
        viewonly=True,
    )
    updater: Mapped[User] = relationship(
        foreign_keys=[updated_by_user_id],
        viewonly=True,
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
        Index("ix_lots_vendor_id", "vendor_id"),
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
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.vendors.id", ondelete="RESTRICT"),
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
    vendor: Mapped[Vendor | None] = relationship(lazy="joined", viewonly=True)


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


# ── Item vendors ───────────────────────────────────────────────────────
#
# An item's assigned vendors — a plain many-to-many list. These ARE the
# vendors an item can be received against (no separate approval concept).


class ItemVendor(Base):
    """One vendor assigned to an item (zero-or-more per item).

    The set of these rows is an item's complete vendor list. Receipt intake
    only offers vendors from this list — there is no on-the-fly vendor
    creation and no ``approval_status``.
    """

    __tablename__ = "item_vendors"
    __table_args__ = (
        UniqueConstraint(
            "item_id", "vendor_id", name="uq_item_vendors_item_vendor"
        ),
        Index("ix_item_vendors_item_id", "item_id"),
        Index("ix_item_vendors_vendor_id", "vendor_id"),
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
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.vendors.id", ondelete="RESTRICT"),
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

    vendor: Mapped[Vendor] = relationship(lazy="joined", viewonly=True)


# Eager-loaded ``Item.vendors`` — the assigned-vendor list, vendor joined.
# Defined here (not on Item) so the forward reference to ItemVendor resolves
# without a string lookup, mirroring ``Item.stock``.
Item.vendors = relationship(  # type: ignore[assignment]
    ItemVendor,
    primaryjoin=Item.id == ItemVendor.item_id,
    foreign_keys=[ItemVendor.item_id],
    order_by=ItemVendor.created_at,
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

    Carries the item, the per-line vendor (∈ the item's ``meta.item_vendors``),
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
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.vendors.id", ondelete="RESTRICT"),
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
    vendor: Mapped[Vendor] = relationship(lazy="joined", viewonly=True)
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
