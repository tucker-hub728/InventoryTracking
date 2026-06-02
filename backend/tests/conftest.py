"""Pytest fixtures and configuration.

Strategy:
- One async ``httpx.AsyncClient`` per test, talking to the app via
  ``ASGITransport`` — no real network, no port binding, fast.
- Test settings override the real env so we never accidentally touch a real
  DB or send a real email. Override happens before any app import.
- Database-backed tests will get their own fixtures in the modules that
  introduce DB writes; this conftest only covers the smoke case.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# ── Test environment ────────────────────────────────────────────────────────
# Set before any `app` import so settings.cache picks these up.
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("APP_DEBUG", "false")
os.environ.setdefault("SECRET_KEY", "test-secret-key-must-be-at-least-32-chars-long")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://cellready:cellready_dev_only@localhost:5432/cellready_ims_test",
)
os.environ.setdefault("CORS_ALLOW_ORIGINS", "http://localhost:3000")
os.environ.setdefault("LOG_LEVEL", "WARNING")
os.environ.setdefault("LOG_FORMAT", "console")


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """Async client wired to the in-process FastAPI app.

    The engine is disposed between tests because pytest-asyncio gives each
    test its own event loop; the module-level engine would otherwise hold
    a pool of connections bound to the previous (closed) loop and the
    second test would crash on a "loop is closed" RuntimeError.
    """
    # Import inside the fixture so the env overrides above take effect.
    from app.db.session import dispose_engine
    from app.main import create_app

    app = create_app()
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        await dispose_engine()
