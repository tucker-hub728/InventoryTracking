"""Identity ORM — ``app.roles`` and ``app.users``.

Two tables, both in the ``app`` schema:

* :class:`Role` — lookup of role codes (``super_admin`` / ``admin`` /
  ``editor`` / ``viewer``). The PK is ``code TEXT`` rather than a UUID
  because (a) v1 has no other table joining roles by surrogate key and
  (b) ``users.role TEXT FK → roles.code`` reads better in SQL.

* :class:`User` — the local mirror of a Cognito identity. ``cognito_sub``
  is the immutable join key minted by Cognito on sign-up; everything else
  is duplicated locally so we can build FKs from inventory / ledger /
  audit rows to a stable UUID PK we control.

Deviation from ``docs/backend-data-structure-v1-mvp.md`` §5.3: the doc
predates the Cognito decision and lists ``password_hash`` / ``mfa_*``
columns. Cognito holds passwords and MFA, so those columns would be
dead — they're omitted here and replaced by ``cognito_sub``. See
``docs/backend-data-structure-v1-mvp.md`` and update the doc the next
time it's revised.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Role(Base):
    """Role lookup. Seeded once by migration 0001; immutable in v1.

    ``is_system`` flags the four canonical roles so a future admin UI can
    refuse to delete them. Always ``TRUE`` in v1 since the only roles are
    the seeded ones.
    """

    __tablename__ = "roles"
    __table_args__ = {"schema": "app"}

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    is_system: Mapped[bool] = mapped_column(
        nullable=False,
        server_default=text("TRUE"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    users: Mapped[list[User]] = relationship(
        back_populates="role_rel",
        viewonly=True,  # writes go through users.role, not the relationship
    )


class User(Base):
    """Local mirror of a Cognito user.

    Tokens, password, and MFA live in Cognito. We hold app-level state
    (status, last_active_at, invited_by, soft-delete) plus a denormalised
    role column that v2's RBAC tables will treat as the default role.

    ``cognito_sub`` is set once at provisioning and never changes — it's
    the bridge that future ledger / audit rows reference indirectly via
    ``users.id``.
    """

    __tablename__ = "users"
    __table_args__ = (
        # Partial-unique on lower(email) for active rows; soft-deleted rows
        # are allowed to retain their original email. Created as a real
        # index in the migration; declared here so autogenerate sees it.
        Index(
            "uq_users_email",
            func.lower(text("email")),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        CheckConstraint(
            "status IN ('active','invited','suspended')",
            name="status_in_enum",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        # gen_random_uuid() comes from pgcrypto (already in 01_extensions.sql).
        # Server-side default lets seed SQL and admin tools insert without
        # supplying an id explicitly.
        server_default=text("gen_random_uuid()"),
    )
    cognito_sub: Mapped[str] = mapped_column(Text, nullable=False, unique=True)

    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    initials: Mapped[str] = mapped_column(String(8), nullable=False)

    role: Mapped[str] = mapped_column(
        Text,
        ForeignKey("app.roles.code", ondelete="RESTRICT"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'active'"),
    )
    # The super admin seeded at deployment. Permanent by client rule
    # (2026-07-31): always ``super_admin``, email immutable, cannot be
    # deactivated — enforced in ``app.users.routes``. At most one row may carry
    # it (partial unique index ``uq_users_seed``, migration seedadmin01).
    is_seed: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("FALSE"),
    )

    last_active_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    invited_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    invited_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="SET NULL"),
        nullable=True,
    )
    accepted_invite_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
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
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    role_rel: Mapped[Role] = relationship(back_populates="users", viewonly=True)
