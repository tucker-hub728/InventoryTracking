"""drop invitation token_hash

Cognito-native invite flow (2026-07-14). The app no longer issues its own
single-use accept-link token: Cognito emails a temporary password and the
invitee sets a real one via the NEW_PASSWORD_REQUIRED challenge on first login.
The ``app.invitations`` table stays as the admin lifecycle/display record, but
its credential column (``token_hash``) and unique index are removed.

Drops:
  * unique index ``app.uq_invitations_token_hash``
  * column ``app.invitations.token_hash``

Revision ID: invtoken01
Revises: catprefix01
Create Date: 2026-07-14 11:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "invtoken01"
down_revision: str | None = "catprefix01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS app.uq_invitations_token_hash")
    op.execute("ALTER TABLE app.invitations DROP COLUMN IF EXISTS token_hash")


def downgrade() -> None:
    # Re-add the column. Existing rows can't recover their original token, so a
    # placeholder default satisfies NOT NULL; the unique index is recreated after.
    op.add_column(
        "invitations",
        sa.Column("token_hash", sa.Text(), nullable=False, server_default=sa.text("gen_random_uuid()::text")),
        schema="app",
    )
    op.alter_column("invitations", "token_hash", server_default=None, schema="app")
    op.create_index(
        "uq_invitations_token_hash",
        "invitations",
        ["token_hash"],
        unique=True,
        schema="app",
    )
