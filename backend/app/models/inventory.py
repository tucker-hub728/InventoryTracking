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


class UnitOfMeasure(Base):
    """Small lookup of measurement units. Seeded by the migration."""

    __tablename__ = "units_of_measure"
    __table_args__ = {"schema": "meta"}

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    is_discrete: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("TRUE"),
    )


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
        Index("ix_items_vendor_id", "vendor_id"),
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

    # Free-form, optional grouping label. Reintroduced for Requirements v2
    # (Receipt Admin) — no lookup table and no CHECK, mirroring the
    # free-form ``item_number`` decision. See docs/modules/receipt-admin.md §1.1.
    category: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Optional *default* vendor. NOT the source of truth for what a lot was
    # sourced from (the lot is). The full approved-vendor set lives in
    # ``meta.item_approved_vendors`` (Requirements v2). See receipt-admin.md §1.3.
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.vendors.id", ondelete="RESTRICT"),
        nullable=True,
    )
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
    unit_price_amount: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2),
        nullable=True,
    )
    units_per_package: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_per_package_amount: Mapped[Decimal | None] = mapped_column(
        Numeric(14, 2),
        nullable=True,
    )
    uom_code: Mapped[str] = mapped_column(
        Text,
        ForeignKey("meta.units_of_measure.code", ondelete="RESTRICT"),
        nullable=False,
        server_default=text("'unit'"),
    )
    po_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    po_due_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    must_order_flag: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("FALSE"),
    )
    last_updated_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Stored as ``metadata_`` in Python because ``metadata`` collides with
    # SQLAlchemy's ``DeclarativeBase.metadata`` attribute. DB column name
    # is ``metadata_`` to match (consistent in both directions).
    metadata_: Mapped[dict] = mapped_column(
        "metadata_",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
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
    vendor: Mapped[Vendor | None] = relationship(lazy="joined", viewonly=True)
    uom: Mapped[UnitOfMeasure] = relationship(lazy="joined", viewonly=True)
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


# ── Receipt Admin v2 ───────────────────────────────────────────────────
#
# Item→Vendor approved mapping + the inbound receipt-transaction header.
# See docs/modules/receipt-admin.md.

# Approval state for an item↔vendor mapping. ``pending`` = added during a
# receipt for a previously-unknown vendor (edge case 2). Keep in lock-step
# with the DB CHECK and the Pydantic enum.
VENDOR_APPROVAL_STATUSES: tuple[str, ...] = ("approved", "pending")


class ItemApprovedVendor(Base):
    """Zero-or-more approved vendors per item (Requirements v2 §3).

    Receipt is never *blocked* by this list — it only drives which vendors
    are suggested and whether a created lot is flagged
    ``unverified_vendor_for_item``.
    """

    __tablename__ = "item_approved_vendors"
    __table_args__ = (
        UniqueConstraint(
            "item_id", "vendor_id", name="uq_item_approved_vendors_item_vendor"
        ),
        Index("ix_item_approved_vendors_item_id", "item_id"),
        Index("ix_item_approved_vendors_vendor_id", "vendor_id"),
        CheckConstraint(
            "approval_status IN ("
            + ", ".join(f"'{s}'" for s in VENDOR_APPROVAL_STATUSES)
            + ")",
            name="ck_item_approved_vendors_status",
        ),
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
    approval_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'approved'"),
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


# Lifecycle of an inbound receipt transaction. ``open`` = lots created
# ON_ORDER; ``received`` = physical receipt confirmed; ``cancelled`` =
# abandoned before receipt. Keep in lock-step with the DB CHECK + enum.
RECEIPT_TRANSACTION_STATUSES: tuple[str, ...] = ("open", "received", "cancelled")


class ReceiptTransaction(Base):
    """Header for one inbound processing event (Requirements v2 §4–§5).

    Groups the lots created by a single intake and records the physical
    receipt confirmation. One item per transaction; multiple vendors / lots
    are allowed within it (edge case 3).
    """

    __tablename__ = "receipt_transactions"
    __table_args__ = (
        Index("ix_receipt_transactions_item_id", "item_id"),
        Index("ix_receipt_transactions_status", "status"),
        Index("ix_receipt_transactions_created_at_desc", text("created_at DESC")),
        CheckConstraint(
            "status IN ("
            + ", ".join(f"'{s}'" for s in RECEIPT_TRANSACTION_STATUSES)
            + ")",
            name="ck_receipt_transactions_status",
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
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'open'"),
    )
    po_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    received_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    received_at: Mapped[datetime | None] = mapped_column(
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

    item: Mapped[Item] = relationship(lazy="joined", viewonly=True)
    # The lots created by this intake (newest-first), read-only.
    lots: Mapped[list[Lot]] = relationship(
        "Lot",
        primaryjoin="ReceiptTransaction.id == foreign(Lot.receipt_transaction_id)",
        order_by="Lot.created_at",
        viewonly=True,
    )
