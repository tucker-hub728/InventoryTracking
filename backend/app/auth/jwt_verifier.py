"""Verify Cognito-issued JWTs.

Why we verify locally instead of calling Cognito on every request:
    The whole point of asymmetric (RS256) tokens is that any party with the
    public JWKS can verify them without a round-trip. A network hop per
    request would be the dominant latency cost.

Verification rules (matches AWS guidance):
    1. Signature must validate against a key from the pool's JWKS.
    2. ``iss`` must equal the pool's issuer URL.
    3. ``token_use`` must match what the caller asked for ("access" or "id").
    4. ``aud`` (id tokens) or ``client_id`` (access tokens) must equal the
       pool's app client ID — otherwise tokens from a *different* client in
       the same pool would be accepted.
    5. ``exp`` must be in the future (PyJWT does this automatically).

Token use distinction:
    - Access token: API authentication. Stable for the access-token TTL
      (default 60 min in Cognito).
    - ID token: identity / user attributes. Same TTL but carries claims
      like ``email``, ``name``, custom attrs.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Literal

import jwt
from jwt import InvalidTokenError, PyJWKClient

from app.core.config import get_settings
from app.core.exceptions import AuthenticationError
from app.core.logging import get_logger

log = get_logger(__name__)

TokenUse = Literal["access", "id"]


@lru_cache(maxsize=1)
def _jwk_client() -> PyJWKClient:
    settings = get_settings()
    jwks_url = settings.effective_jwks_url
    if not jwks_url:
        raise AuthenticationError(
            "JWKS URL not resolvable",
            code="cognito_unconfigured",
            details={"hint": "Set COGNITO_USER_POOL_ID and (locally) COGNITO_ENDPOINT_URL"},
        )
    # ``PyJWKClient`` caches keys in-memory. Cognito rotates signing keys
    # roughly yearly; a process restart picks up new ones. Active rotation
    # is a future enhancement once we add a worker for it.
    return PyJWKClient(jwks_url, cache_keys=True, lifespan=24 * 3600)


def reset_jwk_cache() -> None:
    """Used by tests to drop the cached client between pool reconfigurations."""
    _jwk_client.cache_clear()


def verify_token(token: str, *, token_use: TokenUse = "access") -> dict[str, Any]:
    """Validate a Cognito JWT and return its claims.

    Raises :class:`AuthenticationError` on any failure — signature, expiry,
    issuer mismatch, wrong token_use, missing claims, etc.
    """
    settings = get_settings()
    issuer = settings.effective_cognito_issuer
    client_id = settings.cognito_client_id

    if not issuer or not client_id:
        raise AuthenticationError(
            "Cognito is not configured",
            code="cognito_unconfigured",
        )

    # Resolve the signing key from the token's ``kid`` header.
    try:
        signing_key = _jwk_client().get_signing_key_from_jwt(token).key
    except Exception as exc:  # PyJWT raises a variety of low-level types here
        log.warning("auth.jwt.kid_lookup_failed", error=str(exc))
        raise AuthenticationError("Invalid token signature") from exc

    # Decode + verify standard claims. We let PyJWT handle ``iss`` / ``aud``
    # / ``exp`` where applicable, and validate ``token_use`` / ``client_id``
    # explicitly because Cognito access tokens don't carry an ``aud`` claim.
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=client_id if token_use == "id" else None,
            issuer=issuer,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                "verify_aud": token_use == "id",
                "require": ["exp", "iss", "token_use"],
            },
        )
    except InvalidTokenError as exc:
        log.warning("auth.jwt.invalid", reason=str(exc))
        raise AuthenticationError(f"Invalid token: {exc}") from exc

    # Cross-check the token kind matches what the caller expected.
    if claims.get("token_use") != token_use:
        raise AuthenticationError(
            "Wrong token type",
            details={
                "expected": token_use,
                "got": claims.get("token_use"),
            },
        )

    # Access tokens carry ``client_id`` instead of ``aud``. Enforce the
    # client binding manually so a token issued for app client A is not
    # accepted by an API expecting app client B.
    if token_use == "access" and claims.get("client_id") != client_id:
        raise AuthenticationError(
            "Token client_id mismatch",
            details={"got": claims.get("client_id")},
        )

    return claims
