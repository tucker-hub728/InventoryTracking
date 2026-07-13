"""Persistence helpers for the identity tables.

Kept narrow on purpose: routes never call SQLAlchemy directly — they go
through this module so that (a) query shape is consistent, (b) tests can
fake one place, and (c) future schema changes (e.g. promoting the
``users.role`` denorm into RBAC tables) touch one file.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity import User


async def get_by_cognito_sub(session: AsyncSession, sub: str) -> User | None:
    """Return the (non-deleted) local user mirroring ``sub``, or None."""
    stmt = select(User).where(User.cognito_sub == sub, User.deleted_at.is_(None))
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_by_email(session: AsyncSession, email: str) -> User | None:
    """Look up by case-insensitive email — used by admin tooling, not auth."""
    stmt = select(User).where(
        func.lower(User.email) == email.lower(),
        User.deleted_at.is_(None),
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def create(
    session: AsyncSession,
    *,
    cognito_sub: str,
    email: str,
    full_name: str,
    initials: str,
    role: str,
    status: str = "active",
) -> User:
    """Insert a new user row. Caller commits.

    Does not check for a pre-existing row — call ``get_by_cognito_sub``
    first if you need upsert semantics (provisioning does).
    """
    user = User(
        cognito_sub=cognito_sub,
        email=email,
        full_name=full_name,
        initials=initials.upper()[:8],
        role=role,
        status=status,
    )
    session.add(user)
    await session.flush()  # populate id / created_at without ending tx
    return user


async def get_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    """Return the (non-deleted) user with ``user_id``, or None."""
    stmt = select(User).where(User.id == user_id, User.deleted_at.is_(None))
    return (await session.execute(stmt)).scalar_one_or_none()


async def hard_delete(session: AsyncSession, user: User) -> None:
    """Permanently remove a user row. Caller commits. Used when an admin revokes
    an invitation whose reserved identity had already materialised a mirror."""
    await session.delete(user)
    await session.flush()


async def list_users(session: AsyncSession) -> list[User]:
    """All non-deleted users, newest first — backs the admin user directory."""
    stmt = (
        select(User)
        .where(User.deleted_at.is_(None))
        .order_by(User.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def touch_last_active(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Record that ``user_id`` made a request right now. Caller commits.

    Issued as a single statement so concurrent /me hits don't read-modify-
    write the row through the ORM. Kept cheap because /me is on the
    interactive path.
    """
    stmt = (
        update(User)
        .where(User.id == user_id)
        .values(last_active_at=datetime.now(tz=UTC))
        .execution_options(synchronize_session=False)
    )
    await session.execute(stmt)


async def count_super_admins(session: AsyncSession) -> int:
    """How many non-deleted ``super_admin`` users exist. Used by lifespan."""
    stmt = select(func.count()).select_from(User).where(
        User.role == "super_admin",
        User.deleted_at.is_(None),
    )
    return int((await session.execute(stmt)).scalar_one())
