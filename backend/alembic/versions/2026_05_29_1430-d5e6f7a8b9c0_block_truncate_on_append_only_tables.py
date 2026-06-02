"""block_truncate_on_append_only_tables

Adds BEFORE TRUNCATE triggers to ``audit.reauth_events`` and
``app.stock_movements``.

Why: row-level BEFORE UPDATE / BEFORE DELETE triggers do NOT fire on
``TRUNCATE`` — it's DDL, not DML. So a privileged user could wipe
either table with one command and erase every audit trace, defeating
the whole point of the append-only design. PostgreSQL gives us BEFORE
TRUNCATE statement-level triggers specifically for this case.

The trigger function used (``tg_movements_immutable`` /
``tg_reauth_events_immutable``) doesn't reference NEW/OLD, so it works
unchanged for the statement-level trigger.

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "d5e6f7a8b9c0"
down_revision: str | None = "c4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # FOR EACH STATEMENT (not FOR EACH ROW) — TRUNCATE doesn't operate
    # on rows individually.
    op.execute(
        """
        CREATE TRIGGER tg_stock_movements_no_truncate
        BEFORE TRUNCATE ON app.stock_movements
        FOR EACH STATEMENT EXECUTE FUNCTION app.tg_movements_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_reauth_events_no_truncate
        BEFORE TRUNCATE ON audit.reauth_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_reauth_events_immutable();
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS tg_reauth_events_no_truncate ON audit.reauth_events;"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS tg_stock_movements_no_truncate ON app.stock_movements;"
    )
