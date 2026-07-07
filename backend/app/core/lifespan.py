"""Application startup / shutdown.

We use FastAPI's ``lifespan`` context manager rather than the deprecated
``on_event`` hooks. Everything that needs to be initialised before the first
request handler runs (DB pool warm-up, dependency checks, scheduled jobs)
goes here; everything that needs to be cleaned up on shutdown goes after the
``yield``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.session import dispose_engine, get_engine, get_sessionmaker

log = get_logger(__name__)


async def _check_super_admin_present() -> None:
    """Warn (don't crash) when no ``super_admin`` user row exists.

    Production *must* have one; dev environments legitimately don't until
    an admin logs in once (lazy provisioning creates the row from the
    Cognito-side bootstrap user). Crashing here would make a freshly-
    seeded environment unbootable.
    """
    # Local import keeps lifespan import-time clean of ORM.
    from app.auth.repository import count_super_admins

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        count = await count_super_admins(session)
    if count == 0:
        log.warning(
            "app.startup.no_super_admin",
            hint=(
                "No super_admin row in app.users yet. The first /auth/me "
                "from the bootstrap Cognito user will create one. If this "
                "is production, provision an admin user explicitly."
            ),
        )
    else:
        log.info("app.startup.super_admin_count", count=count)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Hold the app's resources for the lifetime of the process."""
    settings = get_settings()
    log.info(
        "app.starting",
        env=settings.app_env.value,
        debug=settings.app_debug,
        version=app.version,
    )

    # ── Verify the DB is reachable. Fail fast if it isn't. ──────────────
    engine = get_engine()
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        log.error("app.startup.db_unreachable", error=str(exc))
        raise

    # Non-fatal sanity check — logs only.
    try:
        await _check_super_admin_present()
    except Exception as exc:
        # Most likely cause: identity migration hasn't run yet. Log and
        # carry on so the operator can apply migrations from a running pod.
        log.warning("app.startup.identity_check_failed", error=str(exc))

    log.info("app.started")
    try:
        yield
    finally:
        log.info("app.stopping")
        await dispose_engine()
        log.info("app.stopped")
