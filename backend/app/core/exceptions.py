"""Domain exception hierarchy.

These are app-level errors with semantics, not HTTP errors. The mapping to
HTTP status codes happens in ``app.api.errors`` — keeping the two separate
lets services stay framework-agnostic and lets tests assert on exception
types rather than HTTP response shapes.

When you find yourself wanting to ``raise HTTPException`` from a service,
add a new subclass here instead. Routers / handlers are the only place that
should know about HTTP.
"""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Base class for all anticipated business errors.

    ``code`` is a stable machine-readable string the frontend can switch on
    without parsing English. ``details`` is a freeform dict surfaced to the
    client (do not put secrets in it).
    """

    code: str = "domain_error"
    message: str = "An error occurred"

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message or self.message)
        if code is not None:
            self.code = code
        if message is not None:
            self.message = message
        self.details = details or {}


# ─── 4xx ────────────────────────────────────────────────────────────────────


class NotFoundError(DomainError):
    code = "not_found"
    message = "Resource not found"


class ConflictError(DomainError):
    """Unique-constraint violation, optimistic-lock conflict, etc."""

    code = "conflict"
    message = "Conflicting state"


class ValidationError(DomainError):
    """Business-rule validation (vs. shape validation which Pydantic handles)."""

    code = "validation_error"
    message = "Validation failed"


class AuthenticationError(DomainError):
    code = "authentication_required"
    message = "Authentication required"


class AuthorizationError(DomainError):
    code = "forbidden"
    message = "Operation not permitted"


class RateLimitedError(DomainError):
    code = "rate_limited"
    message = "Too many requests"


# ─── 5xx ────────────────────────────────────────────────────────────────────


class IntegrationError(DomainError):
    """An external system (DB, third-party API) failed in an unexpected way."""

    code = "integration_error"
    message = "Upstream system error"
