"""orders_multi_item_v3

Receipt Admin v3 — turn the single-item "receipt transaction" into a
multi-item **Order** with **partial / blanket** receiving. See
``docs/modules/receipt-admin.md`` (v3).

Adds, in dependency order:

  1. ``app.receipt_transactions`` columns: ``is_blanket``, ``valid_from``,
     ``valid_to``, ``deleted_at`` (+ a valid-window CHECK); widens the status
     CHECK to include ``partially_received``; makes ``po_reference`` NOT NULL
     and **unique** (per non-deleted Order).
  2. ``app.receipt_transaction_lines``  — one item line per Order (NEW).
  3. ``app.lots.receipt_transaction_line_id`` — the Order line a lot was
     received against (NEW FK).
  4. ``app.receipt_events`` + ``app.receipt_event_lines`` — dated, e-signed
     receive events and their per-line draws (NEW; partial / blanket).
  5. **Drops** the header ``app.receipt_transactions.item_id`` (item now lives
     on the lines).

Data migration (verified against dev 2026-06-29, head ``c8d9e0f1a2b3``):
  * 15 Orders (2 open / 13 received), 23 lots linked to Orders, every Order has
    >= 1 lot. Backfill = **one line per existing lot** (decision: lossless,
    preserves per-lot vendor / price). The same item may repeat across lines —
    there is **no** ``UNIQUE(txn, item)``.
  * 3 legacy linked lots have NULL ``ordered_qty`` — backfilled as
    ``GREATEST(COALESCE(ordered_qty, 1), 1)`` (planning data only; on-hand stays
    ledger-derived).
  * 1 duplicate ``po_reference`` (``PO-26-0000`` on 2 Orders) — extras are
    auto-suffixed ``<po>-<short-id>`` before the unique index is added.

Reversible (downgrade is functional but lossy: re-derives the single header
``item_id`` from the first line, maps ``partially_received`` back to ``open``,
and cannot un-suffix de-duplicated ``po_reference``).

**NOT auto-applied.** Review, then run ``alembic upgrade head`` against the
target DB manually.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "d9e0f1a2b3c4"
down_revision: str | None = "c8d9e0f1a2b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Real (naming-convention double-prefixed) constraint name on dev — verified
# via pg_constraint. A blind drop of the logical name would miss it.
_STATUS_CK = "ck_receipt_transactions_ck_receipt_transactions_status"


def upgrade() -> None:
    # ── 1) receipt_transactions: header additions ──────────────────────────
    op.add_column(
        "receipt_transactions",
        sa.Column(
            "is_blanket",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        schema="app",
    )
    op.add_column(
        "receipt_transactions",
        sa.Column("valid_from", sa.Date(), nullable=True),
        schema="app",
    )
    op.add_column(
        "receipt_transactions",
        sa.Column("valid_to", sa.Date(), nullable=True),
        schema="app",
    )
    op.add_column(
        "receipt_transactions",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema="app",
    )
    op.create_check_constraint(
        "ck_receipt_transactions_valid_window",
        "receipt_transactions",
        "valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from",
        schema="app",
    )

    # Widen the status CHECK to add 'partially_received'. Raw SQL with the real
    # constraint name avoids naming-convention surprises on drop.
    op.execute(f"ALTER TABLE app.receipt_transactions DROP CONSTRAINT {_STATUS_CK}")
    op.execute(
        f"ALTER TABLE app.receipt_transactions ADD CONSTRAINT {_STATUS_CK} "
        "CHECK (status IN ('open', 'partially_received', 'received', 'cancelled'))"
    )

    # po_reference → NOT NULL + unique (per non-deleted Order). De-dup first:
    # keep the earliest row of each duplicate group clean, suffix the rest.
    op.execute(
        """
        WITH dups AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY lower(btrim(po_reference))
                       ORDER BY created_at, id
                   ) AS rn
            FROM app.receipt_transactions
            WHERE po_reference IS NOT NULL AND deleted_at IS NULL
        )
        UPDATE app.receipt_transactions t
        SET po_reference = t.po_reference || '-' || left(t.id::text, 8)
        FROM dups
        WHERE dups.id = t.id AND dups.rn > 1
        """
    )
    op.alter_column(
        "receipt_transactions",
        "po_reference",
        existing_type=sa.Text(),
        nullable=False,
        schema="app",
    )
    op.create_index(
        "uq_receipt_transactions_po_reference",
        "receipt_transactions",
        ["po_reference"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    # ── 2) receipt_transaction_lines (NEW) ─────────────────────────────────
    op.create_table(
        "receipt_transaction_lines",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "receipt_transaction_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("line_no", sa.Integer(), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("vendor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordered_qty", sa.Integer(), nullable=False),
        sa.Column("unit_price_amount", sa.Numeric(14, 2), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["receipt_transaction_id"],
            ["app.receipt_transactions.id"],
            name="fk_receipt_transaction_lines_txn_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_receipt_transaction_lines_item_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["meta.vendors.id"],
            name="fk_receipt_transaction_lines_vendor_id",
            ondelete="RESTRICT",
        ),
        # Intentionally NO unique(txn, item): the same item may appear on
        # several lines, each its own vendor / price (split sourcing).
        sa.CheckConstraint(
            "ordered_qty > 0", name="ck_receipt_transaction_lines_ordered_qty_pos"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_receipt_transaction_lines"),
        schema="app",
    )
    op.create_index(
        "ix_receipt_transaction_lines_txn_id",
        "receipt_transaction_lines",
        ["receipt_transaction_id"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_transaction_lines_item_id",
        "receipt_transaction_lines",
        ["item_id"],
        schema="app",
    )

    # ── 3) lots.receipt_transaction_line_id (NEW FK) ───────────────────────
    op.add_column(
        "lots",
        sa.Column(
            "receipt_transaction_line_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        schema="app",
    )
    op.create_foreign_key(
        "fk_lots_receipt_transaction_line_id",
        "lots",
        "receipt_transaction_lines",
        ["receipt_transaction_line_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_lots_receipt_transaction_line_id",
        "lots",
        ["receipt_transaction_line_id"],
        schema="app",
        postgresql_where=sa.text("receipt_transaction_line_id IS NOT NULL"),
    )

    # ── 4) Backfill: one line per existing linked lot ──────────────────────
    # Map each lot → a freshly minted line id, insert the lines, then point the
    # lot back at its line. Temp table is dropped at COMMIT.
    op.execute(
        """
        CREATE TEMP TABLE _v3_line_map ON COMMIT DROP AS
        SELECT l.id                                   AS lot_id,
               gen_random_uuid()                      AS line_id,
               l.receipt_transaction_id               AS txn_id,
               l.item_id                              AS item_id,
               l.vendor_id                            AS vendor_id,
               GREATEST(COALESCE(l.ordered_qty, 1), 1) AS ordered_qty,
               l.unit_price_amount                    AS unit_price_amount,
               l.created_at                           AS lot_created_at,
               l.lot_number                           AS lot_number
        FROM app.lots l
        WHERE l.receipt_transaction_id IS NOT NULL
          AND l.deleted_at IS NULL
        """
    )
    op.execute(
        """
        INSERT INTO app.receipt_transaction_lines
            (id, receipt_transaction_id, line_no, item_id, vendor_id,
             ordered_qty, unit_price_amount, created_at, updated_at)
        SELECT m.line_id,
               m.txn_id,
               row_number() OVER (
                   PARTITION BY m.txn_id ORDER BY m.lot_created_at, m.lot_number
               ),
               m.item_id, m.vendor_id, m.ordered_qty, m.unit_price_amount,
               now(), now()
        FROM _v3_line_map m
        """
    )
    op.execute(
        """
        UPDATE app.lots l
        SET receipt_transaction_line_id = m.line_id
        FROM _v3_line_map m
        WHERE m.lot_id = l.id
        """
    )

    # ── 5) receipt_events + receipt_event_lines (NEW) ──────────────────────
    op.create_table(
        "receipt_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "receipt_transaction_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("received_at", sa.Date(), nullable=False),
        sa.Column(
            "received_by_user_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("reauth_event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["receipt_transaction_id"],
            ["app.receipt_transactions.id"],
            name="fk_receipt_events_txn_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["received_by_user_id"],
            ["app.users.id"],
            name="fk_receipt_events_received_by_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["reauth_event_id"],
            ["audit.reauth_events.id"],
            name="fk_receipt_events_reauth_event_id",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_receipt_events"),
        schema="app",
    )
    op.create_index(
        "ix_receipt_events_txn_id",
        "receipt_events",
        ["receipt_transaction_id"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_events_received_at_desc",
        "receipt_events",
        [sa.text("received_at DESC")],
        schema="app",
    )

    op.create_table(
        "receipt_event_lines",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("receipt_event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "receipt_transaction_line_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("qty_received", sa.Integer(), nullable=False),
        sa.Column("over_receipt_reason", sa.Text(), nullable=True),
        sa.Column("lot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["receipt_event_id"],
            ["app.receipt_events.id"],
            name="fk_receipt_event_lines_event_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["receipt_transaction_line_id"],
            ["app.receipt_transaction_lines.id"],
            name="fk_receipt_event_lines_line_id",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["lot_id"],
            ["app.lots.id"],
            name="fk_receipt_event_lines_lot_id",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "qty_received > 0", name="ck_receipt_event_lines_qty_pos"
        ),
        sa.UniqueConstraint(
            "receipt_event_id",
            "receipt_transaction_line_id",
            name="uq_receipt_event_lines_event_line",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_receipt_event_lines"),
        schema="app",
    )
    op.create_index(
        "ix_receipt_event_lines_event_id",
        "receipt_event_lines",
        ["receipt_event_id"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_event_lines_line_id",
        "receipt_event_lines",
        ["receipt_transaction_line_id"],
        schema="app",
    )
    op.create_index(
        "ix_receipt_event_lines_lot_id",
        "receipt_event_lines",
        ["lot_id"],
        schema="app",
    )

    # ── 6) Drop the header item_id (item now lives on lines) ───────────────
    # Backfill above read item from the lots, so this is safe to drop now.
    op.drop_index(
        "ix_receipt_transactions_item_id",
        table_name="receipt_transactions",
        schema="app",
    )
    op.drop_constraint(
        "fk_receipt_transactions_item_id_items",
        "receipt_transactions",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("receipt_transactions", "item_id", schema="app")


def downgrade() -> None:
    # ── Reverse 6) restore header item_id from the first line ──────────────
    op.add_column(
        "receipt_transactions",
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.execute(
        """
        UPDATE app.receipt_transactions t
        SET item_id = sub.item_id
        FROM (
            SELECT DISTINCT ON (receipt_transaction_id)
                   receipt_transaction_id, item_id
            FROM app.receipt_transaction_lines
            ORDER BY receipt_transaction_id, line_no
        ) sub
        WHERE sub.receipt_transaction_id = t.id
        """
    )
    # Any Order with no lines (none expected) keeps NULL — drop those would be
    # wrong, so only enforce NOT NULL when fully populated.
    op.alter_column(
        "receipt_transactions",
        "item_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
        schema="app",
    )
    op.create_foreign_key(
        "fk_receipt_transactions_item_id_items",
        "receipt_transactions",
        "items",
        ["item_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_receipt_transactions_item_id",
        "receipt_transactions",
        ["item_id"],
        schema="app",
    )

    # ── Reverse 5) event tables ────────────────────────────────────────────
    op.drop_index(
        "ix_receipt_event_lines_lot_id",
        table_name="receipt_event_lines",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_event_lines_line_id",
        table_name="receipt_event_lines",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_event_lines_event_id",
        table_name="receipt_event_lines",
        schema="app",
    )
    op.drop_table("receipt_event_lines", schema="app")
    op.drop_index(
        "ix_receipt_events_received_at_desc",
        table_name="receipt_events",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_events_txn_id", table_name="receipt_events", schema="app"
    )
    op.drop_table("receipt_events", schema="app")

    # ── Reverse 3) lots.receipt_transaction_line_id ────────────────────────
    op.drop_index(
        "ix_lots_receipt_transaction_line_id",
        table_name="lots",
        schema="app",
    )
    op.drop_constraint(
        "fk_lots_receipt_transaction_line_id",
        "lots",
        schema="app",
        type_="foreignkey",
    )
    op.drop_column("lots", "receipt_transaction_line_id", schema="app")

    # ── Reverse 2) lines table (after item_id restored above) ──────────────
    op.drop_index(
        "ix_receipt_transaction_lines_item_id",
        table_name="receipt_transaction_lines",
        schema="app",
    )
    op.drop_index(
        "ix_receipt_transaction_lines_txn_id",
        table_name="receipt_transaction_lines",
        schema="app",
    )
    op.drop_table("receipt_transaction_lines", schema="app")

    # ── Reverse 1) header additions ────────────────────────────────────────
    op.drop_index(
        "uq_receipt_transactions_po_reference",
        table_name="receipt_transactions",
        schema="app",
    )
    op.alter_column(
        "receipt_transactions",
        "po_reference",
        existing_type=sa.Text(),
        nullable=True,
        schema="app",
    )
    # Map the new status back into the old domain before restoring the CHECK.
    op.execute(
        "UPDATE app.receipt_transactions "
        "SET status = 'open' WHERE status = 'partially_received'"
    )
    op.execute(f"ALTER TABLE app.receipt_transactions DROP CONSTRAINT {_STATUS_CK}")
    op.execute(
        f"ALTER TABLE app.receipt_transactions ADD CONSTRAINT {_STATUS_CK} "
        "CHECK (status IN ('open', 'received', 'cancelled'))"
    )
    op.drop_constraint(
        "ck_receipt_transactions_valid_window",
        "receipt_transactions",
        schema="app",
        type_="check",
    )
    op.drop_column("receipt_transactions", "deleted_at", schema="app")
    op.drop_column("receipt_transactions", "valid_to", schema="app")
    op.drop_column("receipt_transactions", "valid_from", schema="app")
    op.drop_column("receipt_transactions", "is_blanket", schema="app")
