"""Server-sent events for the notification bell (NOTIF-001).

**Why SSE and not a WebSocket.** The browser cannot reach this service at all —
in production only the Next.js container publishes a port, and every call
arrives through its BFF proxy, which reads the access token from an HttpOnly
cookie and attaches it as a Bearer header. That single fact decides the
transport:

* A WebSocket would need the backend made publicly routable (a CloudFormation
  change), the frontend's ``connect-src 'self'`` CSP widened, and a ticket
  endpoint to carry identity past a cookie the browser is not allowed to read.
  It would also need a parallel auth path, because ``HTTPBearer.__call__`` is
  annotated ``request: Request`` and FastAPI passes a ``WebSocket`` on a
  websocket scope, so the parameter is never filled.
* SSE stays a plain authenticated ``GET``. The existing auth chain works
  unchanged, the BFF's silent-refresh-and-replay works unchanged, and no infra
  moves. The connection is one-way, which is all a bell needs — marking read is
  an ordinary POST.

**Why every process listens.** Production runs 2–3 instances × 2 gunicorn
workers. A registry in one process's memory would deliver only to browsers that
happened to land on that process — and would pass every single-container test.
``LISTEN``/``NOTIFY`` on a dedicated connection per process is what makes the
fan-out real, using the database that is already there.

**Why each event carries a snapshot rather than a delta.** A cursor over
``created_at`` is quietly wrong: commit order is not timestamp order, so a long
transaction can commit rows stamped *earlier* than ones a client has already
seen, and those rows would never be sent. Sending the current unread head
instead makes every event idempotent and self-healing — a client that misses
one is corrected by the next, and a reconnect needs no replay protocol.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.session import get_sessionmaker
from app.notifications import repository as notif_repo
from app.notifications.emitter import NOTIFY_CHANNEL
from app.notifications.schemas import NotificationRead

log = get_logger(__name__)

#: Must stay comfortably under the shortest idle timeout in the chain. The ALB
#: default is 60s (the CloudFormation template overrides nothing) and
#: CloudFront's origin read timeout defaults to 30s, so a quiet stream has to
#: put a byte on the wire well inside 30 seconds or it is torn down.
HEARTBEAT_SECONDS = 15

#: Re-read even without a NOTIFY. Covers the gap while the listener reconnects,
#: and anything a failed ``flush_pending`` swallowed.
SAFETY_POLL_SECONDS = 30

#: Close cleanly and let EventSource reconnect. This is not a resource limit —
#: it is how two otherwise-awkward problems are solved for free. The access
#: token is valid for 60 minutes and a stream that authenticated once would
#: outlive it; and ``_assert_active`` runs per request, so a user deactivated
#: mid-stream would keep receiving data indefinitely. Reconnecting through the
#: BFF re-runs both checks, with a refreshed token.
MAX_LIFETIME_SECONDS = 600

#: Backoff between attempts to re-establish the LISTEN connection.
_LISTEN_RETRY_SECONDS = 5

#: user_id → the queues of that user's open streams in THIS process. A user
#: with three tabs open has three.
_subscribers: dict[uuid.UUID, set[asyncio.Queue]] = {}


def subscribe(user_id: uuid.UUID) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    _subscribers.setdefault(user_id, set()).add(queue)
    return queue


def unsubscribe(user_id: uuid.UUID, queue: asyncio.Queue) -> None:
    queues = _subscribers.get(user_id)
    if not queues:
        return
    queues.discard(queue)
    if not queues:
        _subscribers.pop(user_id, None)


def wake(user_ids: set[uuid.UUID] | None) -> None:
    """Nudge the named users' streams in this process. ``None`` means everyone.

    The queue holds one token and nothing more: it is a "go and look" signal,
    not a delivery. ``QueueFull`` is the good case — a stream that has not yet
    acted on the last nudge does not need a second one.
    """
    targets = _subscribers.keys() if user_ids is None else user_ids
    for uid in list(targets):
        for queue in _subscribers.get(uid, ()):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(None)


# ── The LISTEN connection ────────────────────────────────────────────────


def _raw_dsn() -> str:
    """asyncpg wants a plain DSN; SQLAlchemy's carries a ``+asyncpg`` driver tag."""
    return str(get_settings().database_url).replace("+asyncpg", "")


