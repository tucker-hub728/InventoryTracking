"""``/v1/auth/*`` routes.

Thin handlers — input validation lives in the Pydantic models, Cognito
interaction lives in :mod:`app.auth.cognito_client`, JWT verification in
:mod:`app.auth.jwt_verifier`, and the local ``app.users`` write path in
:mod:`app.auth.provisioning` + :mod:`app.auth.repository`. This file
just composes them.

There is no public self-signup endpoint — this is an internal platform.
Users are created by admins via the admin user-management module (not
yet implemented), which calls Cognito's ``admin-create-user`` and writes
the matching ``app.users`` row. On the new user's first ``/auth/me``
after they set their password, :mod:`app.auth.provisioning` lazy-upserts
the local row from Cognito attributes (so the path works even if the
admin module hasn't written it yet — e.g. the bootstrap super admin from
``scripts/seed_cognito.sh``).
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.deps import CurrentDbUserDep, DBSession
from app.auth import cognito_client, provisioning, reauth
from app.auth import repository as users_repo
from app.auth.dependencies import CurrentUserDep
from app.auth.jwt_verifier import verify_token
from app.auth.schemas import (
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    MeResponse,
    NewPasswordChallengeResponse,
    ReauthRequest,
    ReauthResponse,
    RefreshRequest,
    ResetPasswordRequest,
    SetPasswordRequest,
    TokenResponse,
)
from app.core.config import get_settings
from app.core.exceptions import (
    AuthenticationError,
    AuthorizationError,
    DomainError,
    NotFoundError,
)
from app.core.logging import get_logger
from app.core.passwords import validate_password_strength
from app.core.rate_limit import (
    account_key,
    client_key,
    login_account_limiter,
    login_ip_limiter,
)
from app.invitations import service as invitations_service

router = APIRouter(prefix="/auth", tags=["auth"])

log = get_logger(__name__)

# Shown to a deactivated user on login and on any protected request. The code
# ``account_disabled`` is what the frontend keys off to end the session.
_DEACTIVATED_MESSAGE = "Your account has been deactivated. Please contact an administrator."

# The ONE answer every pre-authentication failure gives. Deliberately says
# nothing about which half was wrong, whether the address is registered, or
# whether the account is disabled — see the ``login`` docstring.
_INVALID_CREDENTIALS = "Incorrect email or password."


async def _reject_if_deactivated(db: DBSession, email: str) -> None:
    """Raise ``AuthorizationError('account_disabled')`` if a local user with
    ``email`` exists and is not active.

    This enforces deactivation at login in EVERY environment: real Cognito
    already blocks a disabled identity at ``sign_in`` (but with a generic error),
    and ``cognito-local`` doesn't enforce the disabled flag at all — so the
    local mirror's status is the authoritative gate, with a precise message.
    """
    user = await users_repo.get_by_email(db, email)
    if user is not None and user.status != "active":
        raise AuthorizationError(_DEACTIVATED_MESSAGE, code="account_disabled")


def _client_ip(request: Request) -> str | None:
    """Client IP for the Part 11 audit row.

    This value is written to ``audit.reauth_events.ip_address`` on an
    append-only, immutable row that exists to support non-repudiation, so
    it must come from a hop we actually trust.

    It used to take the LEFTMOST ``X-Forwarded-For`` entry unconditionally.
    XFF is appended to by each proxy, so the leftmost entry is whatever the
    *original caller* sent — a browser can put ``X-Forwarded-For:
    203.0.113.5`` on any fetch() and choose the IP recorded against its own
    signature. The audit row then attests to something the signer supplied.

    The trust boundary is now explicit:
      * ``settings.trusted_proxy_count`` — how many proxies sit in front of
        this app (BFF, ALB, CloudFront). 0 means "nothing in front", so XFF
        is not consulted at all.
      * With N trusted hops, only the Nth-from-the-right entry was written
        by a proxy we control; everything to its left is caller-supplied
        and is discarded.

    Returns None rather than guessing when the chain is too short to
    contain a trustworthy entry — a blank IP is a defensible audit record,
    a forged one is not.
    """
    hops = get_settings().trusted_proxy_count
    if hops > 0:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            chain = [p.strip() for p in xff.split(",") if p.strip()]
            # The rightmost entry was appended by the nearest proxy, so the
            # one contributed by the outermost trusted proxy is at -hops.
            if len(chain) >= hops:
                return chain[-hops]
            # Chain shorter than configured — misconfiguration, or someone
            # stripping hops. Don't fall back to a caller-controlled value.
            return None
    if request.client and request.client.host:
        return request.client.host
    return None


@router.post(
    "/login",
    response_model=TokenResponse | NewPasswordChallengeResponse,
    summary="Exchange email + password for tokens (or a set-password challenge)",
)
async def login(
    payload: LoginRequest, db: DBSession, request: Request
) -> TokenResponse | NewPasswordChallengeResponse:
    """Authenticate, with throttling and a uniform failure response.

    Two properties this endpoint has to hold, beyond "does the password
    match":

    **Every pre-auth failure looks identical.** It used to answer three
    different ways: an unknown address raised ``NotFoundError`` (404, from
    ``UserNotFoundException``, which this handler never caught), a known
    address with a wrong password gave 401, and a deactivated account gave
    403 ``account_disabled`` for ANY password. Those differences let anyone
    sort an email list into "real", "real but disabled" and "unknown"
    without ever authenticating — a ready-made target list for phishing or
    stuffing. All three now return the same 401.

    **A wrong answer costs budget.** Failures are charged against both the
    source IP and the account (see app/core/rate_limit.py) so neither a
    single host walking a password list nor a distributed run at one known
    address can proceed unthrottled.

    Consequence worth stating: a deactivated user who types their correct
    password now sees the generic message rather than "your account has
    been deactivated". Real Cognito rejects a disabled identity inside
    ``sign_in`` and gives us no way to tell that apart from a bad password,
    so the precise signal is only available once credentials are known
    good — which is exactly where it now lives (below, and on every
    protected route via ``resolve_db_user``).
    """
    ip_key = client_key(_client_ip(request))
    acct_key = account_key(payload.email)

    # Check before doing any work — a throttled caller shouldn't reach Cognito.
    login_ip_limiter.check(ip_key)
    login_account_limiter.check(acct_key)

    try:
        result = cognito_client.sign_in(email=payload.email, password=payload.password)
    except (AuthenticationError, NotFoundError) as exc:
        login_ip_limiter.record_failure(ip_key)
        login_account_limiter.record_failure(acct_key)
        log.info("auth.login.failed", reason=type(exc).__name__)
        raise AuthenticationError(
            _INVALID_CREDENTIALS, code="invalid_credentials"
        ) from exc

    # ── Credentials are good from here on ───────────────────────────────
    # Clear the budget so someone who fumbled twice and then succeeded is
    # not carrying failures into their next session.
    login_ip_limiter.reset(ip_key)
    login_account_limiter.reset(acct_key)

    # cognito-local doesn't enforce the disabled flag, so the local mirror is
    # the authoritative gate. Safe to be precise here: the caller has already
    # proved they hold the password, so this discloses nothing they couldn't
    # learn on their next request anyway.
    await _reject_if_deactivated(db, payload.email)

    if result.get("challenge") == cognito_client.NEW_PASSWORD_REQUIRED:
        # Invited user's first sign-in with the temporary password: hand the
        # challenge session back so the BFF can drive the set-password step.
        return NewPasswordChallengeResponse(**result)
    return TokenResponse(**result)


@router.post(
    "/set-password",
    response_model=TokenResponse,
    summary="Set a first-login password, completing the NEW_PASSWORD_REQUIRED challenge",
)
async def set_password(
    payload: SetPasswordRequest, db: DBSession, request: Request
) -> TokenResponse:
    """Public — the invitee has no session yet, only the challenge ``session``
    from ``/auth/login``. Sets the chosen password (completing the challenge),
    consumes the pending invitation, and returns a fresh token set for auto-login.

    The ``session`` token is the credential here; ``email`` is caller-supplied.
    The deactivation check therefore runs AFTER the challenge is accepted —
    running it first answered "is this address a disabled account?" to anyone
    who asked, with no credential at all.
    """
    ip_key = client_key(_client_ip(request))
    login_ip_limiter.check(ip_key)

    # Enforce the pool policy server-side first, so a weak password is rejected
    # with a precise 422 even where the backend doesn't enforce it (cognito-local).
    validate_password_strength(payload.password)

    try:
        result = cognito_client.respond_to_new_password_challenge(
            email=payload.email,
            session=payload.session,
            new_password=payload.password,
        )
    except (AuthenticationError, NotFoundError) as exc:
        login_ip_limiter.record_failure(ip_key)
        raise AuthenticationError(
            _INVALID_CREDENTIALS, code="invalid_credentials"
        ) from exc

    login_ip_limiter.reset(ip_key)

    # Challenge accepted — the caller holds a valid session token, so the
    # precise deactivation message is no longer a disclosure.
    await _reject_if_deactivated(db, payload.email)

    # Consume the matching pending invite (if any) — the user row itself is
    # lazy-materialised on the first /auth/me via provisioning.
    await invitations_service.mark_accepted_by_email(db, email=payload.email)
    return TokenResponse(**result)


@router.post(
    "/forgot-password",
    response_model=ForgotPasswordResponse,
    summary="Start a self-service password reset — Cognito emails a code",
)
async def forgot_password(
    payload: ForgotPasswordRequest, db: DBSession, request: Request
) -> ForgotPasswordResponse:
    """Public — the caller is locked out, so there's no session to require.

    **Always returns the same response.** An unknown address, a deactivated
    account, and a successful send are indistinguishable from the outside; the
    alternative hands anybody a free "does this person have an account here?"
    oracle. Real failures are logged server-side instead.

    Deactivated accounts are skipped deliberately: letting a suspended user reset
    their way back in would route around the deactivation guard on `/auth/login`.
    """
    # Each call makes Cognito send an email, so an unthrottled endpoint is a
    # free mail-bomb aimed at any address the caller names. Charged per
    # request rather than per failure — a "success" is the abusable outcome.
    ip_key = client_key(_client_ip(request))
    login_ip_limiter.check(ip_key)
    login_ip_limiter.record_failure(ip_key)

    user = await users_repo.get_by_email(db, payload.email)
    if user is not None and user.status != "active":
        log.info("auth.forgot_password.skipped_inactive", email=payload.email)
        return ForgotPasswordResponse()

    try:
        cognito_client.forgot_password(email=payload.email)
    except DomainError as exc:
        # Unknown user, throttling, un-verified address — none of it changes the
        # answer we give the caller.
        log.info(
            "auth.forgot_password.failed",
            email=payload.email,
            code=getattr(exc, "code", None),
        )
    return ForgotPasswordResponse()


@router.post(
    "/reset-password",
    response_model=ForgotPasswordResponse,
    summary="Finish a password reset with the emailed code",
)
async def reset_password(
    payload: ResetPasswordRequest, db: DBSession, request: Request
) -> ForgotPasswordResponse:
    """Public — completes what ``/auth/forgot-password`` started.

    Unlike that endpoint this one reports real errors: the caller already holds a
    code, so a wrong-code or weak-password message tells them nothing they
    couldn't learn by trying again, and staying silent would leave them stuck.

    Throttled because the emailed code is short and therefore guessable given
    enough attempts — this is the one place where a brute-force gets a
    password change rather than a session.
    """
    ip_key = client_key(_client_ip(request))
    acct_key = account_key(payload.email)
    login_ip_limiter.check(ip_key)
    login_account_limiter.check(acct_key)
    # Charged up-front: an attacker guessing codes must not get free attempts
    # just because the endpoint raises before any explicit failure handling.
    login_ip_limiter.record_failure(ip_key)
    login_account_limiter.record_failure(acct_key)

    # A deactivated account must not be able to reset into a working login.
    await _reject_if_deactivated(db, payload.email)
    # Enforce the policy here too, so a weak password fails with a precise 422
    # even on cognito-local, which doesn't apply the pool policy.
    validate_password_strength(payload.password)

    cognito_client.confirm_forgot_password(
        email=payload.email,
        code=payload.code,
        new_password=payload.password,
    )
    log.info("auth.reset_password.succeeded", email=payload.email)
    return ForgotPasswordResponse(message="Your password has been reset. You can sign in now.")


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Exchange a refresh token for a new access token",
)
async def refresh(
    payload: RefreshRequest, db: DBSession, request: Request
) -> TokenResponse:
    """Mint a fresh access token, but only for an account still in good standing.

    Every other credential-bearing route (`login`, `set_password`, `me`)
    consults the local mirror before handing anything back; refresh did not,
    so a user deactivated mid-session could keep minting access tokens for
    the life of their refresh token. The blast radius was limited —
    ``resolve_db_user`` still blocks them on protected routes, and real
    Cognito rejects a disabled identity outright — but the session should
    die at the source, and cognito-local doesn't enforce the disabled flag
    at all, so dev/test behaved differently from prod.
    """
    # A refresh token is a credential, so guessing at it gets throttled the
    # same as guessing at a password.
    ip_key = client_key(_client_ip(request))
    login_ip_limiter.check(ip_key)

    try:
        result = cognito_client.refresh_token(refresh=payload.refresh_token)
    except (AuthenticationError, NotFoundError) as exc:
        login_ip_limiter.record_failure(ip_key)
        raise AuthenticationError(
            _INVALID_CREDENTIALS, code="invalid_credentials"
        ) from exc

    # Identify the holder from the freshly-minted access token rather than
    # trusting anything in the request. If the token can't be verified,
    # something is wrong enough that we shouldn't return it.
    try:
        claims = verify_token(result["access_token"], token_use="access")  # noqa: S106 - JWT claim name, not a credential
    except Exception as exc:  # any verification failure is fatal here
        log.warning("auth.refresh.token_unverifiable", error=type(exc).__name__)
        raise AuthenticationError(
            "Could not refresh the session.", code="refresh_failed"
        ) from exc

    sub = claims.get("sub")
    if sub:
        user = await users_repo.get_by_cognito_sub(db, sub)
        if user is not None and user.status != "active":
            log.info("auth.refresh.rejected_deactivated", cognito_sub=sub)
            raise AuthorizationError(_DEACTIVATED_MESSAGE, code="account_disabled")

    return TokenResponse(**result)


@router.post(
    "/reauth",
    response_model=ReauthResponse,
    summary="Re-verify the current user's password and mint an evidence id",
)
async def reauth_endpoint(
    request: Request,
    payload: ReauthRequest,
    current: CurrentUserDep,
    db_user: CurrentDbUserDep,
    db: DBSession,
) -> ReauthResponse:
    """Used as the second factor before any GxP-significant write.

    Requires a valid bearer token (so the BFF cookie session is alive)
    AND the user's password (so the person at the keyboard is really the
    cookie owner). Every attempt — successful or not — is recorded in
    ``audit.reauth_events``. Failures count toward a per-user rate limit
    that locks further attempts for 5 minutes.
    """
    evt = await reauth.verify_password_and_issue_evidence(
        db,
        user_id=db_user.id,
        cognito_username=current.username,
        password=payload.password,
        action=payload.action,
        meaning=payload.meaning,
        comment=payload.comment,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    return ReauthResponse(
        evidence_id=str(evt.id),
        action=evt.action,
        expires_at=evt.expires_at,
        comment=evt.comment,
    )


@router.get(
    "/me",
    response_model=MeResponse,
    summary="Current authenticated user",
)
async def me(current: CurrentUserDep, db: DBSession) -> MeResponse:
    # We need fresh Cognito attributes for two reasons:
    #   1. Access tokens don't carry custom attrs (only ID tokens do).
    #   2. On *first* login for an admin-created user, the local row
    #      doesn't exist yet — we seed it from these attrs.
    fresh = cognito_client.get_user(access_token=current.access_token)
    attrs = fresh["attributes"]

    user = await provisioning.provision_from_me(
        db,
        cognito_sub=current.sub,
        cognito_attrs=attrs,
        username=fresh["username"],
    )
    if user is None:  # pragma: no cover — provision_from_me always returns
        raise NotFoundError("User record not found")

    # A deactivated user must not keep a live session, even on the identity
    # endpoint — mirrors the guard on every other protected route.
    if user.status != "active":
        raise AuthorizationError(_DEACTIVATED_MESSAGE, code="account_disabled")

    # Cheap "last seen" stamp. Outside the provisioning path so we don't
    # bump it during the initial insert (which already sets created_at).
    await users_repo.touch_last_active(db, user.id)

    return MeResponse(
        id=str(user.id),
        sub=user.cognito_sub,
        username=fresh["username"],
        email=user.email,
        full_name=user.full_name,
        initials=user.initials,
        role=user.role,
        status=user.status,
    )
