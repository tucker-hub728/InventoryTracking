"""Kitting / back-flush ORM — kits and their component lines.

Implements ``docs/modules/kitting.md``. A kit gathers the components of a
sub-assembly (AY) or finished good (FG), issues them to production, then at
close-out reconciles what was used and back-flushes the leftover. Every
quantity change is an ``app.stock_movements`` row (append-only ledger); these
tables hold the kit's own state, not stock — on-hand stays derived through
``app.v_item_stock``.

Design decisions (see the module doc §0):
  * Consumables are never in a BOM, so a kit line is never a consumable.
  * Kitted material leaves *available* stock at issue (TRX-001) and MOVES to
    the production node, which holds the WIP until close-out (§0.3a,
    Transaction_Spec §2). Corrected 2026-07-21 — the production location is
    NOT advisory; the old §99.3 "no WIP bucket" resolution was withdrawn.
  * ``used_qty`` may not exceed ``issued + additional - early_returned`` — the
    over-use guard is a DB CHECK (§0.7).
  * Excess may be returned to inventory at any point in production, with no lot
    assignment (``early_returned_qty``, REQ-2026-07-01-TRX-008).
  * Cancel works from draft (no movements) and post-issue (returns everything).
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
    Integer,
    Numeric,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Kit lifecycle. A native PG enum ``app.kit_status`` (client 2026-07-20 — a
# deliberate exception to the house TEXT+CHECK convention used by
# MOVEMENT_TYPES / LOT_STATUSES). The migration owns the type; the model
# references it with ``create_type=False`` (same pattern as invite_status).
KIT_STATUSES: tuple[str, ...] = (
    "draft",
    "issued",
    "in_production",
    "closed",
    "cancelled",
)

kit_status_enum = ENUM(*KIT_STATUSES, name="kit_status", schema="app", create_type=False)


class Kit(Base):
    """A build order for one sub-assembly or finished good."""

    __tablename__ = "kits"
    __table_args__ = (
        # Human id ``KIT-0001`` (from app.kit_number_seq), unique among live rows.
        Index(
            "uq_kits_kit_number",
            "kit_number",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_kits_status", "status"),
        Index("ix_kits_item_id", "item_id"),
        Index("ix_kits_created_at_desc", text("created_at DESC")),
        CheckConstraint("target_qty > 0", name="ck_kits_target_qty_positive"),
        CheckConstraint("good_qty IS NULL OR good_qty >= 0", name="ck_kits_good_qty_nonneg"),
        CheckConstraint("scrap_qty IS NULL OR scrap_qty >= 0", name="ck_kits_scrap_qty_nonneg"),
        # status domain is enforced by the app.kit_status enum, not a CHECK.
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    kit_number: Mapped[str] = mapped_column(Text, nullable=False)
    # The AY/FG being built. Table-qualify vs. ``kit_lines.item_id`` (a component).
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    target_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        kit_status_enum, nullable=False, server_default=text("'draft'::app.kit_status")
    )
    # Where the build happens — and it HOLDS the WIP: issue relocates material
    # here and close-out drains it (§0.3a). The old "advisory, holds no stock"
    # note was the withdrawn §99.3 resolution.
    production_location_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Set at close-out — where the finished quantity is stocked.
    output_location_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    good_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scrap_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    issued_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
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
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    lines: Mapped[list[KitLine]] = relationship(
        back_populates="kit",
        cascade="all, delete-orphan",
        order_by="KitLine.line_no",
    )
    # One row per produce/close-out batch that ran (RPT-003). A kit can produce
    # several finished lots (KIT-007), so this is where per-lot cost lives —
    # ``kits`` itself carries only the cumulative good/scrap totals.
    batches: Mapped[list[KitProductionBatch]] = relationship(
        back_populates="kit",
        cascade="all, delete-orphan",
        order_by="KitProductionBatch.batch_no",
    )


class KitLine(Base):
    """One BOM component of a kit, snapshotted at creation."""

    __tablename__ = "kit_lines"
    __table_args__ = (
        Index("ix_kit_lines_kit_id", "kit_id"),
        Index("uq_kit_lines_kit_item", "kit_id", "item_id", unique=True),
        Index("uq_kit_lines_kit_line_no", "kit_id", "line_no", unique=True),
        CheckConstraint("qty_per_unit > 0", name="ck_kit_lines_qty_per_unit_positive"),
        CheckConstraint("issued_qty >= 0", name="ck_kit_lines_issued_qty_nonneg"),
        CheckConstraint(
            "additional_issued_qty >= 0",
            name="ck_kit_lines_additional_issued_qty_nonneg",
        ),
        CheckConstraint("used_qty IS NULL OR used_qty >= 0", name="ck_kit_lines_used_qty_nonneg"),
        CheckConstraint("early_returned_qty >= 0", name="ck_kit_lines_early_returned_qty_nonneg"),
        # You can't hand back more than you pulled (TRX-008 return guard).
        CheckConstraint(
            "early_returned_qty <= issued_qty + additional_issued_qty",
            name="ck_kit_lines_return_le_issued",
        ),
        # The over-use guard (§0.7), net of anything already returned (TRX-008).
        CheckConstraint(
            "used_qty IS NULL "
            "OR used_qty <= issued_qty + additional_issued_qty - early_returned_qty",
            name="ck_kit_lines_no_overuse",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    kit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.kits.id", ondelete="CASCADE"),
        nullable=False,
    )
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # The component (CR or nested AY) — never a consumable (§0.2).
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Snapshot of bom_lines.qty_per_unit at creation. needed_qty is derived
    # = qty_per_unit × kits.target_qty (not stored).
    qty_per_unit: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    issued_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    additional_issued_qty: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    used_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Handed back to inventory BEFORE close-out (TRX-008). On-floor quantity is
    # ``issued + additional - early_returned``.
    early_returned_qty: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    source_location_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
    )
    # Defaults to source, editable per line at close-out (Table 3).
    return_location_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=True,
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

    kit: Mapped[Kit] = relationship(back_populates="lines")


class KitProductionBatch(Base):
    """One produce (or close-out) batch, and what its output lot cost — RPT-003.

    A kit may run several batches (KIT-007 incremental / serialized production),
    each minting its own lot, and the client bills per finished lot: *"the Kit is
    closed out to the FG Lot specifically so the Customer can be charged the
    actual cost for that particular FG Lot"* (2026-08-27). A kit-level average
    would smear one batch's cost onto another batch's lot, so cost is attributed
    here, per batch, and stamped onto ``lots.unit_price_amount`` at mint.

    **The scrap loss is DERIVED, not stored.** Scrapped material was charged at
    issue and never credited back, so it is already inside
    ``material_cost_amount``; what makes the customer pay for it is dividing by
    ``good_qty`` alone. ``costing.scrap_value()`` prorates it over units
    *attempted* at read time. It was a column here briefly and did not survive
    review — every input to it sits in this row and is frozen alongside it, so
    storing it bought nothing a computation does not, and the CHECK that kept it
    ``<= material_cost_amount`` is now redundant with the proration itself.

    Both money columns are NULL together when ``cost_is_complete`` is
    false — an input lot had no price, and a partial sum would read as a
    complete one (RPT-001's blank-is-never-zero rule, one level up).
    """

    __tablename__ = "kit_production_batches"
    __table_args__ = (
        Index(
            "uq_kit_production_batches_kit_batch_no",
            "kit_id",
            "batch_no",
            unique=True,
        ),
        Index(
            "uq_kit_production_batches_output_lot",
            "output_lot_id",
            unique=True,
            postgresql_where=text("output_lot_id IS NOT NULL"),
        ),
        Index("ix_kit_production_batches_produced_at_desc", text("produced_at DESC")),
        CheckConstraint("batch_no > 0", name="ck_kit_production_batches_batch_no_positive"),
        CheckConstraint(
            "good_qty >= 0 AND scrap_qty >= 0",
            name="ck_kit_production_batches_qty_nonneg",
        ),
        # Mirrors lots.unit_price_amount: $0 is a real price (customer-owned
        # cells arrive on a 0$ PO); NULL means "not known".
        CheckConstraint(
            "(material_cost_amount IS NULL OR material_cost_amount >= 0) "
            "AND (unit_cost_amount IS NULL OR unit_cost_amount >= 0)",
            name="ck_kit_production_batches_money_nonneg",
        ),
        CheckConstraint(
            "(output_lot_id IS NULL) = (good_qty = 0)",
            name="ck_kit_production_batches_lot_pairing",
        ),
        CheckConstraint(
            "cost_is_complete OR ("
            "material_cost_amount IS NULL AND unit_cost_amount IS NULL)",
            name="ck_kit_production_batches_incomplete_is_blank",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    kit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.kits.id", ondelete="CASCADE"),
        nullable=False,
    )
    batch_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # NULL when the batch made 0 good units — a final close-out that scrapped
    # everything consumes material and mints no lot.
    output_lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.lots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    good_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    scrap_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    material_cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    unit_cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 6), nullable=True)
    cost_is_complete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    produced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    performed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    reauth_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
        nullable=True,
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

    kit: Mapped[Kit] = relationship(back_populates="batches")
    consumptions: Mapped[list[KitBatchConsumption]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
    )


class KitBatchConsumption(Base):
    """What one batch drew from one kit line, and what that value was — RPT-003.

    The per-component breakdown behind ``KitProductionBatch.material_cost_amount``,
    so a customer's figure can be explained rather than asserted.

    ``unit_cost_amount`` is the line's moving weighted average at the moment
    this batch consumed it. It is **recomputed** if an input lot's price is
    later corrected (``kitting/recompute.py``), so it stays the cost of what was
    actually bought rather than a snapshot of a price since found wrong. It is
    stored rather than derived because the average is path-dependent — replaying
    it needs every batch in order — and because ``extended_value_amount`` is
    computed from the *unrounded* figure, so the two do not recover each other.

    There is deliberately **no item column**: the component is
    ``kit_line.item_id``, one FK hop away and already loaded wherever this is
    read. There is deliberately **no source-lot column**: under a moving average a
    batch consumes value from a pool, not identified lots, and naming one here
    would invent a fact. The identified lots live in the ledger, on the
    ``kit_issue`` rows.
    """

    __tablename__ = "kit_batch_consumptions"
    __table_args__ = (
        Index(
            "uq_kit_batch_consumptions_batch_line",
            "batch_id",
            "kit_line_id",
            unique=True,
        ),
        Index("ix_kit_batch_consumptions_kit_line_id", "kit_line_id"),
        # A row records material actually consumed; zero is not an event.
        CheckConstraint("qty > 0", name="ck_kit_batch_consumptions_qty_positive"),
        CheckConstraint(
            "(unit_cost_amount IS NULL OR unit_cost_amount >= 0) "
            "AND (extended_value_amount IS NULL OR extended_value_amount >= 0)",
            name="ck_kit_batch_consumptions_money_nonneg",
        ),
        CheckConstraint(
            "cost_is_complete OR (unit_cost_amount IS NULL AND extended_value_amount IS NULL)",
            name="ck_kit_batch_consumptions_incomplete_is_blank",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.kit_production_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    kit_line_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.kit_lines.id", ondelete="CASCADE"),
        nullable=False,
    )
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_cost_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 6), nullable=True)
    extended_value_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    cost_is_complete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    batch: Mapped[KitProductionBatch] = relationship(back_populates="consumptions")
