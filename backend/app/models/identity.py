"""Identity ORM — ``app.users``.

Week-1 reset (2026-07-06): the ``roles`` lookup table is gone. A user's
role is now a plain ``TEXT`` column constrained by a CHECK to one of
:data:`ROLES` (``super_admin`` / ``admin`` / ``operator``).

Auth stays on **AWS Cognito** — Cognito holds the password and MFA, so
there is no ``password_hash`` here despite the ERD drawing one. ``cognito_sub``
is the immutable join key minted by Cognito on sign-up; every inventory /
transaction row FKs back to our stable ``users.id`` UUID.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Single source of truth for role values. Keep in sync with the DB enum type
# ``app.user_role`` and ``app.security.permissions.PERM_MATRIX``.
#   * super_admin — full access; the only role that manages locations
#   * admin       — items / users + all transactions (locations view-only)
#   * operator    — operational floor user: receipt / transfer + read
ROLES: tuple[str, ...] = ("super_admin", "admin", "operator")

# Native Postgres enum. ``create_type=False`` — the migration owns the type's
# lifecycle; the ORM only references it.
user_role_enum = ENUM(*ROLES, name="user_role", schema="app", create_type=False)


class User(Base):
    """Local mirror of a Cognito user.

    Tokens, password, and MFA live in Cognito. We hold app-level state
    (role, active flag) plus the immutable ``cognito_sub`` bridge that all
    inventory / transaction rows reference indirectly via ``users.id``.
    """

    __tablename__ = "users"
    __table_args__ = (
        # Case-insensitive unique email.
        Index("uq_users_email", func.lower(text("email")), unique=True),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    cognito_sub: Mapped[str] = mapped_column(Text, nullable=False, unique=True)

    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    first_name: Mapped[str] = mapped_column(Text, nullable=False)
    last_name: Mapped[str] = mapped_column(Text, nullable=False)

    role: Mapped[str] = mapped_column(user_role_enum, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("TRUE"),
    )

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
