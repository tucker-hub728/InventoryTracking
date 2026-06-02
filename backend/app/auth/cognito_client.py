"""Thin facade over ``boto3.client("cognito-idp")``.

Single cached client per process. In local dev we point at ``cognito-local``
via ``COGNITO_ENDPOINT_URL``; in production the variable is unset and
``boto3`` resolves the real AWS endpoint with zero code changes.

All Cognito ``ClientError`` responses are translated to our domain
exceptions so callers never need to ``import botocore.exceptions``.

This module is the ONLY place in the codebase that imports ``boto3``.
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import get_settings
from app.core.exceptions import (
    AuthenticationError,
    ConflictError,
    DomainError,
    NotFoundError,
    ValidationError,
)
from app.core.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient

log = get_logger(__name__)

# ── Cognito error code → domain exception mapping ───────────────────────────
# These codes come from the Cognito User Pools API documentation. Anything
# not listed surfaces as a generic AuthenticationError so callers always
# get a domain exception, never a raw ClientError.
_NOT_FOUND: frozenset[str] = frozenset({"UserNotFoundException", "ResourceNotFoundException"})
_CONFLICT: frozenset[str] = frozenset({"UsernameExistsException", "AliasExistsException"})
_VALIDATION: frozenset[str] = frozenset(
    {
        "InvalidParameterException",
        "InvalidPasswordException",
        "CodeMismatchException",
        "ExpiredCodeException",
        "CodeDeliveryFailureException",
    }
)
_AUTH: frozenset[str] = frozenset(
    {
        "NotAuthorizedException",
        "UserNotConfirmedException",
        "PasswordResetRequiredException",
    }
)


def _ensure_configured() -> None:
    settings = get_settings()
    missing = [
        name
        for name, value in (
            ("COGNITO_USER_POOL_ID", settings.cognito_user_pool_id),
            ("COGNITO_CLIENT_ID", settings.cognito_client_id),
        )
        if not value
    ]
    if missing:
        raise AuthenticationError(
            "Cognito is not configured",
            code="cognito_unconfigured",
            details={"missing_env": missing},
        )


@lru_cache(maxsize=1)
def get_cognito_client() -> CognitoIdentityProviderClient:
    """Return the process-wide Cognito IDP client."""
    settings = get_settings()
    config = Config(
        region_name=settings.aws_region,
        retries={"max_attempts": 3, "mode": "standard"},
        signature_version="v4",
    )
    kwargs: dict[str, Any] = {"config": config}
    if settings.cognito_endpoint_url:
        # Local dev — talk to cognito-local. Pass dummy credentials so boto3
        # doesn't error trying to resolve the credential chain.
        kwargs["endpoint_url"] = str(settings.cognito_endpoint_url).rstrip("/")
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    return boto3.client("cognito-idp", **kwargs)


def _translate(exc: ClientError) -> DomainError:
    """Map a boto ``ClientError`` to a domain exception.

    Carries both ``cognito_code`` (the typed exception name like
    ``NotAuthorizedException``) AND ``cognito_message`` (the human
    message) in ``details``. We need both because cognito-local returns
    HTTP status codes ("400") in the Code slot instead of the typed
    name — but its Message ("Invalid password") is the same human text
    real Cognito returns. Downstream callers (e.g. reauth helper) can
    decide which signal to trust.
    """
    err = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
    code = str(err.get("Code", "Unknown"))
    msg = str(err.get("Message", "Cognito request failed"))
    details = {"cognito_code": code, "cognito_message": msg}

    if code in _NOT_FOUND:
        return NotFoundError(msg, details=details)
    if code in _CONFLICT:
        return ConflictError(msg, details=details)
    if code in _VALIDATION:
        return ValidationError(msg, details=details)
    if code in _AUTH:
        return AuthenticationError(msg, details=details)
    # Fail closed: unknown errors look like auth failures to the caller.
    return AuthenticationError(f"Cognito error: {code}", details=details)


# ─────────────────────────────────────────────────────────────────────────────
# Public surface
#
# Each function takes plain Python args, raises domain exceptions, returns
# plain dicts. Routes never see ``ClientError`` or boto3 types.
# ─────────────────────────────────────────────────────────────────────────────


def sign_in(*, email: str, password: str) -> dict[str, Any]:
    """USER_PASSWORD_AUTH flow. Returns ID / access / refresh tokens."""
    _ensure_configured()
    settings = get_settings()
    client = get_cognito_client()
    try:
        resp = client.initiate_auth(
            ClientId=settings.cognito_client_id,  # type: ignore[arg-type]
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
    except ClientError as exc:
        log.warning(
            "auth.cognito.sign_in_failed",
            cognito_code=exc.response.get("Error", {}).get("Code"),
        )
        raise _translate(exc) from exc

    result = resp.get("AuthenticationResult")
    if not result:
        # MFA / NEW_PASSWORD_REQUIRED / SMS_MFA etc. — not handled in v1.
        challenge = resp.get("ChallengeName")
        log.info("auth.cognito.sign_in_challenge", challenge=challenge)
        raise AuthenticationError(
            "Authentication challenge required (not yet supported in v1)",
            code="challenge_required",
            details={"challenge": challenge},
        )

    return {
        "id_token": result.get("IdToken"),
        "access_token": result["AccessToken"],
        "refresh_token": result.get("RefreshToken"),
        # cognito-local omits ExpiresIn in some responses; real Cognito
        # always returns it. Default to the documented 1h TTL so callers
        # always get a number.
        "expires_in": int(result.get("ExpiresIn", 3600)),
        "token_type": result.get("TokenType", "Bearer"),
    }


def refresh_token(*, refresh: str) -> dict[str, Any]:
    """Exchange a refresh token for a fresh access + id token pair.

    Cognito does NOT return a new refresh token on a refresh; the client
    keeps using the same one until it expires.
    """
    _ensure_configured()
    settings = get_settings()
    client = get_cognito_client()
    try:
        resp = client.initiate_auth(
            ClientId=settings.cognito_client_id,  # type: ignore[arg-type]
            AuthFlow="REFRESH_TOKEN_AUTH",
            AuthParameters={"REFRESH_TOKEN": refresh},
        )
    except ClientError as exc:
        log.warning(
            "auth.cognito.refresh_failed",
            cognito_code=exc.response.get("Error", {}).get("Code"),
        )
        raise _translate(exc) from exc

    result = resp["AuthenticationResult"]
    return {
        "id_token": result.get("IdToken"),
        "access_token": result["AccessToken"],
        "refresh_token": None,  # see docstring
        "expires_in": int(result.get("ExpiresIn", 3600)),
        "token_type": result.get("TokenType", "Bearer"),
    }


def get_user(*, access_token: str) -> dict[str, Any]:
    """Return the canonical user attributes for the bearer of ``access_token``.

    Used by ``/auth/me`` because access tokens themselves don't carry
    custom attributes — only ID tokens do.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        resp = client.get_user(AccessToken=access_token)
    except ClientError as exc:
        raise _translate(exc) from exc

    attrs = {a["Name"]: a["Value"] for a in resp.get("UserAttributes", [])}
    return {"username": resp["Username"], "attributes": attrs}
