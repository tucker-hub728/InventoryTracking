"""Request-scoped context middleware.

Generates (or honours) an ``X-Request-Id`` per request and binds it into the
structlog context so every log line emitted while handling the request
carries it. Also times the request and logs an access line on completion.

Why one middleware for both: the access log line needs the request id and
elapsed time anyway, and request handling is a hot path — avoid stacking
middlewares unnecessarily.
"""

from __future__ import annotations

import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import get_logger

REQUEST_ID_HEADER = "x-request-id"

log = get_logger("http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())

        # Bind into structlog's contextvars so every log line in this request
        # has request_id, method, path. Cleared on context exit.
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
        )

        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers[REQUEST_ID_HEADER] = request_id
            return response
        finally:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            log.info(
                "http.request",
                status=status,
                elapsed_ms=round(elapsed_ms, 2),
                client=request.client.host if request.client else None,
            )
