"""reauth_consumption_and_movement_evidence

Two additions to support the first real write path (Chunk 4 — Receipt):

* ``audit.reauth_consumptions`` — append-only table that records
  *which* reauth evidence was used to authorise *which* write. The
  primary key is ``reauth_event_id`` itself, so a second insert with
  the same id raises ``UniqueViolation`` and the receipt rolls back.
  That single-row PK constraint is the entire replay-protection
  mechanism — no application-level locking needed.

* ``app.stock_movements.reauth_evidence_id`` — nullable FK back to
  ``audit.reauth_events``. Nullable because Chunk 2's smoke-test rows
  pre-date the e-sign requirement; receipts ship in this chunk with
  the column required at the route layer. We'll tighten the column to
  NOT NULL after v1 launch once any pre-e-sign rows are reconciled.

Like every other audit-side table, ``reauth_consumptions`` is fully
append-only: UPDATE, DELETE, and TRUNCATE all blocked at the trigger
level.

Revision ID: e1f2a3b4c5d6
Revises: d5e6f7a8b9c0
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── Immutability function for audit.reauth_consumptions ─────────────
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit.tg_reauth_consumptions_immutable()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION
                'audit.reauth_consumptions is append-only; rows cannot be modified or removed'
                USING ERRCODE = '23000';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    # ── audit.reauth_consumptions ───────────────────────────────────────
    op.create_table(
        "reauth_consumptions",
        # PK = reauth_event_id. This is the whole replay-protection
        # mechanism — one consumption per evidence, enforced by the
        # database, no race window.
        sa.Column(
            "reauth_event_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "audit.reauth_events.id",
                ondelete="RESTRICT",
                name="fk_reauth_consumptions_event_id_events",
            ),
            primary_key=True,
        ),
        sa.Column(
            "consumed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "consumed_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_reauth_consumptions_user_id_users",
            ),
            nullable=False,
        ),
        # The write that used the evidence — schema-qualified table name
        # (``app.stock_movements`` / ``app.items`` / etc.) + the row id.
        # Kept as plain text for now (different writes target different
        # tables); cross-table polymorphic FKs would need check constraints
        # we don't yet care to maintain.
        sa.Column("target_table", sa.Text(), nullable=False),
        sa.Column("target_id", UUID(as_uuid=True), nullable=False),
        sa.CheckConstraint(
            "char_length(target_table) > 0",
            name="ck_reauth_consumptions_target_table_not_blank",
        ),
        schema="audit",
    )
    op.create_index(
        "ix_reauth_consumptions_consumed_at_desc",
        "reauth_consumptions",
        [sa.text("consumed_at DESC")],
        schema="audit",
    )
    op.create_index(
        "ix_reauth_consumptions_user_id",
        "reauth_consumptions",
        ["consumed_by_user_id"],
        schema="audit",
    )

    # Immutability triggers (UPDATE + DELETE + TRUNCATE).
    op.execute(
        """
        CREATE TRIGGER tg_reauth_consumptions_no_update
        BEFORE UPDATE ON audit.reauth_consumptions
        FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_reauth_consumptions_no_delete
        BEFORE DELETE ON audit.reauth_consumptions
        FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_reauth_consumptions_no_truncate
        BEFORE TRUNCATE ON audit.reauth_consumptions
        FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_reauth_consumptions_immutable();
        """
    )

    # ── app.stock_movements.reauth_evidence_id ──────────────────────────
    # Adding a nullable column to an existing table is cheap in Postgres
    # (no rewrite). NULL on existing rows is fine — Chunk 2 smoke data
    # pre-dates the e-sign world. New receipts (Chunk 4) require it at
    # the route layer.
    op.add_column(
        "stock_movements",
        sa.Column(
            "reauth_evidence_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "audit.reauth_events.id",
                ondelete="RESTRICT",
                name="fk_movements_reauth_evidence_id_events",
            ),
            nullable=True,
        ),
        schema="app",
    )
    op.create_index(
        "ix_movements_reauth_evidence_id",
        "stock_movements",
        ["reauth_evidence_id"],
        postgresql_where=sa.text("reauth_evidence_id IS NOT NULL"),
        schema="app",
    )


def downgrade() -> None:
    op.drop_index(
        "ix_movements_reauth_evidence_id",
        table_name="stock_movements",
        schema="app",
    )
    op.drop_column("stock_movements", "reauth_evidence_id", schema="app")

    op.execute(
        "DROP TRIGGER IF EXISTS tg_reauth_consumptions_no_truncate ON audit.reauth_consumptions;"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS tg_reauth_consumptions_no_delete ON audit.reauth_consumptions;"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS tg_reauth_consumptions_no_update ON audit.reauth_consumptions;"
    )
    op.drop_index(
        "ix_reauth_consumptions_user_id",
        table_name="reauth_consumptions",
        schema="audit",
    )
    op.drop_index(
        "ix_reauth_consumptions_consumed_at_desc",
        table_name="reauth_consumptions",
        schema="audit",
    )
    op.drop_table("reauth_consumptions", schema="audit")
    op.execute("DROP FUNCTION IF EXISTS audit.tg_reauth_consumptions_immutable();")
