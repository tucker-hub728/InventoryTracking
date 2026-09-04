"""Persistence helpers for ``app.invitations``.

Narrow by design (same rationale as ``app.auth.repository``): the service
layer never touches SQLAlchemy directly so query shape stays in one place.
Callers own the transaction — these helpers ``flush`` but never ``commit``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.search import like_contains
from app.models.invitations import Invitation


async def create(
    session: AsyncSession,
    *,
    email: str,
    first_name: str,
    last_name: str,
    role: str,
    cognito_sub: str | None,
    invited_by: uuid.UUID,
    expires_at: datetime,
) -> Invitation:
    """Insert a new invitation row. Caller commits."""
    invite = Invitation(
        email=email,
        first_name=first_name,
        last_name=last_name,
        role=role,
        cognito_sub=cognito_sub,
        status="pending",
        invited_by=invited_by,
        expires_at=expires_at,
    )
    session.add(invite)
    await session.flush()
    return invite


async def get_by_id(session: AsyncSession, invitation_id: uuid.UUID) -> Invitation | None:
    stmt = select(Invitation).where(Invitation.id == invitation_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def delete(session: AsyncSession, invite: Invitation) -> None:
    """Hard-delete an invitation row. Caller commits."""
    await session.delete(invite)
    await session.flush()


async def get_pending_by_email(session: AsyncSession, email: str) -> Invitation | None:
    """The single pending invite for ``email`` (case-insensitive), if any."""
    stmt = select(Invitation).where(
        func.lower(Invitation.email) == email.lower(),
        Invitation.status == "pending",
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def list_all(
    session: AsyncSession,
    *,
    status: str | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[Invitation], int]:
    """Return ``(rows, total)`` of invitations, newest first.

    ``status`` filters on the *stored* column. That is not quite the status the
    UI shows — ``service.effective_status`` reads a pending-but-past-expiry row
    as ``expired`` — but the Invitations tab only ever asks for ``pending``, and
    an expired invite is still stored as pending, so the tab keeps showing it.
    Filtering on the derived value would need the expiry predicate inlined here;
    it is not worth the duplication until a tab actually asks for ``expired``.

    ``limit=None`` returns every matching row.
    """
    conditions = []
    if status is not None:
        conditions.append(Invitation.status == status)
    if q:
        like = like_contains(q.lower())
        conditions.append(
            or_(
                func.lower(Invitation.email).like(like, escape="\\"),
                func.lower(Invitation.first_name).like(like, escape="\\"),
                func.lower(Invitation.last_name).like(like, escape="\\"),
            )
        )

    total = int(
        (
            await session.execute(
                select(func.count()).select_from(Invitation).where(*conditions)
            )
        ).scalar_one()
    )

    stmt = select(Invitation).where(*conditions).order_by(Invitation.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list((await session.execute(stmt)).scalars().all()), total
