"""stock_movements_and_ledger_view

The ledger backbone. Three artefacts:

* ``app.stock_movements`` — append-only journal. Every change to
  ``qty_on_hand`` is one row; nothing is ever updated or deleted, even
  for corrections (post a counter-movement instead). Enforced by a
  BEFORE UPDATE / BEFORE DELETE trigger that ``RAISE EXCEPTION``s
  unconditionally.

* ``app.tg_movements_immutable()`` — the trigger function used by both
  the UPDATE and DELETE triggers. Centralised so the error message is
  consistent and a future audit-bypass procedure has one place to
  switch on.

* ``app.v_item_stock`` — derived view returning
  ``(item_id, qty_on_hand, status_code, last_movement_at)``. The items
  list / detail JOIN this so the previously-hardcoded zeros become
  real numbers. ``status_code`` is computed from ``qty_on_hand`` and
  ``items.reorder_threshold``.

E-signature columns (``signed_by_user_id``, ``signature_meaning``,
``reauth_evidence_id`` …) are deliberately NOT added here — they ship
in Chunk 4 (receipt + reauth). The table is empty in this chunk so
the schema-add later is cheap.

Revision ID: a1b2c3d4e5f6
Revises: f3a7b8c9d0e1
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "f3a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Movement-type whitelist. Keep aligned with the Pydantic
# ``MovementType`` enum + the frontend's typed client.
#
# * receipt        — vendor → stock (qty_delta > 0)
# * dispense       — stock → use    (qty_delta < 0)
# * adjustment     — variance/count correction (qty_delta signed)
# * discard        — expired / damaged / contaminated (qty_delta < 0)
# * transfer_out   — paired with transfer_in; same item, two locations
# * transfer_in    — second leg of a transfer (qty_delta > 0)
MOVEMENT_TYPES: tuple[str, ...] = (
    "receipt",
    "dispense",
    "adjustment",
    "discard",
    "transfer_out",
    "transfer_in",
)


def upgrade() -> None:
    # ── Immutability trigger fn ─────────────────────────────────────────
    op.execute(
        """
        CREATE OR REPLACE FUNCTION app.tg_movements_immutable()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION
                'app.stock_movements is append-only; reverse via counter-movement instead'
                USING ERRCODE = '23000';  -- integrity_constraint_violation
            RETURN NULL;  -- never reached, keeps the planner happy
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    # ── app.stock_movements ─────────────────────────────────────────────
    op.create_table(
        "stock_movements",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_movements_item_id_items",
            ),
            nullable=False,
        ),
        # ``lot_id`` is OPTIONAL on the table to allow bootstrapping
        # adjustments / opening balances for items without lot info.
        # Receipt + dispense endpoints (future chunks) require it
        # at the API layer.
        sa.Column(
            "lot_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.lots.id",
                ondelete="RESTRICT",
                name="fk_movements_lot_id_lots",
            ),
            nullable=True,
        ),
        sa.Column(
            "from_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.locations.id",
                ondelete="RESTRICT",
                name="fk_movements_from_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column(
            "to_location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.locations.id",
                ondelete="RESTRICT",
                name="fk_movements_to_location_id_locations",
            ),
            nullable=True,
        ),
        sa.Column("movement_type", sa.Text(), nullable=False),
        # Signed delta — the running balance is ``SUM(qty_delta)``.
        sa.Column("qty_delta", sa.Numeric(14, 3), nullable=False),
        # Unsigned magnitude — what the operator entered ("dispense 5 vials").
        # Stored so UI doesn't need ``ABS()`` everywhere; CHECK keeps it
        # consistent with ``qty_delta``.
        sa.Column("qty_abs", sa.Numeric(14, 3), nullable=False),
        sa.Column("reason_code", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        # Free-form pointer back to the originating document (PO #,
        # patient batch, study ID, …). Indexed if/when we need it.
        sa.Column("reference", sa.Text(), nullable=True),
        # Self-FK: when set, this row reverses ``reversal_of_id``.
        # The reversal_of row's qty_delta + this row's qty_delta should
        # sum to zero. Validated at the route level, not in SQL.
        sa.Column(
            "reversal_of_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.stock_movements.id",
                ondelete="RESTRICT",
                name="fk_movements_reversal_of_id",
            ),
            nullable=True,
        ),
        # Who performed the action (the operator) — distinct from the
        # e-signer once we add that in Chunk 4 (often the same person).
        sa.Column(
            "performed_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_movements_performed_by_user_id_users",
            ),
            nullable=False,
        ),
        # When the action happened in the lab. May differ from
        # ``created_at`` for back-dated entries (rare; flag in notes).
        sa.Column(
            "performed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # When the row was INSERTed. Immutable — no UPDATE trigger fires
        # because the trigger raises before that's possible.
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # ── Invariants ──────────────────────────────────────────────────
        sa.CheckConstraint(
            "movement_type IN (" + ", ".join(f"'{t}'" for t in MOVEMENT_TYPES) + ")",
            name="ck_movements_type",
        ),
        sa.CheckConstraint("qty_abs > 0", name="ck_movements_qty_abs_positive"),
        # Sign of ``qty_delta`` must match the magnitude of ``qty_abs``
        # (i.e. they only differ by sign). This is the cheap version of
        # "the wire shape can't lie about direction."
        sa.CheckConstraint(
            "abs(qty_delta) = qty_abs",
            name="ck_movements_delta_magnitude",
        ),
        # Per-type sign rules. Adjustment is the only signed type.
        sa.CheckConstraint(
            """
            (movement_type IN ('receipt', 'transfer_in') AND qty_delta > 0)
            OR (movement_type IN ('dispense', 'discard', 'transfer_out') AND qty_delta < 0)
            OR (movement_type = 'adjustment')
            """,
            name="ck_movements_type_sign",
        ),
        # Location requirements: receipts have ``to`` only, dispenses /
        # discards have ``from`` only, transfers have both, adjustments
        # may have neither.
        sa.CheckConstraint(
            """
            (movement_type = 'receipt'      AND from_location_id IS NULL AND to_location_id IS NOT NULL)
            OR (movement_type IN ('dispense', 'discard') AND from_location_id IS NOT NULL AND to_location_id IS NULL)
            OR (movement_type = 'transfer_out' AND from_location_id IS NOT NULL AND to_location_id IS NULL)
            OR (movement_type = 'transfer_in'  AND from_location_id IS NULL AND to_location_id IS NOT NULL)
            OR (movement_type = 'adjustment')
            """,
            name="ck_movements_locations",
        ),
        # A reversal can't reverse itself.
        sa.CheckConstraint(
            "reversal_of_id IS NULL OR reversal_of_id <> id",
            name="ck_movements_no_self_reversal",
        ),
        schema="app",
    )

    # Indexes for hot paths:
    # 1) per-item ledger (detail page, recall query)
    op.create_index(
        "ix_movements_item_id_performed_at",
        "stock_movements",
        ["item_id", sa.text("performed_at DESC")],
        schema="app",
    )
    # 2) per-lot recall ("everything from lot X")
    op.create_index(
        "ix_movements_lot_id",
        "stock_movements",
        ["lot_id"],
        postgresql_where=sa.text("lot_id IS NOT NULL"),
        schema="app",
    )
    # 3) per-type reports
    op.create_index(
        "ix_movements_type",
        "stock_movements",
        ["movement_type"],
        schema="app",
    )
    # 4) global ledger ordered by recency
    op.create_index(
        "ix_movements_performed_at_desc",
        "stock_movements",
        [sa.text("performed_at DESC")],
        schema="app",
    )

    # ── Immutability triggers (UPDATE + DELETE) ─────────────────────────
    op.execute(
        """
        CREATE TRIGGER tg_stock_movements_no_update
        BEFORE UPDATE ON app.stock_movements
        FOR EACH ROW EXECUTE FUNCTION app.tg_movements_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_stock_movements_no_delete
        BEFORE DELETE ON app.stock_movements
        FOR EACH ROW EXECUTE FUNCTION app.tg_movements_immutable();
        """
    )

    # ── app.v_item_stock view ───────────────────────────────────────────
    #
    # LEFT JOIN so items with zero movements still appear with
    # ``qty_on_hand = 0`` and ``status_code = 'out_of_stock'``. Soft-
    # deleted items are excluded so the view matches what the items
    # list shows.
    op.execute(
        """
        CREATE OR REPLACE VIEW app.v_item_stock AS
        SELECT
            i.id AS item_id,
            COALESCE(SUM(m.qty_delta), 0)::numeric(14, 3) AS qty_on_hand,
            CASE
                WHEN COALESCE(SUM(m.qty_delta), 0) <= 0
                    THEN 'out_of_stock'
                WHEN COALESCE(SUM(m.qty_delta), 0) <= i.reorder_threshold
                    THEN 'low_stock'
                ELSE 'available'
            END AS status_code,
            MAX(m.performed_at) AS last_movement_at
        FROM app.items i
        LEFT JOIN app.stock_movements m ON m.item_id = i.id
        WHERE i.deleted_at IS NULL
        GROUP BY i.id, i.reorder_threshold;
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS app.v_item_stock;")
    op.execute("DROP TRIGGER IF EXISTS tg_stock_movements_no_delete ON app.stock_movements;")
    op.execute("DROP TRIGGER IF EXISTS tg_stock_movements_no_update ON app.stock_movements;")
    op.drop_index(
        "ix_movements_performed_at_desc", table_name="stock_movements", schema="app"
    )
    op.drop_index("ix_movements_type", table_name="stock_movements", schema="app")
    op.drop_index("ix_movements_lot_id", table_name="stock_movements", schema="app")
    op.drop_index(
        "ix_movements_item_id_performed_at",
        table_name="stock_movements",
        schema="app",
    )
    op.drop_table("stock_movements", schema="app")
    op.execute("DROP FUNCTION IF EXISTS app.tg_movements_immutable();")
