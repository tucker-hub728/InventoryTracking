"""Data access for consumables, Kanban register and expiration.

The expiration "engine" is this module's :func:`flag_for` — a date comparison
run on read. There is no sweep and no scheduler: a flag is a function of
``expiration_date``, today, and the configured lead time, so storing it would
only create a second thing that can be wrong. (``app/inventory/archive_job.py``
records the same reasoning for the one place that genuinely does need a job.)
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.locations import repository as loc_repo
from app.models.consumables import ConsumableIssue
from app.models.inventory import Lot, StockMovement
from app.models.settings import (
    CONSUMABLE_EXPIRY_WARN_DAYS,
    DEFAULT_CONSUMABLE_EXPIRY_WARN_DAYS,
    AppSetting,
)
from app.notifications.pending import mark_issue, mark_item

#: Bounds on the lead time. Zero is legal and means "warn only once expired",
#: which is the main SRS's literal LOC-008 reading; ten years is a ceiling that
#: stops a stray zero from flagging the entire register at once.
MIN_WARN_DAYS = 0
MAX_WARN_DAYS = 3650


async def get_warn_days(session: AsyncSession) -> int:
    """The configured warning lead time, or the default when never set."""
    raw = await session.get(AppSetting, CONSUMABLE_EXPIRY_WARN_DAYS)
    if raw is None:
        return DEFAULT_CONSUMABLE_EXPIRY_WARN_DAYS
    try:
        return int(raw.value)
    except (TypeError, ValueError):
        # A hand-edited row shouldn't take the whole alert down with it.
        return DEFAULT_CONSUMABLE_EXPIRY_WARN_DAYS


async def set_warn_days(session: AsyncSession, *, days: int, user_id: uuid.UUID) -> int:
    """Store the lead time. Caller validates the range and commits."""
    row = await session.get(AppSetting, CONSUMABLE_EXPIRY_WARN_DAYS)
    if row is None:
        row = AppSetting(key=CONSUMABLE_EXPIRY_WARN_DAYS, value=days)
        session.add(row)
    else:
        row.value = days
    row.updated_by_user_id = user_id
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return days


def flag_for(
    expiration_date: date | None,
    *,
    warn_days: int,
    today: date | None = None,
) -> tuple[str | None, int | None]:
    """``(flag, days_to_expiry)`` for one expiration date.

    ``None`` when there is no date — REQ-2026-07-08-INV-004 as amended on
    2026-07-09 makes expiration optional at receiving, and "expiration flags
    apply only where a date exists". A dateless consumable never warns, and
    that is a requirement rather than an oversight.

    Boundaries, stated once so the tests can pin them: a lot expiring TODAY is
    ``expired`` (it is no longer usable today), and one expiring exactly
    ``warn_days`` out is already ``warn``.
    """
    if expiration_date is None:
        return None, None
    days = (expiration_date - (today or datetime.now(UTC).date())).days
    if days <= 0:
        return "expired", days
    if days <= warn_days:
        return "warn", days
    return None, days


async def create_issue_movement(
    session: AsyncSession,
    *,
    item_id: uuid.UUID,
    lot_id: uuid.UUID,
    from_location_node_id: uuid.UUID,
    kanban_node_id: uuid.UUID,
    qty: int,
    performed_by_user_id: uuid.UUID,
    reauth_evidence_id: uuid.UUID | None = None,
    notes: str | None = None,
) -> StockMovement:
    """Post the ``consumable_issue`` ledger row — unit-OUT of the storage node,
    INTO the Kanban. Both ends are set so the ledger says which room the units
    went to; the Kanban holds no allocation (consume-at-issue)."""
    from_path, to_path = await loc_repo.node_paths(
        session, from_node_id=from_location_node_id, to_node_id=kanban_node_id
    )
    movement = StockMovement(
        item_id=item_id,
        lot_id=lot_id,
        from_location_node_id=from_location_node_id,
        to_location_node_id=kanban_node_id,
        from_location_path=from_path,
        to_location_path=to_path,
        movement_type="consumable_issue",
        qty_delta=-qty,
        qty_abs=qty,
        notes=notes,
        reauth_evidence_id=reauth_evidence_id,
        performed_by_user_id=performed_by_user_id,
    )
    mark_item(session, item_id)
    session.add(movement)
    await session.flush()
    return movement


async def record_issue(session: AsyncSession, *, movement_id: uuid.UUID) -> ConsumableIssue:
    """Open an expiration flag against one ``consumable_issue`` movement (§4.3).

    Nothing else is stored: item, lot, qty, Kanban, who and when all live on the
    movement, and the expiry on that movement's lot."""
    row = ConsumableIssue(movement_id=movement_id)
    session.add(row)
    await session.flush()
    # A consumable can be issued already inside its warning window — the flag
    # is a function of the lot's date, not of when it was issued — so this row
    # may need to alert the moment it exists, rather than at the next sweep.
    mark_issue(session, row.id)
    return row


