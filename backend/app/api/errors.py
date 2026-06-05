"""HTTP exception handlers.

Maps our domain exceptions (``app.core.exceptions``) to JSON responses with a
stable shape:

    {
      "code": "not_found",
      "message": "Item not found",
      "details": {...},
      "request_id": "uuid..."
    }

Routes never craft this shape manually — they ``raise NotFoundError(...)``
and the handler does the right thing.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import ORJSONResponse

from app.core.exceptions import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    DomainError,
    IntegrationError,
    NotFoundError,
    RateLimitedError,
    ValidationError,
)
from app.core.logging import get_logger

log = get_logger(__name__)

# Map each known domain class to an HTTP status code. Subclasses inherit
# their parent's mapping unless they appear in this dict themselves.
_STATUS_MAP: dict[type[DomainError], int] = {
    NotFoundError: status.HTTP_404_NOT_FOUND,
    ConflictError: status.HTTP_409_CONFLICT,
    ValidationError: status.HTTP_422_UNPROCESSABLE_CONTENT,
    AuthenticationError: status.HTTP_401_UNAUTHORIZED,
    AuthorizationError: status.HTTP_403_FORBIDDEN,
    RateLimitedError: status.HTTP_429_TOO_MANY_REQUESTS,
    IntegrationError: status.HTTP_502_BAD_GATEWAY,
}


def _status_for(exc: DomainError) -> int:
    for cls, code in _STATUS_MAP.items():
        if isinstance(exc, cls):
            return code
    return status.HTTP_400_BAD_REQUEST


def _envelope(
    *, code: str, message: str, details: dict[str, Any] | None, request: Request
) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "details": details or {},
        "request_id": request.headers.get("x-request-id"),
    }


async def _handle_domain(request: Request, exc: DomainError) -> ORJSONResponse:
    http_status = _status_for(exc)
    log.warning(
        "api.domain_error",
        code=exc.code,
        http_status=http_status,
        message=exc.message,
        details=exc.details,
    )
    return ORJSONResponse(
        status_code=http_status,
        content=_envelope(code=exc.code, message=exc.message, details=exc.details, request=request),
    )


def _json_safe(value: Any) -> Any:
    """Recursively coerce a value into something orjson can encode.

    Pydantic v2 validation errors embed the raw ``input`` and constraint
    ``ctx`` — which for ``Decimal``-typed fields are ``Decimal`` objects and
    for ``BeforeValidator`` failures are exception instances. orjson can't
    encode either, so anything that isn't a JSON-native type is stringified
    (the error message survives; the encoder doesn't choke).
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return str(value)


def _sanitize_pydantic_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Make Pydantic validation errors JSON-encodable.

    The raw error dicts can carry ``Decimal`` inputs / constraint bounds and
    exception objects that orjson rejects — recursively stringify anything
    that isn't a JSON-native type so the 422 response renders cleanly.
    """
    return [_json_safe(err) for err in errors]


async def _handle_validation(request: Request, exc: RequestValidationError) -> ORJSONResponse:
    # Pydantic / FastAPI validation: shape errors on the request itself.
    return ORJSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=_envelope(
            code="request_invalid",
            message="Request payload failed validation.",
            details={"errors": _sanitize_pydantic_errors(exc.errors())},
            request=request,
        ),
    )


async def _handle_unexpected(request: Request, exc: Exception) -> ORJSONResponse:
    # Catch-all. Log with stack info; do NOT leak the exception message to
    # the client — it might contain secrets / SQL fragments / paths.
    log.exception("api.unhandled_error", error_type=type(exc).__name__)
    return ORJSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=_envelope(
            code="internal_error",
            message="An unexpected error occurred.",
            details=None,
            request=request,
        ),
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Wire all handlers into the FastAPI app. Called once from ``main``."""
    app.add_exception_handler(DomainError, _handle_domain)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _handle_validation)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _handle_unexpected)
