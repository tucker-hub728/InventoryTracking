"""Persistence helpers for the identity tables.

Kept narrow on purpose: routes never call SQLAlchemy directly — they go
through this module so that (a) query shape is consistent, (b) tests can
fake one place, and (c) future schema changes (e.g. promoting the
``users.role`` denorm into RBAC tables) touch one file.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.search import like_contains
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
    is_seed: bool = False,
) -> User:
    """Insert a new user row. Caller commits.

    Does not check for a pre-existing row — call ``get_by_cognito_sub``
    first if you need upsert semantics (provisioning does).

    ``is_seed`` marks the permanent seeded super admin and is set only by
    ``scripts/seed_super_admins.py``. A partial unique index allows at most one.
    """
    user = User(
        cognito_sub=cognito_sub,
        email=email,
        full_name=full_name,
        initials=initials.upper()[:8],
        role=role,
        status=status,
        is_seed=is_seed,
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


async def list_users(
    session: AsyncSession,
    *,
    is_active: bool | None = None,
    role: str | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[User], int]:
    """Return ``(rows, total)`` of non-deleted users, newest first.

    Backs the admin user directory, whose Active / Inactive tabs are two
    filtered slices of the same query rather than two endpoints. ``total`` is
    the count *after* filtering, so the pager stays honest when a search is on.

    ``limit=None`` returns every matching row — used by callers that genuinely
    need the whole directory (counting, exports) rather than a page of it.
    """
    conditions = [User.deleted_at.is_(None)]
    if is_active is not None:
        # ``status`` is the stored truth; "active" is the only status that
        # counts as active (``suspended`` mirrors a disabled Cognito identity).
        conditions.append(
            User.status == "active" if is_active else User.status != "active"
        )
    if role is not None:
        conditions.append(User.role == role)
    if q:
        like = like_contains(q.lower())
        conditions.append(
            or_(
                func.lower(User.email).like(like, escape="\\"),
                func.lower(User.full_name).like(like, escape="\\"),
            )
        )

    total = int(
        (
            await session.execute(
                select(func.count()).select_from(User).where(*conditions)
            )
        ).scalar_one()
    )

    stmt = select(User).where(*conditions).order_by(User.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list((await session.execute(stmt)).scalars().all()), total


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


async def seed_admin_exists(session: AsyncSession) -> bool:
    """Whether a seeded super admin is already marked.

    Guards the seeder against tripping ``uq_users_seed`` when it is run a
    second time against a different address — the first account keeps the flag.
    """
    stmt = select(func.count()).select_from(User).where(
        User.is_seed.is_(True),
        User.deleted_at.is_(None),
    )
    return int((await session.execute(stmt)).scalar_one()) > 0


async def count_super_admins(session: AsyncSession) -> int:
    """How many **usable** ``super_admin`` users exist — active and not deleted.

    Suspended super admins are deliberately excluded. They can't log in, so
    counting them would let the lockout guard pass while leaving nobody able to
    actually administer the system: with one active and one suspended super
    admin, a naive count of 2 would permit demoting the active one and stranding
    the install. Used by the lockout guard in ``app.users.routes`` and by the
    startup check in ``app.core.lifespan``.
    """
    stmt = select(func.count()).select_from(User).where(
        User.role == "super_admin",
        User.status == "active",
        User.deleted_at.is_(None),
    )
    return int((await session.execute(stmt)).scalar_one())
