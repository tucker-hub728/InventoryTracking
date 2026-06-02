"""FastAPI application factory.

The factory pattern (``create_app()`` instead of a module-level ``app``) buys
us two things:

1. Tests instantiate a fresh app per fixture with overridden settings.
2. The same factory is reused by the production runner (gunicorn → uvicorn
   workers) and by ``uvicorn --reload`` in development without duplication.

This module is the only place that knows the full composition: settings,
logging, middlewares, exception handlers, routers, lifespan.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import ORJSONResponse

from app import __version__
from app.api.errors import register_exception_handlers
from app.api.v1.router import api_router as api_v1_router
from app.core.config import get_settings
from app.core.lifespan import lifespan
from app.core.logging import configure_logging, get_logger
from app.middlewares.request_context import RequestContextMiddleware


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)
    log = get_logger(__name__)

    app = FastAPI(
        title="CellReady IMS API",
        version=__version__,
        description="Inventory management system for cell-therapy operations.",
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        openapi_url="/openapi.json" if not settings.is_production else None,
        default_response_class=ORJSONResponse,
        lifespan=lifespan,
    )

    # ── Middlewares (registered outermost first; processed innermost first) ──
    # CORS must be outermost so it sees the actual response status set by
    # deeper handlers, including OPTIONS preflight.
    if settings.cors_allow_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allow_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["X-Request-Id"],
        )

    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(RequestContextMiddleware)

    # ── Exception handlers ──────────────────────────────────────────────
    register_exception_handlers(app)

    # ── Routers ─────────────────────────────────────────────────────────
    app.include_router(api_v1_router, prefix=settings.api_v1_prefix)

    log.info(
        "app.composed",
        cors_origins=settings.cors_allow_origins,
        v1_prefix=settings.api_v1_prefix,
    )
    return app


# Uvicorn / gunicorn entry point: `uvicorn app.main:app`
app = create_app()
