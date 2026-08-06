"""PO archiving (REQ-2026-07-15-DATA-001/002/003).

Receipt Admin only grows. A year in, most orders are finished business that
nobody queries, and they crowd out the ones that still need action.

Two things land here:

* ``receipt_transactions.archived_at`` — when an order was moved off the
  working list. NULL means active. Archiving changes NOTHING else about the
  order: status, lines, receive events, lots and prices are untouched, so
  restoring is just clearing this column (DATA-001, "restorable for audit").

  Deliberately a nullable timestamp rather than a boolean: "when" is the
  question an auditor asks, and it costs the same to store.

* ``app.app_settings`` — a small key/value store, because DATA-001 asks for a
  *configured* age and the client wants to change it from the UI, and this
  application has nowhere to put a setting today. One row per setting, JSON
  value so the next one doesn't need a migration.

The partial index covers the only query that matters: the working list, which
always asks for the un-archived rows.

**DATA-002 is not enforced here.** An open or partially-received order must
never archive however old it is, and that guarantee lives in the sweep's WHERE
clause (``app/inventory/archiving.py``) rather than in a CHECK, because
``archived_at`` is legitimately set on terminal orders only — there is no row
state a constraint could reject.

Revision ID: poarch01
Revises: locname01
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "poarch01"
down_revision = "locname01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "receipt_transactions",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        schema="app",
    )
    # The working list's predicate. Partial, because the archived rows are
    # exactly the ones it never wants.
    op.execute(
        """
        CREATE INDEX ix_receipt_transactions_active
        ON app.receipt_transactions (created_at DESC)
        WHERE archived_at IS NULL AND deleted_at IS NULL
        """
    )
    # …and the sweep's predicate, for finding what is now eligible.
    op.execute(
        """
        CREATE INDEX ix_receipt_transactions_archived_at
        ON app.receipt_transactions (archived_at)
        WHERE archived_at IS NOT NULL
        """
    )

    op.create_table(
        "app_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app.users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        schema="app",
    )


def downgrade() -> None:
    op.drop_table("app_settings", schema="app")
    op.execute("DROP INDEX IF EXISTS app.ix_receipt_transactions_archived_at")
    op.execute("DROP INDEX IF EXISTS app.ix_receipt_transactions_active")
    op.drop_column("receipt_transactions", "archived_at", schema="app")
