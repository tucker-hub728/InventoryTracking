"""Async SQLAlchemy engine + session factory.

One engine per process, lazily instantiated. ``get_session()`` yields a
request-scoped ``AsyncSession`` for FastAPI dependency injection — see
``app.api.deps.DBSession``.

Why an explicit ``async_sessionmaker`` rather than calling ``AsyncSession``
directly: the sessionmaker remembers options (autoflush, expire_on_commit)
so every request gets identical session semantics.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Return the process-wide async engine, creating it on first call."""
    # Module-level singletons: an engine per process, not per request.
    global _engine, _sessionmaker  # noqa: PLW0603
    if _engine is None:
        settings = get_settings()
        # RDS (prod) enforces TLS (rds.force_ssl=1); the local dev postgres
        # container does not accept TLS, so only require it outside dev.
        connect_args = {"ssl": "require"} if settings.is_production else {}
        _engine = create_async_engine(
            str(settings.database_url),
            connect_args=connect_args,
            # Pool sizing: tuned for a single-pod dev setup. Bump for prod.
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,  # cheap reconnect after idle disconnects
            pool_recycle=1800,  # recycle conns every 30 min
            echo=False,  # SQL logs go through structlog at logger level
            future=True,
        )
        _sessionmaker = async_sessionmaker(
            bind=_engine,
            class_=AsyncSession,
            expire_on_commit=False,  # objects remain usable after commit
            autoflush=False,  # explicit flushes; safer with async
        )
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Return the sessionmaker, ensuring the engine exists."""
    get_engine()
    assert _sessionmaker is not None  # set by get_engine()
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency that yields a per-request session.

    Commits on success, rolls back on any exception, and always closes.
    Use via the ``DBSession`` annotation in ``app.api.deps``.

    Just before the commit it drains any notification work the request queued
    (NOTIF-001). This is the only place in the codebase where "this transaction
    is about to become durable" is known, which is exactly what the notification
    emitter needs: the ledger helpers tag the items they touched onto
    ``session.info``, and evaluating them here — rather than inside each helper —
    means a multi-line issue is judged on its finished state instead of a
    half-applied one. The ``pg_notify`` the emitter issues is queued by Postgres
    and delivered only if this commit succeeds, so a rollback takes the
    notification with it.

    ``flush_pending`` never raises. A notification is a courtesy; the receipt it
    rides along with is not.
    """
    # Local import: the emitter reaches into the inventory and consumables
    # packages, which reach back here for their own session types.
    from app.notifications.emitter import flush_pending

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        try:
            yield session
            await flush_pending(session)
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    """Close the engine and its pool. Called from the lifespan shutdown."""
    global _engine, _sessionmaker  # noqa: PLW0603
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _sessionmaker = None
