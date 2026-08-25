"""Deciding when to say something, and to whom (NOTIF-001).

This module is the only place that writes ``notification_deliveries``.

The hard part is not writing rows, it is not writing them twice. A low-stock
alert describes a **state**, not an event: ``app.v_item_stock`` reports that an
item is below its threshold, and nothing anywhere records the moment it crossed.
So an evaluator with no memory, run on a timer, re-announces every
below-threshold item on every run — forever, to everyone.

``notification_alert_state`` is that memory. Each evaluation compares the
subject's state now against the state we last announced, and acts only on the
difference:

===================  ==========================  ==================================
was                  is                          what happens
===================  ==========================  ==================================
available            low_stock / out_of_stock    emit
low_stock            out_of_stock                resolve the old row, emit a new one
low_stock            low_stock                   nothing
low_stock            available                   resolve
===================  ==========================  ==================================

Two callers, for two different reasons:

* **The request hook** (``app.db.session.get_session``) drains the item ids that
  the stock-movement helpers tagged onto the session, just before commit. This
  is what makes the bell feel instant.
* **The hourly job** (``job.py``) re-scans everything. It is not just a safety
  net for a missed hook: two transitions have no write to hook onto at all — a
  consumable crosses ``expired`` when the date rolls over, and an item can fall
  below its threshold because a lot expired *out of* ``qty_available`` (the
  view subtracts date-expired lots). Nothing is written in either case.

Fan-out is to every active user who can *act* on inventory — see
``RECIPIENT_ACTION`` below for why that is ``sign`` and not ``view``. Phase 1
has no subscriptions (client, 2026-08-25); ``PERM_MATRIX`` is the targeting
knob, and it is a plain dict, so this costs nothing and needs no migration.

The actor is **not** excluded. Deliberate: for a threshold breach the person who
caused it is exactly who needs to know, because they are holding the last box.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.consumables import repository as cons_repo
from app.core.logging import get_logger
from app.models.consumables import ConsumableIssue
from app.models.identity import User
from app.models.inventory import Item
from app.models.notifications import NotificationAlertState, NotificationDelivery
from app.notifications.pending import take_pending
from app.security.permissions import has_permission

log = get_logger(__name__)

#: The LISTEN/NOTIFY channel every backend process subscribes to. Prod runs
#: 2–3 instances × 2 gunicorn workers, so a notification written by the process
#: that handled the POST would otherwise only ever reach browsers connected to
#: that same process — a bug that passes every single-container test.
NOTIFY_CHANNEL = "cellready_notifications"

#: Postgres caps a NOTIFY payload at 8000 bytes. Well under it, we send the
#: affected user ids so a process holding none of them can skip the wake-up
#: entirely; over it, we send a bare wake-up and every process re-reads. The
#: payload is a *hint* either way — NOTIFY is at-most-once, so the data itself
#: must never live in it.
_MAX_PAYLOAD_BYTES = 6000

ITEM_SUBJECT = "app.items"
ISSUE_SUBJECT = "app.consumable_issues"

#: State → kind. Both item alert states map to one kind: "you need to order
#: this" is the same class of message whether the shelf is low or empty, and
#: the severity is carried by ``body.status_code``, which is also what the
#: client resolves its badge tone from.
_ITEM_KIND = "reorder_threshold"
_ISSUE_KINDS = {"warn": "expiration_warning", "expired": "expiration_expired"}

#: The states that are worth telling somebody about.
_ALERTING_ITEM_STATES = ("low_stock", "out_of_stock")
_ALERTING_ISSUE_STATES = ("warn", "expired")


# ── Recipients ───────────────────────────────────────────────────────────


#: Who an alert goes to. ``sign``, deliberately, not ``view``.
#:
#: Both alerts this module raises ask somebody to *do* something, and both of
#: those actions are gated on exactly this permission: acknowledging an expiry
#: check (``POST /consumables/{id}/acknowledge``) and receiving stock to
#: inventory (``POST /allocations/receive-to-inventory``) are e-signed and
#: require ``inventory:sign``. A ``read_only`` user holds ``inventory:view`` and
#: can do neither, so a reorder alert addressed to them is a message nobody can
#: act on.
#:
#: This is also the difference between a feature and an outage. Fan-out writes
#: one row per recipient: on the dev database ``view`` selects 518 users (513 of
#: them seeded ``read_only`` accounts) against 5 recipients for ``sign``. Every
#: threshold breach would have written 518 rows, and the first sweep after
#: deployment several thousand — to fill 513 inboxes that cannot respond.
#:
#: Reading a notification is still gated on ``view`` at the route, so nothing
#: here can hide a row from someone who legitimately has one.
RECIPIENT_ACTION = "sign"


async def recipient_ids(session: AsyncSession) -> list[uuid.UUID]:
    """Active users who can act on an inventory alert.

    Filtering in Python rather than SQL because ``PERM_MATRIX`` is a Python
    dict — it is the v1 bridge until the RBAC tables ship, and reproducing its
    logic as a SQL ``role IN (...)`` list would create a second definition of
    who gets notified that nobody would remember to update.

    Suspended and soft-deleted users are excluded here rather than at send time:
    a row written for a deactivated account is one nobody will ever read, and it
    would still be sitting in the table when they were reinstated months later.
    """
    stmt = select(User.id, User.role).where(
        User.status == "active",
        User.deleted_at.is_(None),
    )
    rows = (await session.execute(stmt)).all()
    return [uid for uid, role in rows if has_permission(role, "inventory", RECIPIENT_ACTION)]


# ── Body builders ────────────────────────────────────────────────────────
#
# What goes in ``body`` is the *facts*, never a rendered label or a colour.
# The client turns ``status_code`` into a badge through ``config/inventory.ts``
# and nothing else; a server-supplied label would become a second source for
# something that has already been wrong three ways at once.


def _num(value: Decimal | int | None) -> str | None:
    """NUMERIC as a string, matching how every other endpoint sends it."""
    return None if value is None else str(value)


def _item_body(item: Item, *, status_code: str, lead_time_days: int | None) -> dict:
    return {
        "status_code": status_code,
        "item_id": str(item.id),
        "item_number": item.item_number,
        "description": item.description,
        "uom": item.uom or "",
        "qty_available": _num(item.stock.qty_available if item.stock else Decimal(0)),
        "reorder_threshold": _num(item.reorder_threshold),
        "lead_time_days": lead_time_days,
    }


def _issue_body(
    issue: ConsumableIssue,
    *,
    flag: str,
    expiration_date: date | None,
    days_to_expiry: int | None,
) -> dict:
    movement = issue.movement
    item = getattr(movement, "item", None)
    lot = getattr(movement, "lot", None)
    return {
        "flag": flag,
        "issue_id": str(issue.id),
        "item_id": str(movement.item_id),
        "item_number": getattr(item, "item_number", "") if item else "",
        "item_description": getattr(item, "description", None) if item else None,
        "lot_number": getattr(lot, "lot_number", None) if lot else None,
        "expiration_date": expiration_date.isoformat() if expiration_date else None,
        "days_to_expiry": days_to_expiry,
    }


# ── State transitions ────────────────────────────────────────────────────


async def _prior_states(
    session: AsyncSession, subject_table: str, subject_ids: list[uuid.UUID] | None
) -> dict[uuid.UUID, str]:
    stmt = select(NotificationAlertState.subject_id, NotificationAlertState.state).where(
        NotificationAlertState.subject_table == subject_table
    )
    if subject_ids is not None:
        stmt = stmt.where(NotificationAlertState.subject_id.in_(subject_ids))
    return dict((await session.execute(stmt)).all())


async def _record_state(
    session: AsyncSession, subject_table: str, subject_id: uuid.UUID, state: str
) -> None:
    """Upsert the remembered state. ON CONFLICT because two workers can
    genuinely evaluate the same subject at the same moment — the hourly job on
    one and a request hook on another — and the loser of that race must not
    take the business transaction down with it."""
    stmt = (
        pg_insert(NotificationAlertState)
        .values(
            subject_table=subject_table,
            subject_id=subject_id,
            state=state,
            changed_at=datetime.now(UTC),
        )
        .on_conflict_do_update(
            index_elements=["subject_table", "subject_id"],
            set_={"state": state, "changed_at": datetime.now(UTC)},
        )
    )
    await session.execute(stmt)


async def _resolve_open(session: AsyncSession, subject_table: str, subject_id: uuid.UUID) -> None:
    """Close every live row about this subject, for every user.

    Called both when a condition clears and immediately before emitting a
    replacement, so a subject never has two live alerts saying different things
    about it (an item that went low and then empty would otherwise show both).
    """
    await session.execute(
        update(NotificationDelivery)
        .where(
            NotificationDelivery.subject_table == subject_table,
            NotificationDelivery.subject_id == subject_id,
            NotificationDelivery.resolved_at.is_(None),
        )
        .values(resolved_at=datetime.now(UTC))
    )


async def _emit(
    session: AsyncSession,
    *,
    kind_code: str,
    subject_table: str,
    subject_id: uuid.UUID,
    body: dict,
    users: list[uuid.UUID],
) -> int:
    """One row per recipient. Returns how many were written."""
    if not users:
        return 0
    await _resolve_open(session, subject_table, subject_id)
    session.add_all(
        [
            NotificationDelivery(
                user_id=uid,
                kind_code=kind_code,
                subject_table=subject_table,
                subject_id=subject_id,
                body=body,
            )
            for uid in users
        ]
    )
    return len(users)


# ── Evaluation ───────────────────────────────────────────────────────────


def _item_state(item: Item) -> str:
    """Where this item stands, in the same words the view uses.

    An item whose threshold is still zero is reported ``available`` regardless
    of stock. That mirrors ``planning.repository._at_or_below``: a threshold of
    zero means nobody has set one, and without this rule every item that has
    never moved would qualify (``0 <= 0``) and the first run would announce the
    entire catalogue.
    """
    if item.reorder_threshold is None or item.reorder_threshold <= 0:
        return "available"
    stock = item.stock
    qty = stock.qty_available if stock else Decimal(0)
    if qty <= 0:
        return "out_of_stock"
    if qty <= item.reorder_threshold:
        return "low_stock"
    return "available"


async def _evaluate_items(
    session: AsyncSession,
    *,
    item_ids: list[uuid.UUID] | None,
    users: list[uuid.UUID],
) -> set[uuid.UUID]:
    """Diff every named item (or all of them) against what we last announced."""
    # ``_lead_time_subquery`` is planning's, and is imported rather than
    # rewritten on purpose: "longest lead time among this item's suppliers" is
    # a rule the client set on 2026-08-24, and a second copy here would be a
    # second thing to remember to change.
    from app.planning.repository import _lead_time_subquery

    stmt = select(Item, _lead_time_subquery().label("lead")).where(Item.deleted_at.is_(None))
    if item_ids is not None:
        stmt = stmt.where(Item.id.in_(item_ids))
    rows = (await session.execute(stmt)).unique().all()

    prior = await _prior_states(session, ITEM_SUBJECT, item_ids)
    touched: set[uuid.UUID] = set()

    for item, lead in rows:
        now_state = _item_state(item)
        was = prior.get(item.id, "available")
        if now_state == was:
            continue
        if now_state in _ALERTING_ITEM_STATES:
            written = await _emit(
                session,
                kind_code=_ITEM_KIND,
                subject_table=ITEM_SUBJECT,
                subject_id=item.id,
                body=_item_body(item, status_code=now_state, lead_time_days=lead),
                users=users,
            )
            if written:
                touched.update(users)
        else:
            await _resolve_open(session, ITEM_SUBJECT, item.id)
            # Everyone is told, because everyone was told about the alert. A
            # badge that only clears for whoever happened to be connected is
            # worse than one that never clears.
            touched.update(users)
        await _record_state(session, ITEM_SUBJECT, item.id, now_state)

    return touched


async def _evaluate_issues(
    session: AsyncSession,
    *,
    issue_ids: list[uuid.UUID] | None,
    users: list[uuid.UUID],
) -> set[uuid.UUID]:
    """Same diff, for consumable expiry.

    The flag itself is ``consumables.flag_for`` — imported, not re-derived. It
    owns the boundaries (a lot expiring *today* is already ``expired``) and
    those are pinned by that module's own tests.
    """
    warn_days = await cons_repo.get_warn_days(session)
    # Not ``expiring_only``: we need the rows that have *stopped* flagging too,
    # or an acknowledged consumable would keep its alert forever.
    issues = await cons_repo.list_issues(session, include_cleared=True, warn_days=warn_days)
    if issue_ids is not None:
        wanted = set(issue_ids)
        issues = [i for i in issues if i.id in wanted]

    prior = await _prior_states(session, ISSUE_SUBJECT, issue_ids)
    touched: set[uuid.UUID] = set()

    for issue in issues:
        expiry = cons_repo.expiry_of(issue)
        flag, days = cons_repo.flag_for(expiry, warn_days=warn_days)
        # An acknowledged row is not an alert any more, whatever its date says.
        # ``list_expiring`` suppresses the flag the same way on read.
        now_state = "ok" if (issue.cleared_at is not None or flag is None) else flag
        was = prior.get(issue.id, "ok")
        if now_state == was:
            continue
        if now_state in _ALERTING_ISSUE_STATES:
            written = await _emit(
                session,
                kind_code=_ISSUE_KINDS[now_state],
                subject_table=ISSUE_SUBJECT,
                subject_id=issue.id,
                body=_issue_body(
                    issue, flag=now_state, expiration_date=expiry, days_to_expiry=days
                ),
                users=users,
            )
            if written:
                touched.update(users)
        else:
            await _resolve_open(session, ISSUE_SUBJECT, issue.id)
            touched.update(users)
        await _record_state(session, ISSUE_SUBJECT, issue.id, now_state)

    return touched


# ── Public surface ───────────────────────────────────────────────────────


async def notify_users(session: AsyncSession, user_ids: set[uuid.UUID]) -> None:
    """Wake every process that might be holding one of these users' streams.

    ``pg_notify`` is issued **inside** the caller's transaction on purpose:
    Postgres queues the notification and delivers it only if that transaction
    commits, discarding it on rollback. That gives correct after-commit
    semantics with no outbox table and nothing to drain — which is why this
    feature needs no Redis, no Celery and no change to the deployment.
    """
    if not user_ids:
        return
    payload = json.dumps({"user_ids": sorted(str(u) for u in user_ids)})
    if len(payload.encode()) > _MAX_PAYLOAD_BYTES:
        payload = json.dumps({"all": True})
    await session.execute(
        text("SELECT pg_notify(:channel, :payload)"),
        {"channel": NOTIFY_CHANNEL, "payload": payload},
    )


async def evaluate_and_emit(
    session: AsyncSession,
    *,
    item_ids: list[uuid.UUID] | None = None,
    issue_ids: list[uuid.UUID] | None = None,
    scan_all: bool = False,
) -> int:
    """Evaluate the named subjects (or everything) and emit what changed.

    Returns the number of users woken, which is 0 on the overwhelmingly common
    path where nothing crossed a line. Callers use it only for logging — the
    work is the rows and the NOTIFY, both of which ride the caller's
    transaction.
    """
    if not scan_all and not item_ids and not issue_ids:
        return 0

    users = await recipient_ids(session)
    touched: set[uuid.UUID] = set()

    if scan_all or item_ids:
        touched |= await _evaluate_items(
            session, item_ids=None if scan_all else item_ids, users=users
        )
    if scan_all or issue_ids:
        touched |= await _evaluate_issues(
            session, issue_ids=None if scan_all else issue_ids, users=users
        )

    await session.flush()
    await notify_users(session, touched)
    return len(touched)


async def flush_pending(session: AsyncSession) -> None:
    """Drain the ids the stock-movement helpers tagged onto this session.

    Called from ``get_session`` immediately before commit — the one place in
    the codebase where "this transaction is about to become durable" is known.
    Doing it here rather than inside each movement helper matters: a multi-line
    issue writes several ledger rows, and evaluating after the first one would
    read a half-applied balance and announce a status the item never had.

    **Never raises.** A notification is a courtesy; the receipt, the issue and
    the shipment it rides along with are not. If this fails, the business
    transaction still commits and the hourly job picks the change up later.
    """
    item_ids, issue_ids = take_pending(session)
    if not item_ids and not issue_ids:
        return
    try:
        await evaluate_and_emit(
            session,
            item_ids=sorted(item_ids) if item_ids else None,
            issue_ids=sorted(issue_ids) if issue_ids else None,
        )
    except Exception as exc:
        # Broad on purpose — see the docstring. Anything at all going wrong
        # here must leave the business transaction intact.
        log.exception("notifications.flush_failed", error=str(exc))
