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
from app.auth.schemas import (
    LoginRequest,
    MeResponse,
    ReauthRequest,
    ReauthResponse,
    RefreshRequest,
    TokenResponse,
)
from app.core.exceptions import NotFoundError

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP for the audit row.

    Prefers ``X-Forwarded-For`` (the BFF sets this with the real browser
    IP) and falls back to the socket peer when running tests or direct.
    The header may contain a chain (``client, proxy1, proxy2``); the
    leftmost entry is the originator.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",", 1)[0].strip()
        if first:
            return first
    if request.client and request.client.host:
        return request.client.host
    return None


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Exchange email + password for tokens",
)
async def login(payload: LoginRequest) -> TokenResponse:
    result = cognito_client.sign_in(email=payload.email, password=payload.password)
    return TokenResponse(**result)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Exchange a refresh token for a new access token",
)
async def refresh(payload: RefreshRequest) -> TokenResponse:
    result = cognito_client.refresh_token(refresh=payload.refresh_token)
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
        signature_image_s3_key=payload.signature_image_s3_key,
    )
    return ReauthResponse(
        evidence_id=str(evt.id),
        action=evt.action,
        expires_at=evt.expires_at,
        signature_image_s3_key=evt.signature_image_s3_key,
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
