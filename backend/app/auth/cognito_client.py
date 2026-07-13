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
    IntegrationError,
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


# ─────────────────────────────────────────────────────────────────────────────
# Admin surface
#
# These call Cognito's ``admin_*`` APIs (require AWS admin credentials, or
# cognito-local in dev). They back the user-invite flow: an admin reserves a
# Cognito identity at invite time (in FORCE_CHANGE_PASSWORD) and the invitee
# sets a real password at accept time. Same contract as the request-serving fns
# above — keyword args, domain exceptions, plain dicts, no boto3 types leaked.
#
# Email delivery is environment-gated (see ``admin_create_user``): in production
# Cognito sends its own invitation email (its built-in email, no SES); in local
# dev the message is SUPPRESSED and the app emails the temporary password to
# maildev over SMTP. The accept flow (temp password → new password) is identical
# in both environments, so promoting to prod needs no code change.
# ─────────────────────────────────────────────────────────────────────────────


def _pool_id() -> str:
    settings = get_settings()
    # ``_ensure_configured`` already verified this is set; assert for the type
    # checker and to fail loudly if the invariant is ever broken.
    pool_id = settings.cognito_user_pool_id
    assert pool_id is not None
    return pool_id


def _extract_sub(attributes: list[Any]) -> str:
    for a in attributes:
        if a.get("Name") == "sub":
            return str(a["Value"])
    # Every Cognito user has a ``sub``; its absence means an unexpected shape.
    raise IntegrationError("Cognito returned no 'sub' for the user")


def admin_create_user(*, email: str, name: str, role: str) -> str:
    """Reserve a Cognito identity for an invitee and return its ``sub``.

    The account lands in ``FORCE_CHANGE_PASSWORD`` with NO password set, so it
    is unusable until the invitee sets a real password at accept time (proven by
    the single-use invite token, not a Cognito temp password). Email is marked
    verified and ``custom:role`` seeds the role.

    Cognito's own invitation email is always SUPPRESSED — the app owns the invite
    email and delivers a single-use accept link (the token is the credential).

    Raises :class:`ConflictError` if the email already exists in the pool.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        resp = client.admin_create_user(
            UserPoolId=_pool_id(),
            Username=email,
            MessageAction="SUPPRESS",
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "name", "Value": name},
                {"Name": "custom:role", "Value": role},
            ],
        )
    except ClientError as exc:
        err = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
        code = str(err.get("Code", ""))
        msg = str(err.get("Message", ""))
        log.info("auth.cognito.admin_create_failed", cognito_code=code)
        # "Email already exists" must be a ConflictError so the invite flow can
        # recover the existing identity (idempotent re-invite). Real Cognito
        # reports the typed ``UsernameExistsException``; cognito-local puts an
        # HTTP status ("400") in the Code slot but keeps the human message, so
        # match on either signal (fail-closed _translate would mislabel it 401).
        if code in _CONFLICT or "already exists" in msg.lower():
            raise ConflictError(
                msg or "A user with this email already exists.",
                details={"cognito_code": code, "cognito_message": msg},
            ) from exc
        raise _translate(exc) from exc
    return _extract_sub(resp["User"]["Attributes"])


def admin_get_user(*, email: str) -> dict[str, Any] | None:
    """Return ``{sub, enabled, status, attributes}`` for ``email``, or None.

    A missing user (``UserNotFoundException``) returns None rather than
    raising, so callers can branch on existence without catching. Any other
    Cognito error still surfaces as a domain exception.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        resp = client.admin_get_user(UserPoolId=_pool_id(), Username=email)
    except ClientError as exc:
        translated = _translate(exc)
        if isinstance(translated, NotFoundError):
            return None
        raise translated from exc

    attrs = {a["Name"]: a["Value"] for a in resp.get("UserAttributes", [])}
    return {
        "sub": attrs.get("sub"),
        "enabled": resp.get("Enabled", True),
        "status": resp.get("UserStatus"),
        "attributes": attrs,
    }


def admin_set_user_password(*, email: str, password: str, permanent: bool = True) -> None:
    """Set (and by default make permanent) a user's password.

    Called at accept time with the invitee's chosen password. ``Permanent``
    confirms the account so ``USER_PASSWORD_AUTH`` works on first login with
    no ``NEW_PASSWORD_REQUIRED`` challenge. A password that fails the pool's
    policy surfaces as :class:`ValidationError`.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        client.admin_set_user_password(
            UserPoolId=_pool_id(),
            Username=email,
            Password=password,
            Permanent=permanent,
        )
    except ClientError as exc:
        err = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
        code = str(err.get("Code", ""))
        msg = str(err.get("Message", ""))
        # A password that fails the pool policy must surface as a 422 the user
        # can act on — not a fail-closed 401. Real Cognito reports the typed
        # ``InvalidPasswordException``; cognito-local puts an HTTP status
        # ("400") in the Code slot but keeps the human message, so match on
        # either signal.
        if code in ("InvalidPasswordException", "InvalidParameterException") or (
            "password" in msg.lower()
        ):
            raise ValidationError(
                "Password does not meet the security requirements "
                "(at least 12 characters with uppercase, lowercase, a number "
                "and a symbol).",
                code="invalid_password",
                details={"cognito_message": msg},
            ) from exc
        raise _translate(exc) from exc


def admin_set_user_enabled(*, email: str, enabled: bool) -> None:
    """Enable or disable a Cognito user (reversible revoke / reactivate).

    A missing user is treated as a no-op — the caller's DB state is the
    source of truth for the invite lifecycle.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        if enabled:
            client.admin_enable_user(UserPoolId=_pool_id(), Username=email)
        else:
            client.admin_disable_user(UserPoolId=_pool_id(), Username=email)
    except ClientError as exc:
        translated = _translate(exc)
        if isinstance(translated, NotFoundError):
            return
        raise translated from exc


def admin_delete_user(*, email: str) -> None:
    """Permanently delete a Cognito user. Used when an admin revokes a pending
    invitation — the reserved identity is destroyed so the email is free to be
    re-invited cleanly.

    A missing user is a no-op (idempotent): the desired end state — no such
    identity — already holds.
    """
    _ensure_configured()
    client = get_cognito_client()
    try:
        client.admin_delete_user(UserPoolId=_pool_id(), Username=email)
    except ClientError as exc:
        translated = _translate(exc)
        if isinstance(translated, NotFoundError):
            return
        raise translated from exc
