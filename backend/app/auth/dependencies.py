"""FastAPI dependencies for authentication.

Exposes the ``CurrentUserDep`` annotated type which:
    1. Reads the ``Authorization: Bearer <jwt>`` header (via FastAPI's
       :class:`HTTPBearer` security scheme so Swagger renders a proper
       "Authorize" button instead of an ad-hoc text field).
    2. Verifies the token via :mod:`app.auth.jwt_verifier`.
    3. Returns a typed :class:`CurrentUser` to the route handler.

Any verification failure surfaces as an ``AuthenticationError`` which
the global exception handler maps to a 401 with our standard envelope.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.auth.jwt_verifier import verify_token
from app.core.exceptions import AuthenticationError


class CurrentUser(BaseModel):
    """Authenticated principal extracted from a verified access token."""

    sub: str  # Cognito user id (immutable; the eventual users.cognito_sub FK)
    username: str  # Cognito Username (email-aliased)
    client_id: str  # App client the token was minted for
    scope: str | None = None
    access_token: str  # Carried so /auth/me can call Cognito.get_user
    raw_claims: dict[str, Any]


# ``auto_error=False`` so a missing header surfaces through our own
# ``AuthenticationError`` (which the global handler turns into the
# standard envelope with ``code: authentication_required``) — not
# FastAPI's bare ``HTTPException`` which would skip the envelope.
_bearer_scheme = HTTPBearer(
    scheme_name="BearerAuth",
    description=(
        "Cognito-issued access token. Get one from `POST /v1/auth/login`, "
        "then paste it here (without the `Bearer ` prefix — Swagger adds it)."
    ),
    auto_error=False,
)


async def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(_bearer_scheme),
    ] = None,
) -> CurrentUser:
    """Validate the bearer token and return the authenticated user."""
    if credentials is None:
        raise AuthenticationError("Missing Authorization header")
    if credentials.scheme.lower() != "bearer":
        raise AuthenticationError(
            "Authorization header must be in the form 'Bearer <token>'",
        )
    token = credentials.credentials.strip()
    if not token:
        raise AuthenticationError("Empty bearer token")

    claims = verify_token(token, token_use="access")
    return CurrentUser(
        sub=claims["sub"],
        # Cognito puts the email-aliased username under different keys
        # depending on the pool config; cover both for portability.
        username=str(claims.get("username") or claims.get("cognito:username") or claims["sub"]),
        client_id=str(claims["client_id"]),
        scope=claims.get("scope"),
        access_token=token,
        raw_claims=claims,
    )


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
