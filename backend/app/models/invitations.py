"""Invitation ORM — ``app.invitations``.

An invitation is the app-owned lifecycle record for onboarding a new user.
Cognito owns the credential (password/MFA) once the invitee accepts, but the
onboarding lifecycle — who was invited, in what role, by whom, and whether the
invite is still pending/accepted/revoked/expired — lives here.

Flow (Cognito identity is reserved at *invite* time, in FORCE_CHANGE_PASSWORD
until accept):

  1. Admin invites  -> a Cognito user is created and emailed a temporary
                       password (in prod Cognito sends it; in local dev the app
                       sends it via SMTP to maildev). A row is written here with
                       ``status='pending'`` and a hashed single-use link token so
                       the accept page can pre-fill the invitee's name/role.
  2. Invitee accepts -> they set a new password (temp password -> new password),
                        the ``app.users`` mirror is materialised, and the row
                        flips to ``status='accepted'``.

Only the SHA-256 *hash* of the link token is stored — the raw token is the
credential and never touches the database or the logs.

Deviation from the reference implementation: ``role`` is a ``TEXT`` foreign key
to ``app.roles.code`` (matching ``app.users.role``), NOT a native enum — this
repo models roles as a lookup table, not a PG enum.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Single source of truth for invite statuses. Keep in sync with the DB enum
# type ``app.invite_status`` and the invites migration.
#   * pending  — link issued, not yet accepted (the only actionable state)
#   * accepted — invitee set a password; ``app.users`` mirror now exists
#   * revoked  — cancelled by an admin before acceptance
#   * expired  — passed ``expires_at`` without being accepted
INVITE_STATUSES: tuple[str, ...] = ("pending", "accepted", "revoked", "expired")

# ``create_type=False`` — the migration owns the type's lifecycle; the ORM
# only references it.
invite_status_enum = ENUM(*INVITE_STATUSES, name="invite_status", schema="app", create_type=False)


class Invitation(Base):
    """A pending/accepted/revoked invitation to join the platform."""

    __tablename__ = "invitations"
    __table_args__ = (
        # The link token — looked up by hash on resolve/accept.
        Index("uq_invitations_token_hash", "token_hash", unique=True),
        # At most one *pending* invite per email (case-insensitive). Historical
        # accepted/revoked/expired rows for the same address are allowed.
        Index(
            "uq_invitations_pending_email",
            func.lower(text("email")),
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        Index("ix_invitations_status", "status"),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )

    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    first_name: Mapped[str] = mapped_column(Text, nullable=False)
    last_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Role is a TEXT FK to app.roles.code — same as app.users.role.
    role: Mapped[str] = mapped_column(
        Text,
        ForeignKey("app.roles.code", ondelete="RESTRICT", name="fk_invitations_role_roles"),
        nullable=False,
    )

    # The Cognito identity reserved for this invitee (created at invite time).
    # Nullable so a future accept-time-creation variant stays expressible.
    cognito_sub: Mapped[str | None] = mapped_column(Text, nullable=True)

    # SHA-256 hex of the raw link token. The raw token is never persisted.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)

    status: Mapped[str] = mapped_column(
        invite_status_enum,
        nullable=False,
        server_default=text("'pending'"),
    )

    invited_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "app.users.id",
            ondelete="RESTRICT",
            name="fk_invitations_invited_by_users",
        ),
        nullable=False,
    )

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
