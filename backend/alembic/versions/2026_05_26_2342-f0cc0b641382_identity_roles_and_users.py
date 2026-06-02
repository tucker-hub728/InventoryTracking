"""identity_roles_and_users

Creates the v1 identity tables — ``app.roles`` and ``app.users`` — and
seeds the four canonical roles. Users are NOT seeded by the migration;
they get provisioned on first login by ``app.auth.provisioning``
(self-signup) or admin-created out-of-band in Cognito (lazy-upserted on
first ``/auth/me``).

Schemas (``app``, ``meta``, ``audit``) are created by
``backend/db/init/01_extensions.sql`` on first volume init — see that
file for the rationale on splitting them.

Revision ID: f0cc0b641382
Revises:
Create Date: 2026-05-26 23:42:44.159131+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID


revision: str = "f0cc0b641382"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Canonical role set seeded with the migration. Kept here (not as a
# SQLAlchemy ORM insert) so the migration is self-contained and can be
# replayed on a fresh DB without importing app code.
SEED_ROLES: list[dict[str, str]] = [
    {
        "code": "super_admin",
        "name": "Super administrator",
        "description": "Full access; bootstrap role.",
    },
    {
        "code": "admin",
        "name": "Administrator",
        "description": "User management + all inventory actions.",
    },
    {
        "code": "editor",
        "name": "Editor",
        "description": "Inventory create / edit / electronically sign.",
    },
    {
        "code": "viewer",
        "name": "Read-only",
        "description": "View inventory, ledger, and audit. No mutations.",
    },
]


def upgrade() -> None:
    # Schemas + extensions. In local dev these come from
    # backend/db/init/01_extensions.sql (run by the Postgres container on
    # first volume init), but managed Postgres (RDS) has no such init hook,
    # so create them here too. Every statement is idempotent (IF NOT EXISTS),
    # so this is a harmless no-op where they already exist.
    op.execute('CREATE EXTENSION IF NOT EXISTS "citext"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "ltree"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "pg_trgm"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
    op.execute("CREATE SCHEMA IF NOT EXISTS app")
    op.execute("CREATE SCHEMA IF NOT EXISTS meta")
    op.execute("CREATE SCHEMA IF NOT EXISTS audit")

    # ── app.roles ────────────────────────────────────────────────────────
    op.create_table(
        "roles",
        sa.Column("code", sa.Text(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "is_system",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("TRUE"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        schema="app",
    )

    # Seed the four canonical roles in the same transaction as the DDL —
    # downstream ``users.role`` inserts depend on them.
    op.bulk_insert(
        sa.table(
            "roles",
            sa.column("code", sa.Text()),
            sa.column("name", sa.Text()),
            sa.column("description", sa.Text()),
            schema="app",
        ),
        SEED_ROLES,
    )

    # ── app.users ────────────────────────────────────────────────────────
    # Passwords/MFA live in Cognito — this table holds only the app-level
    # identity facts. ``cognito_sub`` is the immutable join key.
    op.create_table(
        "users",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("cognito_sub", sa.Text(), nullable=False),
        sa.Column("email", CITEXT(), nullable=False),
        sa.Column("full_name", sa.Text(), nullable=False),
        sa.Column("initials", sa.String(length=8), nullable=False),
        sa.Column(
            "role",
            sa.Text(),
            sa.ForeignKey("app.roles.code", ondelete="RESTRICT", name="fk_users_role_roles"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'active'"),
        ),
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "invited_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="SET NULL",
                name="fk_users_invited_by_user_id_users",
            ),
            nullable=True,
        ),
        sa.Column("accepted_invite_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('active','invited','suspended')",
            name="ck_users_status_in_enum",
        ),
        schema="app",
    )

    # ``cognito_sub`` is set once at provisioning; UNIQUE prevents the
    # same Cognito identity from being mirrored into two rows even if a
    # provisioning retry races.
    op.create_index(
        "uq_users_cognito_sub",
        "users",
        ["cognito_sub"],
        unique=True,
        schema="app",
    )
    # Email uniqueness is partial — soft-deleted rows keep their email so
    # the audit trail still resolves the address even after deletion.
    op.create_index(
        "uq_users_email",
        "users",
        [sa.text("lower(email)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    # Hot list query: "active users by role" for admin pages.
    op.create_index(
        "ix_users_role_status",
        "users",
        ["role", "status"],
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )

    # ── updated_at trigger ───────────────────────────────────────────────
    # SQLAlchemy's ``onupdate`` only fires through the ORM. A DB-level
    # trigger keeps the column truthful even for raw SQL / psql edits.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION app.tg_touch_updated_at()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_users_touch_updated_at
        BEFORE UPDATE ON app.users
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tg_users_touch_updated_at ON app.users;")
    op.execute("DROP FUNCTION IF EXISTS app.tg_touch_updated_at();")
    op.drop_index("ix_users_role_status", table_name="users", schema="app")
    op.drop_index("uq_users_email", table_name="users", schema="app")
    op.drop_index("uq_users_cognito_sub", table_name="users", schema="app")
    op.drop_table("users", schema="app")
    op.drop_table("roles", schema="app")