def _on_notify(_conn: Any, _pid: int, _channel: str, payload: str) -> None:
    try:
        data = json.loads(payload)
    except ValueError:
        # A malformed payload should still wake everyone rather than be
        # dropped: the payload is only ever a hint about who to wake, and
        # over-waking costs one query.
        wake(None)
        return
    if data.get("all"):
        wake(None)
        return
    ids = set()
    for raw in data.get("user_ids", ()):
        with contextlib.suppress(ValueError, TypeError):
            ids.add(uuid.UUID(raw))
    wake(ids or None)


async def _listen_loop() -> None:
    """Hold one dedicated connection open, re-establishing it on failure.

    Deliberately outside the SQLAlchemy pool. ``LISTEN`` registers interest on
    a specific backend session, and the pool recycles connections every 30
    minutes (``pool_recycle=1800``) — a listener borrowed from it would stop
    receiving silently, which is the worst way for this to fail.
    """
    while True:
        conn = None
        try:
            settings = get_settings()
            conn = await asyncpg.connect(
                _raw_dsn(),
                ssl="require" if settings.is_production else None,
            )
            closed = asyncio.Event()
            # Default arg binds this iteration's event; the loop rebinds `closed`
            # on every reconnect and a late-bound closure would set the wrong one.
            conn.add_termination_listener(lambda _c, ev=closed: ev.set())
            await conn.add_listener(NOTIFY_CHANNEL, _on_notify)
            log.info("notifications.listener_connected", channel=NOTIFY_CHANNEL)
            # Nothing to do but stay alive; ``_on_notify`` does the work. Wait
            # on the event rather than polling ``is_closed`` so a dropped
            # connection is noticed the moment it drops — a listener that is
            # quietly dead looks exactly like a system where nothing is
            # happening, which is the failure mode worth spending a callback on.
            if conn.is_closed():
                closed.set()
            await closed.wait()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Broad on purpose: this loop has to outlive any failure, because
            # nothing else will restart it.
            log.warning("notifications.listener_lost", error=str(exc))
        finally:
            if conn is not None:
                with contextlib.suppress(Exception):
                    await conn.close()
        await asyncio.sleep(_LISTEN_RETRY_SECONDS)


def start(app) -> asyncio.Task:
    """Start the per-process listener. Mirrors ``inventory.archive_job.start``."""
    task = asyncio.create_task(_listen_loop(), name="notifications-listener")
    app.state.notifications_listener = task
    return task


async def stop(app) -> None:
    task = getattr(app.state, "notifications_listener", None)
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


# ── The event stream ─────────────────────────────────────────────────────


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _snapshot(user_id: uuid.UUID) -> dict:
    """The bell's current contents, read on its own short-lived session.

    A dedicated session per read, rather than one held for the life of the
    stream: the pool is 5 connections (+10 overflow) per process, and a
    ten-minute stream holding one would let a dozen idle browsers exhaust it.
    """
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        rows = await notif_repo.feed_head(session, user_id=user_id)
        unread = await notif_repo.unread_count(session, user_id=user_id)
    return {
        "items": [NotificationRead.model_validate(r).model_dump(mode="json") for r in rows],
        "unread_count": unread,
    }


async def event_stream(user_id: uuid.UUID) -> AsyncIterator[str]:
    """Yield SSE frames until the client leaves or the lifetime cap is hit."""
    queue = subscribe(user_id)
    loop = asyncio.get_running_loop()
    started = loop.time()
    last_poll = 0.0
    try:
        # Tell the client the retry interval up front, then send the current
        # state immediately — the bell must be correct on the first paint, not
        # after the first event happens to fire.
        yield f"retry: {HEARTBEAT_SECONDS * 1000}\n\n"
        yield _sse("snapshot", await _snapshot(user_id))
        last_poll = loop.time()

        while loop.time() - started < MAX_LIFETIME_SECONDS:
            woken = True
            try:
                await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except TimeoutError:
                woken = False

            due = loop.time() - last_poll >= SAFETY_POLL_SECONDS
            if woken or due:
                yield _sse("snapshot", await _snapshot(user_id))
                last_poll = loop.time()
            else:
                # A comment frame. Invisible to EventSource, but it is a byte
                # on the wire, which is the only thing the idle timeouts count.
                yield ": ping\n\n"
    except asyncio.CancelledError:
        # The client went away. Normal, not an error.
        raise
    finally:
        unsubscribe(user_id, queue)
