"""seedadmin01: mark the seeded super admin as permanent

The last-super-admin guard is a *count*: you may demote any super admin as long
as another active one remains. That protects the installation from being locked
out, but it says nothing about WHICH account survives — a deployment could end
up resting on an account created ad hoc during a support call.

The client's rule (2026-07-31) is stronger and identity-based: the super admin
seeded at deployment is permanent. It is always ``super_admin``, its email can
never change, and it cannot be deactivated. Everyone else — including other
super admins made by promotion — stays fully editable under the existing rules.

That needs a marker, because nothing on ``app.users`` distinguishes the seeded
account today: ``invited_by_user_id IS NULL`` is also true of every user made by
``scripts/seed_users.py`` and of any super admin a test creates. Hence an
explicit flag rather than a heuristic like "the earliest-created super admin",
which silently moves to a different person if the seed row is ever recreated.

Set by ``scripts/seed_super_admins.py`` on insert. Defaults FALSE, so every
existing row — and every invited user — is unaffected.

**No backfill.** On a database seeded before this migration the flag is FALSE
everywhere, which fails safe: nothing is locked, and the existing
last-super-admin guard still prevents lockout. Mark the intended account
deliberately, either by re-running the seeder (idempotent) or:

    UPDATE app.users SET is_seed = TRUE WHERE email = '<the seeded admin>';

A partial unique index enforces at most one seeded account, so the rule can
never become ambiguous.

Revision ID: seedadmin01
Revises: locseed01
Create Date: 2026-07-31 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "seedadmin01"
down_revision: str | None = "locseed01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_seed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )
    # At most one seeded account, ever. Without this the "permanent super
    # admin" rule could apply to two rows and mean nothing. Partial so
    # soft-deleted rows don't hold the slot.
    op.create_index(
        "uq_users_seed",
        "users",
        ["is_seed"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("is_seed AND deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_users_seed", table_name="users", schema="app")
    op.drop_column("users", "is_seed", schema="app")
