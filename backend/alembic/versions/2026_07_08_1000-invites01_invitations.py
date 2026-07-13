"""invitations

User-invite flow (2026-07-08). Adds the app-owned invitation lifecycle that
Cognito can't express: our own single-use link token (stored hashed), an
app-controlled expiry, and pending/accepted/revoked/expired states.

Adds:
  * native enum ``app.invite_status`` (pending/accepted/revoked/expired)
  * table ``app.invitations`` (+ token-hash unique, partial-unique pending
    email, status index, updated_at trigger)

``app.user_role`` (roles) and ``app.tg_touch_updated_at()`` already exist from
earlier migrations and are only referenced here.

Revision ID: invites01
Revises: rolesenum01
Create Date: 2026-07-08 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, ENUM, UUID

revision: str = "invites01"
down_revision: str | None = "rolesenum01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Keep in lock-step with app.models.invitations.INVITE_STATUSES and the ORM
# tuple app.models.identity.ROLES.
INVITE_STATUSES = ("pending", "accepted", "revoked", "expired")
ROLES = ("super_admin", "admin", "operator")


def _enum_values(values: tuple[str, ...]) -> str:
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def upgrade() -> None:
    # Native status enum (roles enum already exists from rolesenum01).
    op.execute(
        f"CREATE TYPE app.invite_status AS ENUM ({_enum_values(INVITE_STATUSES)})"
    )

    op.create_table(
        "invitations",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", CITEXT(), nullable=False),
        sa.Column("first_name", sa.Text(), nullable=False),
        sa.Column("last_name", sa.Text(), nullable=False),
        # Reference the existing app.user_role type (do NOT recreate it).
        sa.Column(
            "role",
            ENUM(*ROLES, name="user_role", schema="app", create_type=False),
            nullable=False,
        ),
        sa.Column("cognito_sub", sa.Text(), nullable=True),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column(
            "status",
            ENUM(
                *INVITE_STATUSES,
                name="invite_status",
                schema="app",
                create_type=False,
            ),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "invited_by",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_invitations_invited_by_users",
            ),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
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
        schema="app",
    )

    op.create_index(
        "uq_invitations_token_hash",
        "invitations",
        ["token_hash"],
        unique=True,
        schema="app",
    )
    # At most one *pending* invite per email (case-insensitive).
    op.create_index(
        "uq_invitations_pending_email",
        "invitations",
        [sa.text("lower(email)")],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
        schema="app",
    )
    op.create_index(
        "ix_invitations_status", "invitations", ["status"], schema="app"
    )

    op.execute(
        """
        CREATE TRIGGER tg_invitations_touch_updated_at
        BEFORE UPDATE ON app.invitations
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS tg_invitations_touch_updated_at ON app.invitations"
    )
    op.drop_table("invitations", schema="app")
    op.execute("DROP TYPE IF EXISTS app.invite_status")
