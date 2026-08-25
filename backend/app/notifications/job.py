"""The hourly notification sweep (NOTIF-001).

A plain asyncio task, for the reasons ``app/inventory/archive_job.py`` already
argues for the order-archiving sweep: the work is idempotent, so two instances
running it at the same moment is harmless, and neither Celery nor APScheduler
earns its keep for one periodic read.

Idempotency here is not incidental — it is the whole design. The sweep re-reads
every subject and compares against ``notification_alert_state``, so a subject
that has not changed produces no rows no matter how many times it runs.

**This is not only a safety net.** Two transitions have no write anywhere in the
system to hook onto, and the request-time hook structurally cannot catch them:

1. A consumable crosses ``warn`` and later ``expired`` purely because the date
   moved. Nobody issued anything; the register row is untouched.
2. An item falls below its reorder threshold because a lot expired *out of*
   ``qty_available``. The ``v_item_stock`` view subtracts date-expired lots
   (``expiration_date < CURRENT_DATE``), so an item can go from available to
   out of stock overnight with zero writes to the ledger.

Hourly rather than daily because both are date-rollover effects and the
facility does not run on UTC; hourly bounds the lag to an hour whatever the
local midnight is. Hourly rather than every minute because the event hook
already covers everything that has an event, so this is only ever chasing the
clock.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

from app.core.logging import get_logger
from app.db.session import get_sessionmaker
from app.notifications import emitter

log = get_logger(__name__)

INTERVAL_SECONDS = 60 * 60

#: Long enough to be clear of startup, and of the archive job's own 60s delay,
#: so a cold boot is not three things competing for the same pool.
STARTUP_DELAY_SECONDS = 90


async def _run_once() -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        woken = await emitter.evaluate_and_emit(session, scan_all=True)
        await session.commit()
    # Logged even at zero. "Ran, nothing changed" and "never ran" look
    # identical from the outside otherwise, and a bell that has quietly
    # stopped is worse than no bell — the empty panel reads as good news.
    log.info("notifications.sweep", users_woken=woken)


async def _loop() -> None:
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while True:
        try:
            await _run_once()
        except Exception as exc:
            log.exception("notifications.sweep_failed", error=str(exc))
        await asyncio.sleep(INTERVAL_SECONDS)


def start(app) -> asyncio.Task:
    """Kick the loop off and hand back the task so shutdown can cancel it."""
    task = asyncio.create_task(_loop(), name="notifications-sweep")
    app.state.notifications_sweep = task
    return task


async def stop(app) -> None:
    task = getattr(app.state, "notifications_sweep", None)
    if task is None:
        return
    task.cancel()
    # Cancellation is the expected outcome here, not a failure.
    with suppress(asyncio.CancelledError):
        await task
