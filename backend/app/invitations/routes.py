"""``/v1/invitations`` routes — admin invite management.

Authorisation (v1): only ``super_admin`` may create / revoke / resend invites
(``users:create`` — a permission no other role holds). ``super_admin`` and
``admin`` may list them (``users:view``).

Onboarding is completed by the invitee via ``/v1/auth/login`` (temp password)
→ ``/v1/auth/set-password`` (NEW_PASSWORD_REQUIRED challenge). Cognito emails the
temporary password, so there is no public invite endpoint here.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import CurrentDbUserDep, DBSession
from app.invitations import service
from app.invitations.schemas import (
    InvitationRead,
    InviteCreateRequest,
    InviteResult,
)
from app.models.invitations import Invitation
from app.security.permissions import RequirePermission

router = APIRouter(prefix="/invitations", tags=["invitations"])

StatusFilter = Literal["pending", "accepted", "revoked", "expired"]


def _to_result(invite: Invitation) -> InviteResult:
    return InviteResult(
        id=str(invite.id),
        email=invite.email,
        first_name=invite.first_name,
        last_name=invite.last_name,
        role=invite.role,
        status=service.effective_status(invite),
        expires_at=invite.expires_at,
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
    invite = await service.create_invitation(
        db,
        actor=actor,
        email=payload.email,
        first_name=payload.first_name,
        last_name=payload.last_name,
        role=payload.role,
    )
    return _to_result(invite)


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


@router.post(
    "/{invitation_id}/revoke",
    status_code=204,
    summary="Revoke a pending invitation (hard-deletes the identity)",
    dependencies=[Depends(RequirePermission("users", "create"))],
)
async def revoke_invitation(
    db: DBSession,
    invitation_id: Annotated[uuid.UUID, Path()],
) -> None:
    """Deletes the reserved Cognito identity and the invitation row entirely,
    freeing the email to be re-invited."""
    await service.revoke_invitation(db, invitation_id=invitation_id)


@router.post(
    "/{invitation_id}/resend",
    response_model=InviteResult,
    summary="Resend an invitation with a fresh temporary password",
    dependencies=[Depends(RequirePermission("users", "create"))],
)
async def resend_invitation(
    db: DBSession,
    invitation_id: Annotated[uuid.UUID, Path()],
) -> InviteResult:
    invite = await service.resend_invitation(db, invitation_id=invitation_id)
    return _to_result(invite)
