"""``/v1/invitations`` routes — admin invite management + public link resolve.

Authorisation (v1): only ``super_admin`` may create / revoke / resend invites
(``users:create`` — a permission no other role holds). ``super_admin`` and
``admin`` may list them (``users:view``). The token-resolve endpoint is PUBLIC
(the invitee has no session yet) and returns only non-sensitive fields with a
generic error for any bad token, so it can't enumerate invited emails.

The accept endpoint itself lives under ``/v1/auth/accept-invite`` (it mints a
session, mirroring ``/auth/login``).
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import CurrentDbUserDep, DBSession
from app.core.config import get_settings
from app.invitations import service
from app.invitations.schemas import (
    InvitationRead,
    InviteCreateRequest,
    InvitePublicView,
    InviteResolveRequest,
    InviteResult,
)
from app.models.invitations import Invitation
from app.security.permissions import RequirePermission

router = APIRouter(prefix="/invitations", tags=["invitations"])

StatusFilter = Literal["pending", "accepted", "revoked", "expired"]


def _to_result(invite: Invitation, raw_token: str) -> InviteResult:
    settings = get_settings()
    return InviteResult(
        id=str(invite.id),
        email=invite.email,
        first_name=invite.first_name,
        last_name=invite.last_name,
        role=invite.role,
        status=service.effective_status(invite),
        expires_at=invite.expires_at,
        token=raw_token,
        accept_path=settings.accept_invite_path(raw_token),
        accept_url=settings.accept_invite_url(raw_token),
    )


def _to_read(invite: Invitation) -> InvitationRead:
    return InvitationRead(
        id=str(invite.id),
        email=invite.email,
        first_name=invite.first_name,
        last_name=invite.last_name,
        role=invite.role,
        status=service.effective_status(invite),
        invited_by=str(invite.invited_by),
        expires_at=invite.expires_at,
        accepted_at=invite.accepted_at,
        created_at=invite.created_at,
    )


@router.post(
    "",
    response_model=InviteResult,
    summary="Invite a new user",
    dependencies=[Depends(RequirePermission("users", "create"))],
)
async def create_invitation(
    db: DBSession,
    actor: CurrentDbUserDep,
    payload: InviteCreateRequest,
) -> InviteResult:
    invite, raw_token = await service.create_invitation(
        db,
        actor=actor,
        email=payload.email,
        first_name=payload.first_name,
        last_name=payload.last_name,
        role=payload.role,
    )
    return _to_result(invite, raw_token)


@router.get(
    "",
    response_model=list[InvitationRead],
    summary="List invitations",
    dependencies=[Depends(RequirePermission("users", "view"))],
)
async def list_invitations(
    db: DBSession,
    status: Annotated[StatusFilter | None, Query()] = None,
) -> list[InvitationRead]:
    invites = await service.list_invitations(db, status=status)
    return [_to_read(i) for i in invites]


# POST (not GET /token/{token}) so the raw single-use token travels in the body
# and never lands in access logs / browser history / Referer headers. It's
# read-only despite the verb — a lookup keyed by a secret.
@router.post(
    "/resolve",
    response_model=InvitePublicView,
    summary="Resolve an invite link (public)",
)
async def resolve_invitation(
    db: DBSession,
    payload: InviteResolveRequest,
) -> InvitePublicView:
    invite = await service.resolve_invitation(db, payload.token)
    return InvitePublicView(
        email=invite.email,
        first_name=invite.first_name,
        last_name=invite.last_name,
        role=invite.role,
        expires_at=invite.expires_at,
    )


@router.post(
    "/{invitation_id}/revoke",
    response_model=InvitationRead,
    summary="Revoke a pending invitation",
    dependencies=[Depends(RequirePermission("users", "create"))],
)
async def revoke_invitation(
    db: DBSession,
    invitation_id: Annotated[uuid.UUID, Path()],
) -> InvitationRead:
    invite = await service.revoke_invitation(db, invitation_id=invitation_id)
    return _to_read(invite)


@router.post(
    "/{invitation_id}/resend",
    response_model=InviteResult,
    summary="Resend an invitation with a fresh link",
    dependencies=[Depends(RequirePermission("users", "create"))],
)
async def resend_invitation(
    db: DBSession,
    invitation_id: Annotated[uuid.UUID, Path()],
) -> InviteResult:
    invite, raw_token = await service.resend_invitation(db, invitation_id=invitation_id)
    return _to_result(invite, raw_token)
