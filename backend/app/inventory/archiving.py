"""Order archiving — the policy, the sweep, and the restore.

REQ-2026-07-15-DATA-001: finished Orders older than a configured age (the
client proposed a year) leave the working query set, and stay restorable for
audit.

REQ-2026-07-15-DATA-002: an Order that is still owed stock is NEVER archived,
however old, so finance exports keep showing outstanding commitments.

That second rule is the important one, and it is enforced by construction: every
statement below filters on :data:`TERMINAL_STATUSES`, so an ``open`` or
``partially_received`` Order simply cannot be selected by the sweep. There is no
ordering of events, no missed run and no clock skew that can archive one — the
query that would have to match it does not exist.

Archiving sets one column. Status, lines, receive events, lots and prices are
untouched, so restoring is clearing that column and nothing else.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import ReceiptTransaction
from app.models.settings import (
    DEFAULT_ORDER_ARCHIVE_AFTER_DAYS,
    ORDER_ARCHIVE_AFTER_DAYS,
    AppSetting,
)
from app.models.settings import (
    ORDER_ARCHIVE_LAST_SWEPT_AT as LAST_SWEPT_AT,
)

#: Statuses that mean the Order is finished business. Only these are eligible.
#: ``cancelled`` is included (client 2026-08-06): a cancelled Order is as done
#: as a received one and clutters the list the same way.
TERMINAL_STATUSES: tuple[str, ...] = ("received", "cancelled")

#: Bounds on the configurable age. A day is the floor because anything shorter
#: would archive Orders operators are still working on; ten years is a ceiling
#: that keeps an accidental extra zero from disabling the policy silently.
MIN_ARCHIVE_AFTER_DAYS = 1
MAX_ARCHIVE_AFTER_DAYS = 3650


async def get_archive_after_days(session: AsyncSession) -> int:
    """The configured age, or the default when it has never been set."""
    raw = await session.get(AppSetting, ORDER_ARCHIVE_AFTER_DAYS)
    if raw is None:
        return DEFAULT_ORDER_ARCHIVE_AFTER_DAYS
    try:
        return int(raw.value)
    except (TypeError, ValueError):
        # A hand-edited row shouldn't take the policy down with it.
        return DEFAULT_ORDER_ARCHIVE_AFTER_DAYS


async def set_archive_after_days(
    session: AsyncSession, *, days: int, user_id: uuid.UUID
) -> int:
    """Store the age. Caller validates the range and commits."""
    row = await session.get(AppSetting, ORDER_ARCHIVE_AFTER_DAYS)
    if row is None:
        row = AppSetting(key=ORDER_ARCHIVE_AFTER_DAYS, value=days)
        session.add(row)
    else:
        row.value = days
    row.updated_by_user_id = user_id
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return days


def _cutoff(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


def _eligible(cutoff: datetime):
    """The one predicate the whole module agrees on.

    ``COALESCE(received_at, updated_at)`` is "when this Order finished": a
    received Order carries ``received_at``; a cancelled one never does, so it
    falls back to when it was last touched, which is when it was cancelled.
    """
    finished_at = func.coalesce(
        ReceiptTransaction.received_at, ReceiptTransaction.updated_at
    )
    return (
        ReceiptTransaction.archived_at.is_(None),
        ReceiptTransaction.deleted_at.is_(None),
        ReceiptTransaction.status.in_(TERMINAL_STATUSES),
        finished_at < cutoff,
    )


async def count_eligible(session: AsyncSession, *, days: int | None = None) -> int:
    """How many Orders the sweep would archive right now — shown beside the
    policy so the operator sees the blast radius before saving it."""
    if days is None:
        days = await get_archive_after_days(session)
    stmt = select(func.count()).select_from(ReceiptTransaction).where(*_eligible(_cutoff(days)))
    return int((await session.execute(stmt)).scalar_one())


async def sweep(session: AsyncSession, *, days: int | None = None) -> int:
    """Archive everything eligible. Returns how many were archived.

    Idempotent — it only touches rows where ``archived_at IS NULL`` — so running
    it twice, or on two instances at once, is harmless.
    """
    if days is None:
        days = await get_archive_after_days(session)
    stmt = (
        update(ReceiptTransaction)
        .where(*_eligible(_cutoff(days)))
        .values(archived_at=datetime.now(UTC))
    )
    result = await session.execute(stmt)
    return int(result.rowcount or 0)


async def count_archived(session: AsyncSession) -> int:
    """How many Orders are currently on the shelf."""
    stmt = (
        select(func.count())
        .select_from(ReceiptTransaction)
        .where(
            ReceiptTransaction.archived_at.is_not(None),
            ReceiptTransaction.deleted_at.is_(None),
        )
    )
    return int((await session.execute(stmt)).scalar_one())


async def get_last_swept_at(session: AsyncSession) -> datetime | None:
    """When the sweep last ran, so the panel can say whether the daily job is
    actually alive rather than leaving the operator to guess."""
    row = await session.get(AppSetting, LAST_SWEPT_AT)
    if row is None or not row.value:
        return None
    try:
        return datetime.fromisoformat(str(row.value))
    except ValueError:
        return None


async def set_last_swept_at(session: AsyncSession) -> None:
    """Stamp the sweep. Caller commits."""
    now = datetime.now(UTC).isoformat()
    row = await session.get(AppSetting, LAST_SWEPT_AT)
    if row is None:
        session.add(AppSetting(key=LAST_SWEPT_AT, value=now))
    else:
        row.value = now
        row.updated_at = datetime.now(UTC)
    await session.flush()


async def restore(session: AsyncSession, *, order: ReceiptTransaction) -> ReceiptTransaction:
    """Put an Order back on the working list. Caller commits + audits.

    Clearing the column is the whole operation: the Order returns to whichever
    bucket its status puts it in, unchanged.
    """
    order.archived_at = None
    await session.flush()
    return order
