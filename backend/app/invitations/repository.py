"""Persistence helpers for ``app.invitations``.

Narrow by design (same rationale as ``app.auth.repository``): the service
layer never touches SQLAlchemy directly so query shape stays in one place.
Callers own the transaction — these helpers ``flush`` but never ``commit``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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


async def list_all(session: AsyncSession, *, status: str | None = None) -> list[Invitation]:
    """All invitations (optionally filtered by status), newest first."""
    stmt = select(Invitation).order_by(Invitation.created_at.desc())
    if status is not None:
        stmt = stmt.where(Invitation.status == status)
    return list((await session.execute(stmt)).scalars().all())
