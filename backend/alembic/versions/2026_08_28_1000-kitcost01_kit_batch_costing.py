"""kitcost01: per-batch material costing for kits (RPT-003)

    "Cost shall flow through kitting: issued quantities carry their lot cost, so
    a closed kit can be costed (materials only) and a per-kit or per-patient
    materials cost can be produced across all feeding days."
    — CellReady SRS Consolidated Amendment 9+10 (Aug 13, 2026)

    "The FG Lot-xxx should pull through all the costs. The Kit should capture
    the costs to that specific Lot — so the process scrap or material scrap and
    actual material costs are put to the Kit and the Kit is closed out to the FG
    Lot specifically so the Customer can be charged the actual cost for that
    particular FG Lot."
    — Blane Larson, 2026-08-27

Two tables. They exist because a kit can produce **more than one** finished lot
(KIT-007 incremental / serialized production, confirmed with the client
2026-08-28), and the client wants each lot billed at its own actual cost. The
kit-level total was already derivable from the ledger; the per-lot split was
not, and nothing in the schema recorded it.

## The number that was being thrown away

``_produce_batch`` knows exactly what each batch consumed — it is the
``used_by_line`` mapping in the request. But ``kit_lines.used_qty`` only
accumulates, ``_drain_production`` deliberately writes no movement (the material
left ``v_item_stock`` at issue, so consuming it is a zero-delta event), and the
minted lot was created without a price. So after three batches the system knew
the kit had consumed 300 units of material and had three finished lots, and
could not say which lot cost what.

``kit_production_batches`` is that missing row. ``kit_batch_consumptions`` is
its per-component breakdown, so the number on a customer's invoice can be
explained line by line rather than asserted.

## Scrap is INCLUDED, and it is a slice — never an addend

The client lists "process scrap or material scrap and actual material costs" as
three things put to the kit, and the customer is charged the result. Scrap is in
the bill. But it is **already inside** ``material_cost_amount``: scrapped
material was charged at issue and never credited back, so its value never left
the pool. What makes the customer pay for it is the **divisor** —
``material_cost_amount / good_qty``, good units only. Dividing by
``good_qty + scrap_qty`` would be CellReady absorbing the loss.

``scrap_value_amount`` therefore reports a *portion* of ``material_cost_amount``
(``scrap_qty × unit_cost_amount``), so the loss is visible on screen and in the
export. The CHECK ``scrap_value_amount <= material_cost_amount`` is what stops a
future reader from treating it as a fourth number to add.

Note this only covers **process** scrap (failed output units, ``kits.scrap_qty``).
There is no material-scrap column anywhere in the schema — spilled material is
folded into ``used_qty`` by the operator — so material waste is real, charged,
and invisible. Giving it its own quantity would change the close-out identity
and ``ck_kit_lines_no_overuse``; deliberately not done here.

## What this does NOT do, deliberately

**No new movement type.** ``MOVEMENT_TYPES`` is untouched. Consuming material
moves no stock, so it mints no movement — the same reasoning that made
``_drain_production`` silent in the first place. This matters beyond tidiness:
REQ-2026-08-18-PLN-002 requires the reorder trigger to fire at ISSUE, and its
guards (``test_planning_issue_trigger.py``) assert that no consumption-shaped
movement type exists. Those tests stay green *without being edited*, which is
the signal that this is the right shape.

**No column on ``app.lots``.** ``unit_price_amount`` already exists and already
means "per consume unit". A kit output now populates it instead of leaving it
NULL. Nothing about its semantics or its ``IS NULL OR >= 0`` CHECK changes —
which is what makes a $0 patient-cell lot (received on a 0$ PO) store as a real
zero while an unpriced lot stays blank. Those two are not the same fact and the
export must never merge them.

**No column on ``app.kit_lines``.** Cumulative consumed value is derived from
``kit_batch_consumptions`` rather than stored, so it cannot drift out of step
with ``used_qty``.

**No source-lot column on the consumption rows.** Cost is attributed as a moving
weighted average over what the kit still holds, so a batch consumes *value from
a pool*, not identified lots — recording lot ids there would invent a fact the
system does not have. Identified source lots do exist, in the ledger, on the
``kit_issue`` rows. Identified lots on the charge side, pooled value on the
consume side: that division is the design.

**No backfill.** Every AY/FG lot produced before this revision keeps a NULL
price. Their input prices are editable after the fact and per-batch attribution
never existed for them, so any computed figure would be one that was never true
— on records that may already have been billed. Blank means unknown.

Revision ID: kitcost01
Revises: kan01
Create Date: 2026-08-28 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "kitcost01"
down_revision: str | None = "kan01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "kit_production_batches",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("kit_id", postgresql.UUID(as_uuid=True), nullable=False),
        # 1-based, per kit. The operator's "batch 2 of this build".
        sa.Column("batch_no", sa.Integer(), nullable=False),
        # NULL when the batch made 0 good units. Reachable: CloseOutRequest
        # allows good_qty=0 (ProduceRequest does not), which is a final batch
        # that scrapped everything. It consumed material and minted no lot.
        sa.Column("output_lot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("good_qty", sa.Integer(), nullable=False),
        sa.Column("scrap_qty", sa.Integer(), nullable=False, server_default=sa.text("0")),
        # Total material value attributed to THIS batch. 6dp because it is a sum
        # of per-consume-unit prices which themselves carry 6 (see lots).
        sa.Column("material_cost_amount", sa.Numeric(18, 6), nullable=True),
        # material_cost_amount / good_qty — what one finished unit cost, and
        # what gets stamped onto lots.unit_price_amount.
        sa.Column("unit_cost_amount", sa.Numeric(14, 6), nullable=True),
        # scrap_qty x unit_cost_amount. A REPORTED SLICE of
        # material_cost_amount, never an addend to it. See the module docstring.
        sa.Column("scrap_value_amount", sa.Numeric(18, 6), nullable=True),
        # False when any input lot feeding this batch had no price. The three
        # money columns are then NULL — never a partial sum, which would read
        # as a complete one (RPT-001's blank-is-not-zero rule, one level up).
        sa.Column(
            "cost_is_complete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "produced_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("performed_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reauth_evidence_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_kit_production_batches"),
        sa.ForeignKeyConstraint(
            ["kit_id"],
            ["app.kits.id"],
            name="fk_kit_production_batches_kit",
            ondelete="CASCADE",
        ),
        # RESTRICT, not CASCADE: the lot outlives the batch record and may
        # already have shipped. Losing the costing row must not be possible by
        # deleting stock history.
        sa.ForeignKeyConstraint(
            ["output_lot_id"],
            ["app.lots.id"],
            name="fk_kit_production_batches_output_lot",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by_user_id"],
            ["app.users.id"],
            name="fk_kit_production_batches_performed_by",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["reauth_evidence_id"],
            ["audit.reauth_events.id"],
            name="fk_kit_production_batches_evidence",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("batch_no > 0", name="ck_kit_production_batches_batch_no_positive"),
        sa.CheckConstraint(
            "good_qty >= 0 AND scrap_qty >= 0",
            name="ck_kit_production_batches_qty_nonneg",
        ),
        # Mirrors lots.unit_price_amount exactly: $0 is a real, valid price (the
        # customer-owned cells arrive on a 0$ PO) and NULL means "not known".
        sa.CheckConstraint(
            "(material_cost_amount IS NULL OR material_cost_amount >= 0) "
            "AND (unit_cost_amount IS NULL OR unit_cost_amount >= 0) "
            "AND (scrap_value_amount IS NULL OR scrap_value_amount >= 0)",
            name="ck_kit_production_batches_money_nonneg",
        ),
        # Scrap value is a PORTION of the batch's material cost, not an extra
        # charge on top of it. This constraint is the encoding of that rule.
        sa.CheckConstraint(
            "scrap_value_amount IS NULL "
            "OR material_cost_amount IS NULL "
            "OR scrap_value_amount <= material_cost_amount",
            name="ck_kit_production_batches_scrap_is_slice",
        ),
        # A batch mints a lot exactly when it made something.
        sa.CheckConstraint(
            "(output_lot_id IS NULL) = (good_qty = 0)",
            name="ck_kit_production_batches_lot_pairing",
        ),
        # An incomplete cost carries no numbers at all.
        sa.CheckConstraint(
            "cost_is_complete OR ("
            "material_cost_amount IS NULL "
            "AND unit_cost_amount IS NULL "
            "AND scrap_value_amount IS NULL)",
            name="ck_kit_production_batches_incomplete_is_blank",
        ),
        schema="app",
    )
    op.create_index(
        "uq_kit_production_batches_kit_batch_no",
        "kit_production_batches",
        ["kit_id", "batch_no"],
        unique=True,
        schema="app",
    )
    # One batch per output lot. Partial because a scrap-only batch has no lot,
    # and several of those on one kit are legitimate.
    op.create_index(
        "uq_kit_production_batches_output_lot",
        "kit_production_batches",
        ["output_lot_id"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("output_lot_id IS NOT NULL"),
    )
    # The date-range export's driving scan (RPT-003 phase 2).
    op.create_index(
        "ix_kit_production_batches_produced_at_desc",
        "kit_production_batches",
        [sa.text("produced_at DESC")],
        schema="app",
    )

    op.create_table(
        "kit_batch_consumptions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kit_line_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Denormalised from the line so the export can group by component
        # without joining back through kit_lines.
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        # The line's moving weighted average AT THIS INSTANT, frozen. Lot prices
        # are editable after receive, so re-deriving this later would silently
        # change what a customer was charged.
        sa.Column("unit_cost_amount", sa.Numeric(14, 6), nullable=True),
        sa.Column("extended_value_amount", sa.Numeric(18, 6), nullable=True),
        sa.Column(
            "cost_is_complete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_kit_batch_consumptions"),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["app.kit_production_batches.id"],
            name="fk_kit_batch_consumptions_batch",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["kit_line_id"],
            ["app.kit_lines.id"],
            name="fk_kit_batch_consumptions_line",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_kit_batch_consumptions_item",
            ondelete="RESTRICT",
        ),
        # A consumption row records material actually consumed. Zero is not an
        # event; the row simply is not written.
        sa.CheckConstraint("qty > 0", name="ck_kit_batch_consumptions_qty_positive"),
        sa.CheckConstraint(
            "(unit_cost_amount IS NULL OR unit_cost_amount >= 0) "
            "AND (extended_value_amount IS NULL OR extended_value_amount >= 0)",
            name="ck_kit_batch_consumptions_money_nonneg",
        ),
        sa.CheckConstraint(
            "cost_is_complete OR (unit_cost_amount IS NULL AND extended_value_amount IS NULL)",
            name="ck_kit_batch_consumptions_incomplete_is_blank",
        ),
        schema="app",
    )
    op.create_index(
        "uq_kit_batch_consumptions_batch_line",
        "kit_batch_consumptions",
        ["batch_id", "kit_line_id"],
        unique=True,
        schema="app",
    )
    # The moving-average lookup: "what has this line already been charged out
    # to earlier batches?" Runs once per line on every produce, so it is hot.
    op.create_index(
        "ix_kit_batch_consumptions_kit_line_id",
        "kit_batch_consumptions",
        ["kit_line_id"],
        schema="app",
    )


def downgrade() -> None:
    op.drop_index("ix_kit_batch_consumptions_kit_line_id", "kit_batch_consumptions", schema="app")
    op.drop_index("uq_kit_batch_consumptions_batch_line", "kit_batch_consumptions", schema="app")
    op.drop_table("kit_batch_consumptions", schema="app")
    op.drop_index(
        "ix_kit_production_batches_produced_at_desc", "kit_production_batches", schema="app"
    )
    op.drop_index("uq_kit_production_batches_output_lot", "kit_production_batches", schema="app")
    op.drop_index("uq_kit_production_batches_kit_batch_no", "kit_production_batches", schema="app")
    op.drop_table("kit_production_batches", schema="app")
