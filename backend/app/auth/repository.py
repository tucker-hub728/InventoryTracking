"""Persistence helpers for the identity table.

Kept narrow on purpose: routes never call SQLAlchemy directly — they go
through this module so that (a) query shape is consistent, (b) tests can
fake one place, and (c) future schema changes touch one file.

Week-1 reset (2026-07-06): the ``users`` table lost the ``roles`` FK plus
the ``full_name`` / ``initials`` / ``status`` / ``deleted_at`` /
``last_active_at`` columns. A user now has ``first_name`` / ``last_name`` /
``role`` (plain TEXT, CHECK-constrained) / ``is_active``.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity import User


async def list_users(session: AsyncSession) -> list[User]:
    """All users, ordered by name — for the admin Users screen."""
    stmt = select(User).order_by(User.first_name, User.last_name, User.email)
    return list((await session.execute(stmt)).scalars().all())


async def get_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    stmt = select(User).where(User.id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_by_cognito_sub(session: AsyncSession, sub: str) -> User | None:
    """Return the local user mirroring ``sub``, or None."""
    stmt = select(User).where(User.cognito_sub == sub)
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_by_email(session: AsyncSession, email: str) -> User | None:
    """Look up by case-insensitive email — used by admin tooling, not auth."""
    stmt = select(User).where(func.lower(User.email) == email.lower())
    return (await session.execute(stmt)).scalar_one_or_none()


async def create(
    session: AsyncSession,
    *,
    cognito_sub: str,
    email: str,
    first_name: str,
    last_name: str,
    role: str,
    is_active: bool = True,
) -> User:
    """Insert a new user row. Caller commits.

    Does not check for a pre-existing row — call ``get_by_cognito_sub``
    first if you need upsert semantics (provisioning does).
    """
    user = User(
        cognito_sub=cognito_sub,
        email=email,
        first_name=first_name,
        last_name=last_name,
        role=role,
        is_active=is_active,
    )
    session.add(user)
    await session.flush()  # populate id / created_at without ending tx
    return user


async def count_super_admins(session: AsyncSession) -> int:
    """How many ``super_admin`` users exist. Used by lifespan."""
    stmt = (
        select(func.count())
        .select_from(User)
        .where(User.role == "super_admin")
    )
    return int((await session.execute(stmt)).scalar_one())
