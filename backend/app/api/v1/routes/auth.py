"""``/v1/auth/*`` routes.

Thin handlers — input validation lives in the Pydantic models, Cognito
interaction lives in :mod:`app.auth.cognito_client`, JWT verification in
:mod:`app.auth.jwt_verifier`, and the local ``app.users`` write path in
:mod:`app.auth.provisioning` + :mod:`app.auth.repository`. This file
just composes them.

There is no public self-signup endpoint — this is an internal platform.
Users are created by admins via Cognito's ``admin-create-user`` (see
``scripts/seed_super_admins.py``) and the matching ``app.users`` row is
either written there or lazy-upserted on the new user's first ``/auth/me``
(:mod:`app.auth.provisioning`).
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DBSession
from app.auth import cognito_client, provisioning
from app.auth.dependencies import CurrentUserDep
from app.auth.schemas import (
    LoginRequest,
    MeResponse,
    RefreshRequest,
    TokenResponse,
)
from app.core.exceptions import NotFoundError

router = APIRouter(prefix="/auth", tags=["auth"])


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

    return MeResponse(
        id=str(user.id),
        sub=user.cognito_sub,
        username=fresh["username"],
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        role=user.role,
        is_active=user.is_active,
    )
