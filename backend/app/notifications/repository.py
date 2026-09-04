"""Data access for the notification feed.

Every query in this module is scoped to one ``user_id``, without exception.
That is the whole point of the feature — the thing it replaced was a global
list that every user saw identically — so the scoping is applied here rather
than left to the routes, where one forgotten filter would silently hand one
person another person's inbox.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notifications import NotificationDelivery

#: How many rows the bell carries. The panel is a prompt to open the full
#: screen, not a replacement for it — the same reasoning the old client-side
#: feed used, kept deliberately.
FEED_HEAD_LIMIT = 20


def _mine(user_id: uuid.UUID):
    """Base predicate: this user's rows, minus the ones they dismissed.

    Dismissal is a per-user "I don't want to see this again", so a dismissed
    row is gone from every view including the history list. Read is not —
    a read notification is still part of the record.
    """
    return (
        NotificationDelivery.user_id == user_id,
        NotificationDelivery.dismissed_at.is_(None),
    )


async def feed_head(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    limit: int = FEED_HEAD_LIMIT,
) -> list[NotificationDelivery]:
    """The bell's contents: live, unread alerts, newest first.

    ``resolved_at IS NULL`` is what makes the bell stop nagging. An item that
    was restocked before anyone opened the panel has an alert row that is true
    (it did go below threshold) but no longer actionable, and showing it would
    send someone to look at an item that is fine.
    """
    stmt = (
        select(NotificationDelivery)
        .where(
            *_mine(user_id),
            NotificationDelivery.read_at.is_(None),
            NotificationDelivery.resolved_at.is_(None),
        )
        .order_by(NotificationDelivery.created_at.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars().all())


async def unread_count(session: AsyncSession, *, user_id: uuid.UUID) -> int:
    """Unread and unresolved, counted over the whole feed rather than a page.

    The badge has to be a true number. The old client-side feed fetched at most
    ten rows and displayed that as the total, so "10" meant "ten or more" and
    no one could tell which.
    """
    stmt = select(func.count()).where(
        *_mine(user_id),
        NotificationDelivery.read_at.is_(None),
        NotificationDelivery.resolved_at.is_(None),
    )
    return int((await session.execute(stmt)).scalar_one())


def _status_filter(status: str):
    """Predicates for one tab of the panel.

    ``unread`` deliberately also excludes resolved rows, matching
    :func:`feed_head` — an alert that cleared before anybody looked at it is not
    something to go and action.

    ``read`` does NOT exclude them. Once a row has been read it belongs to the
    history, and "this went low and then sorted itself out" is exactly the kind
    of thing somebody scrolling back wants to find.
    """
    if status == "unread":
        return (
            NotificationDelivery.read_at.is_(None),
            NotificationDelivery.resolved_at.is_(None),
        )
    if status == "read":
        return (NotificationDelivery.read_at.is_not(None),)
    return ()


async def list_for_user(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    limit: int,
    offset: int,
    status: str = "unread",
) -> list[NotificationDelivery]:
    """One page of the caller's feed, for one tab."""
    stmt = (
        select(NotificationDelivery)
        .where(*_mine(user_id), *_status_filter(status))
        .order_by(NotificationDelivery.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list((await session.execute(stmt)).scalars().all())


async def count_for_user(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    status: str = "unread",
) -> int:
    stmt = select(func.count()).where(*_mine(user_id), *_status_filter(status))
    return int((await session.execute(stmt)).scalar_one())


async def mark_read(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    notification_id: uuid.UUID,
) -> int:
    """Mark one row read. Returns rows affected — 0 means not theirs.

    The ``user_id`` predicate is the authorisation check, not a filter: a
    caller passing somebody else's notification id updates nothing and gets a
    404 from the route, which is also what they would get for an id that does
    not exist. Those two cases looking identical is intentional.

    ``read_at IS NULL`` makes it idempotent — clicking twice does not move the
    timestamp, so "when did you first see this" stays answerable.
    """
    stmt = (
        update(NotificationDelivery)
        .where(
            NotificationDelivery.id == notification_id,
            NotificationDelivery.user_id == user_id,
            NotificationDelivery.read_at.is_(None),
        )
        .values(read_at=datetime.now(UTC))
    )
    return int((await session.execute(stmt)).rowcount or 0)


async def mark_all_read(session: AsyncSession, *, user_id: uuid.UUID) -> int:
    """Mark every live unread row read. Returns how many moved.

    Scoped to unresolved rows so it matches what the panel actually showed;
    marking rows the user was never able to see would be a lie about what they
    have looked at, and this is an application people sign records in.
    """
    stmt = (
        update(NotificationDelivery)
        .where(
            *_mine(user_id),
            NotificationDelivery.read_at.is_(None),
            NotificationDelivery.resolved_at.is_(None),
        )
        .values(read_at=datetime.now(UTC))
    )
    return int((await session.execute(stmt)).rowcount or 0)


async def dismiss(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    notification_id: uuid.UUID,
) -> int:
    """Hide one row from every view for this user only.

    Sets ``read_at`` too when it was unread: something dismissed without being
    read is still something the user decided about, and leaving it unread would
    keep it in the badge count it just left the panel to escape.
    """
    now = datetime.now(UTC)
    stmt = (
        update(NotificationDelivery)
        .where(
            NotificationDelivery.id == notification_id,
            NotificationDelivery.user_id == user_id,
            NotificationDelivery.dismissed_at.is_(None),
        )
        .values(
            dismissed_at=now,
            read_at=func.coalesce(NotificationDelivery.read_at, now),
        )
    )
    return int((await session.execute(stmt)).rowcount or 0)
