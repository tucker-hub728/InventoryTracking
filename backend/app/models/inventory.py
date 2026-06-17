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


# Single source of truth for accepted location kinds. The DB CHECK
# enforces the same set; keep these aligned with the Pydantic enum.
LOCATION_KINDS: tuple[str, ...] = (
    "LN2",
    "minus_80",
    "minus_20",
    "fridge",
    "room_temp",
    "cold_room",
    "incubator",
    "other",
)


class Location(Base):
    """Physical storage position — freezer, LN2 tank, fridge, bench, …

    Movements FK to this table via ``from_location_id`` / ``to_location_id``
    once the ledger ships. Master data: admin-created, rare changes;
    deactivate (not delete) when retired so historical movements still
    resolve their location name.
    """

    __tablename__ = "locations"
    __table_args__ = (
        Index("uq_locations_code", func.lower(text("code")), unique=True),
        Index("ix_locations_active", "is_active"),
        Index("ix_locations_kind", "kind"),
        CheckConstraint(
            "kind IN (" + ", ".join(f"'{k}'" for k in LOCATION_KINDS) + ")",
            name="ck_locations_kind",
        ),
        {"schema": "meta"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    temperature_c: Mapped[Decimal | None] = mapped_column(
        Numeric(6, 2),
        nullable=True,
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    coa_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'available'"),
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
    raise on any attempt to mutate. To correct a wrong entry, the API
    posts a counter-movement with ``reversal_of_id`` pointing at the
    original; both rows remain visible forever.

    E-signature columns (signed_by, signature_meaning, reauth_evidence_id)
    are intentionally absent — they're added in Chunk 4 along with the
    receipt endpoint.
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
    from_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    to_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    movement_type: Mapped[str] = mapped_column(Text, nullable=False)
    qty_delta: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    qty_abs: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    reason_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Free-text "where did it go" captured on a unit-out (dispense) — set by
    # the dispense wizard and the /ln2 Empty-position action; NULL otherwise.
    destination_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    reversal_of_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.stock_movements.id", ondelete="RESTRICT"),
        nullable=True,
    )
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
    from_location: Mapped[Location | None] = relationship(
        foreign_keys=[from_location_id],
        lazy="joined",
        viewonly=True,
    )
    to_location: Mapped[Location | None] = relationship(
        foreign_keys=[to_location_id],
        lazy="joined",
        viewonly=True,
    )
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
