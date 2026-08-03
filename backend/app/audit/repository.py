"""Read-only persistence helpers for ``audit.audit_events``.

The recorder (``app.audit.recorder``) owns writes. This module is the
read side — list + filter + lookup. Routes never call SQLAlchemy
directly so the join shape and ordering stay consistent.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.search import like_contains
from app.models.audit import AuditEvent, ReauthEvent
from app.models.identity import User

# Shape returned by the listing query — flat dicts so the route can
# build the Pydantic model without dragging a half-hydrated ORM
# instance across an async boundary (the same gotcha that bit the
# Chunk A PATCH handlers).
AuditEventRow = dict


def _select_with_actor() -> tuple:
    """Build the canonical SELECT that LEFT-JOINs actor + signature data.

    Returns (AuditEvent, User.email, User.full_name, ReauthEvent.comment)
    so callers can ``await session.execute(select(*_select_with_actor()))``
    and project the user denorm + the e-signature rationale without an
    extra fetch. ``signature_comment`` is NULL for unsigned events.
    """
    return (
        AuditEvent,
        User.email.label("actor_user_email"),
        User.full_name.label("actor_user_name"),
        ReauthEvent.comment.label("signature_comment"),
    )


def _base_stmt():
    """SELECT with the actor + signature LEFT JOINs. Filters layer on top."""
    return (
        select(*_select_with_actor())
        .outerjoin(User, User.id == AuditEvent.actor_user_id)
        .outerjoin(ReauthEvent, ReauthEvent.id == AuditEvent.signature_id)
    )


async def list_audit_events(
    session: AsyncSession,
    *,
    subject_table: str | None = None,
    subject_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    event_type: str | None = None,
    severity: str | None = None,
    action: str | None = None,
    occurred_from: datetime | None = None,
    occurred_to: datetime | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[AuditEventRow], int]:
    """Return ``(rows, total)`` newest-first.

    Filters are AND-ed together. ``q`` is a case-insensitive substring
    match over ``event_type`` + ``subject_label`` — the audit viewer's
    "find anything" search. ``occurred_from`` is inclusive,
    ``occurred_to`` is exclusive so half-open ranges work cleanly.
    """
    stmt = _base_stmt()
    count_stmt = select(func.count()).select_from(AuditEvent)

    if subject_table is not None:
        stmt = stmt.where(AuditEvent.subject_table == subject_table)
        count_stmt = count_stmt.where(AuditEvent.subject_table == subject_table)
    if subject_id is not None:
        stmt = stmt.where(AuditEvent.subject_id == subject_id)
        count_stmt = count_stmt.where(AuditEvent.subject_id == subject_id)
    if actor_user_id is not None:
        stmt = stmt.where(AuditEvent.actor_user_id == actor_user_id)
        count_stmt = count_stmt.where(AuditEvent.actor_user_id == actor_user_id)
    if event_type:
        stmt = stmt.where(AuditEvent.event_type == event_type)
        count_stmt = count_stmt.where(AuditEvent.event_type == event_type)
    if severity:
        stmt = stmt.where(AuditEvent.severity == severity)
        count_stmt = count_stmt.where(AuditEvent.severity == severity)
    if action:
        stmt = stmt.where(AuditEvent.action == action)
        count_stmt = count_stmt.where(AuditEvent.action == action)
    if occurred_from is not None:
        stmt = stmt.where(AuditEvent.occurred_at >= occurred_from)
        count_stmt = count_stmt.where(AuditEvent.occurred_at >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(AuditEvent.occurred_at < occurred_to)
        count_stmt = count_stmt.where(AuditEvent.occurred_at < occurred_to)
    if q:
        like = like_contains(q.lower())
        cond = or_(
            func.lower(AuditEvent.event_type).like(like, escape="\\"),
            func.lower(AuditEvent.subject_label).like(like, escape="\\"),
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    total = int((await session.execute(count_stmt)).scalar_one())

    stmt = stmt.order_by(desc(AuditEvent.occurred_at)).limit(limit).offset(offset)
    result = await session.execute(stmt)

    # ``result.mappings()`` returns one dict per row keyed by column /
    # alias. The AuditEvent row comes back as an ORM instance under the
    # ``AuditEvent`` key; flatten it for the Pydantic adapter.
    rows: list[AuditEventRow] = []
    for mapping in result.mappings().all():
        event: AuditEvent = mapping["AuditEvent"]
        rows.append(
            {
                "event": event,
                "actor_user_email": mapping.get("actor_user_email"),
                "actor_user_name": mapping.get("actor_user_name"),
                "signature_comment": mapping.get("signature_comment"),
            }
        )
    return rows, total


async def get_audit_event(
    session: AsyncSession, event_id: uuid.UUID
) -> AuditEventRow | None:
    """Fetch one event by id with the actor denorm join."""
    stmt = _base_stmt().where(AuditEvent.id == event_id).limit(1)
    result = await session.execute(stmt)
    mapping = result.mappings().first()
    if mapping is None:
        return None
    event: AuditEvent = mapping["AuditEvent"]
    return {
        "event": event,
        "actor_user_email": mapping.get("actor_user_email"),
        "actor_user_name": mapping.get("actor_user_name"),
        "signature_comment": mapping.get("signature_comment"),
    }
