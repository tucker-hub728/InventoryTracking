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
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(v) for v in value]
    return str(value)


def _sanitize_pydantic_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Make Pydantic validation errors JSON-encodable.

    The raw error dicts can carry ``Decimal`` inputs / constraint bounds and
    exception objects that orjson rejects — recursively stringify anything
    that isn't a JSON-native type so the 422 response renders cleanly.
    """
    return [_json_safe(err) for err in errors]


# Wrappers FastAPI puts at the head of ``loc``; they name where the value came
# from, not which field it was, so they are dropped from the label.
_LOC_WRAPPERS = {"body", "query", "path", "header", "cookie"}

# The most common Pydantic v2 failures, phrased for the person who typed the
# value. ``{field}`` is the humanised field name and ``{ctx}`` the constraint.
_FRIENDLY: dict[str, str] = {
    "missing": "{field} is required.",
    "string_too_long": "{field} must be at most {max_length} characters.",
    "string_too_short": "{field} must be at least {min_length} characters.",
    "too_long": "{field} may have at most {max_length} entries.",
    "too_short": "{field} needs at least {min_length} entries.",
    "greater_than": "{field} must be greater than {gt}.",
    "greater_than_equal": "{field} must be {ge} or more.",
    "less_than": "{field} must be less than {lt}.",
    "less_than_equal": "{field} must be {le} or less.",
    "string_pattern_mismatch": "{field} isn't in the expected format.",
    "extra_forbidden": "{field} isn't a field on this request.",
    "int_parsing": "{field} must be a whole number.",
    "int_from_float": "{field} must be a whole number.",
    "float_parsing": "{field} must be a number.",
    "decimal_parsing": "{field} must be a number.",
    "bool_parsing": "{field} must be true or false.",
    "date_from_datetime_parsing": "{field} must be a valid date.",
    "date_parsing": "{field} must be a valid date.",
    "datetime_parsing": "{field} must be a valid date and time.",
    "uuid_parsing": "{field} must be a valid id.",
    "enum": "{field} must be one of: {expected}.",
    "literal_error": "{field} must be one of: {expected}.",
}


def _field_label(loc: tuple[Any, ...]) -> str:
    """Turn a Pydantic ``loc`` into something a person recognises.

    ``('body', 'name')`` → "Name"; ``('body', 'sources', 0, 'qty')`` →
    "Sources 1 → Qty" (1-based, because the operator counted the rows on screen
    starting at one).
    """
    parts: list[str] = []
    for piece in loc:
        if isinstance(piece, str):
            if piece in _LOC_WRAPPERS:
                continue
            parts.append(piece.replace("_", " ").strip().capitalize())
        elif isinstance(piece, int):
            # Index of a list entry — attach to the field just named.
            if parts:
                parts[-1] = f"{parts[-1]} {piece + 1}"
    return " → ".join(parts) if parts else "The request"


def _friendly_error(err: dict[str, Any]) -> str:
    """One validation failure, in plain words."""
    field = _field_label(tuple(err.get("loc", ())))
    err_type = str(err.get("type", ""))
    ctx = err.get("ctx") or {}

    template = _FRIENDLY.get(err_type)
    if template:
        try:
            return template.format(field=field, **{k: _json_safe(v) for k, v in ctx.items()})
        except (KeyError, IndexError):
            pass  # Constraint absent from ctx — fall through to Pydantic's own text.

    # Our own ``model_validator``s raise ValueError with a written-out reason
    # ("Destination cells must be distinct"); Pydantic prefixes it with
    # "Value error, ", which is noise to whoever is reading it.
    msg = str(err.get("msg", "")).removeprefix("Value error, ").strip()
    if not msg:
        return f"{field} is invalid."
    if field == "The request":
        return msg if msg.endswith(".") else f"{msg}."
    return f"{field}: {msg}" + ("" if msg.endswith(".") else ".")


def _validation_message(errors: list[dict[str, Any]]) -> str:
    """Join the failures into one sentence for the dialog that will show it.

    Capped: a form with fifteen problems produces a paragraph nobody reads, and
    the full list is still in ``details.errors`` for anyone debugging.
    """
    if not errors:
        return "Request payload failed validation."
    shown = [_friendly_error(e) for e in errors[:3]]
    if len(errors) > 3:
        shown.append(f"(+{len(errors) - 3} more problem{'s' if len(errors) - 3 > 1 else ''})")
    return " ".join(shown)


async def _handle_validation(request: Request, exc: RequestValidationError) -> ORJSONResponse:
    # Pydantic / FastAPI validation: shape errors on the request itself.
    #
    # The message says WHICH field and WHY — "Name must be at most 64
    # characters." rather than "Request payload failed validation.", which told
    # the operator only that something, somewhere, was wrong. Every dialog in
    # the app renders ``ApiError.message``, so phrasing it here fixes all of
    # them at once rather than per form.
    errors = _sanitize_pydantic_errors(exc.errors())
    return ORJSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=_envelope(
            code="request_invalid",
            message=_validation_message(errors),
            details={"errors": errors},
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
