"""The daily Order-archiving job (REQ-2026-07-15-DATA-001).

A plain asyncio task started by the application lifespan, rather than a new
dependency or a piece of infrastructure. The reasoning:

* The sweep is ONE idempotent statement guarded on ``archived_at IS NULL``, so
  a second instance running it at the same moment archives nothing extra and
  cannot corrupt anything. That removes the usual reason to need a real
  scheduler with leader election.
* Adding Celery or APScheduler for one nightly UPDATE is a lot of moving parts
  to keep alive, and each is another thing that can silently stop.
* It needs no change to the deployment, so beta gets it without an infra story.

It is deliberately observable: every run is logged, and the last run is stamped
into ``app_settings`` so the Receipt Admin panel can show "last run …". A job
that dies quietly is worse than no job, because the list looks tidy right up
until it doesn't.

If this ever needs to be a real scheduled task (an ECS scheduled task calling
the endpoint, say), the logic is in ``archiving.sweep`` and this module is the
only thing that gets deleted.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

from app.core.logging import get_logger
from app.db.session import get_sessionmaker
from app.inventory import archiving

log = get_logger(__name__)

#: Once a day (client 2026-08-06). Also runs once shortly after startup, so a
#: long-lived deployment isn't the only way the policy ever takes effect.
INTERVAL_SECONDS = 24 * 60 * 60

#: A short delay before the first run, so startup isn't competing with it.
STARTUP_DELAY_SECONDS = 60


async def _run_once() -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        days = await archiving.get_archive_after_days(session)
        count = await archiving.sweep(session)
        await archiving.set_last_swept_at(session)
        await session.commit()
    # Logged even at zero: "ran, archived nothing" and "never ran" look the
    # same from the outside otherwise.
    log.info("orders.archive_sweep", archived=count, archive_after_days=days)


async def _loop() -> None:
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while True:
        try:
            await _run_once()
        except Exception as exc:
            log.exception("orders.archive_sweep_failed", error=str(exc))
        await asyncio.sleep(INTERVAL_SECONDS)


def start(app) -> asyncio.Task:
    """Kick the loop off and hand back the task so shutdown can cancel it."""
    task = asyncio.create_task(_loop(), name="order-archive-sweep")
    app.state.archive_task = task
    return task


async def stop(app) -> None:
    task = getattr(app.state, "archive_task", None)
    if task is None:
        return
    task.cancel()
    # Cancellation is the expected outcome here, not a failure.
    with suppress(asyncio.CancelledError):
        await task
