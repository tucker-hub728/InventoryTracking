"""comment_on_reauth_events

Add ``comment`` to ``audit.reauth_events`` — the operator's free-text
rationale captured at signing time ("correcting an erroneous transfer",
…). Per the client's 21 CFR Part 11 requirement, a comment is now
mandatory on every electronic signature; it is enforced at the API
layer (``ReauthRequest.comment`` is required), and surfaced on the audit
log next to the signature.

Nullable at the column level for two reasons:
  * Backwards compatibility — existing rows have no comment.
  * Failure rows (wrong password / rate-limited) still record whatever
    the operator typed, but we never want a missing value to break the
    append-only insert.

The append-only trigger from migration ``2026_05_29_1300`` still
applies — once a row lands, this column can't be back-filled.

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "c8d9e0f1a2b3"
down_revision: str | None = "b7c8d9e0f1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reauth_events",
        sa.Column("comment", sa.Text(), nullable=True),
        schema="audit",
    )


def downgrade() -> None:
    op.drop_column("reauth_events", "comment", schema="audit")