def _with_movement():
    """Eager-load the movement (which itself eager-loads item / lot /
    performed_by), so one register read is one round trip."""
    return joinedload(ConsumableIssue.movement), joinedload(ConsumableIssue.cleared_by)


async def get_issue(session: AsyncSession, issue_id: uuid.UUID) -> ConsumableIssue | None:
    stmt = select(ConsumableIssue).options(*_with_movement()).where(ConsumableIssue.id == issue_id)
    return (await session.execute(stmt)).unique().scalar_one_or_none()


def _issue_filters(
    stmt,
    *,
    kanban_node_id: uuid.UUID | None,
    item_id: uuid.UUID | None,
    include_cleared: bool,
    expiring_only: bool,
    warn_days: int,
    today: date | None,
):
    """The WHERE clauses shared by the list and its count, so a paged read can
    never disagree with its own total."""
    if kanban_node_id is not None:
        stmt = stmt.where(StockMovement.to_location_node_id == kanban_node_id)
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if not include_cleared:
        stmt = stmt.where(ConsumableIssue.cleared_at.is_(None))
    if expiring_only:
        horizon = (today or datetime.now(UTC).date()) + timedelta(days=warn_days)
        stmt = stmt.where(Lot.expiration_date <= horizon)
    return stmt


async def count_issues(
    session: AsyncSession,
    *,
    kanban_node_id: uuid.UUID | None = None,
    item_id: uuid.UUID | None = None,
    include_cleared: bool = False,
    expiring_only: bool = False,
    warn_days: int = 0,
    today: date | None = None,
) -> int:
    """How many rows the same filters match — the paginator's ``total``."""
    stmt = (
        select(func.count())
        .select_from(ConsumableIssue)
        .join(StockMovement, StockMovement.id == ConsumableIssue.movement_id)
        .outerjoin(Lot, Lot.id == StockMovement.lot_id)
    )
    stmt = _issue_filters(
        stmt,
        kanban_node_id=kanban_node_id,
        item_id=item_id,
        include_cleared=include_cleared,
        expiring_only=expiring_only,
        warn_days=warn_days,
        today=today,
    )
    return int((await session.execute(stmt)).scalar_one())


async def list_issues(
    session: AsyncSession,
    *,
    kanban_node_id: uuid.UUID | None = None,
    item_id: uuid.UUID | None = None,
    include_cleared: bool = False,
    expiring_only: bool = False,
    warn_days: int = 0,
    today: date | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[ConsumableIssue]:
    """The Kanban register.

    Every filter here runs against the MOVEMENT and its lot rather than against
    columns of this table, because this table has none of them — which is the
    point: there is one copy of each fact and it cannot drift. Both joined
    tables carry the indexes these filters need
    (``ix_movements_to_location_node_id``, ``ix_movements_item_id``,
    ``ix_lots_expiration_date``).

    ``expiring_only`` narrows to rows that would show a flag right now, in SQL:
    ``lots.expiration_date <= today + warn_days``. A NULL date fails that
    comparison on its own, which is exactly the 07-09 rule ("expiration flags
    apply only where a date exists") — no extra guard needed.
    """
    stmt = (
        select(ConsumableIssue)
        .join(StockMovement, StockMovement.id == ConsumableIssue.movement_id)
        .outerjoin(Lot, Lot.id == StockMovement.lot_id)
        .options(*_with_movement())
        .order_by(
            Lot.expiration_date.is_(None),
            Lot.expiration_date.asc(),
            StockMovement.performed_at.desc(),
        )
    )
    stmt = _issue_filters(
        stmt,
        kanban_node_id=kanban_node_id,
        item_id=item_id,
        include_cleared=include_cleared,
        expiring_only=expiring_only,
        warn_days=warn_days,
        today=today,
    )
    # Safe to window in SQL: both eager loads (movement, cleared_by) are
    # many-to-one, so the join yields exactly one row per register entry and
    # LIMIT counts what the caller expects. A collection joinedload here would
    # multiply rows and this would have to paginate on a subquery instead.
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list((await session.execute(stmt)).unique().scalars().all())


def expiry_of(issue: ConsumableIssue) -> date | None:
    """The live expiration date behind one register row (movement → lot)."""
    lot = getattr(issue.movement, "lot", None)
    return lot.expiration_date if lot else None


async def clear_flag(
    session: AsyncSession,
    *,
    issue: ConsumableIssue,
    user_id: uuid.UUID,
    disposition: str,
    note: str | None,
) -> ConsumableIssue:
    """Acknowledge the flag (TRX-006 / §4.2). Caller commits."""
    issue.cleared_at = datetime.now(UTC)
    issue.cleared_by_user_id = user_id
    issue.disposition = disposition
    issue.clear_note = note
    await session.flush()
    # Acknowledging is what makes the alert stop being true, so it is also what
    # resolves the notification. Without this the bell would keep the expiry
    # warning after somebody had physically checked and signed for it.
    mark_issue(session, issue.id)
    return issue
