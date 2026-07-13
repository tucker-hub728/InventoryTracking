"""Pydantic schemas for the invitation API.

Reuses the shared ``Email`` normaliser (lowercases + validates at the edge so
invite dedup is case-insensitive) and the ``AssignableRole`` domain from the
users module (admin/editor/viewer only — super_admin is a fixed singleton).
Request models forbid unknown fields; the raw link token is only ever returned
on the create/resend responses, never persisted or listed.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.auth.schemas import Email
from app.users.schemas import AssignableRole


class InviteCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    # super_admin is a fixed singleton — you can only invite admin/editor/viewer.
    role: AssignableRole


class InviteResult(BaseModel):
    """Returned to the admin on create/resend.

    ``token`` and ``accept_url`` are shown once so the admin can copy the link
    (the invitee also receives it by email). ``accept_url`` is null when no
    ``FRONTEND_BASE_URL`` is configured — the frontend then composes an absolute
    URL from ``accept_path`` + its origin.
    """

    id: str
    email: str
    first_name: str
    last_name: str
    role: str
    status: str
    expires_at: datetime
    # The raw single-use link token (only surfaced here; stored as a hash).
    token: str
    accept_path: str
    accept_url: str | None = None


class InvitePublicView(BaseModel):
    """Non-sensitive invite details for the public accept page."""

    email: str
    first_name: str
    last_name: str
    role: str
    expires_at: datetime


class InviteResolveRequest(BaseModel):
    """Body for the public resolve endpoint.

    The token travels in the POST body (not the URL path) so the raw
    single-use credential never lands in access logs / Referer headers.
    """

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=512)


class AcceptInviteRequest(BaseModel):
    """Complete an invitation. The single-use ``token`` from the accept link is
    the credential; ``password`` is the one the invitee chooses. On success the
    account is confirmed and a session is minted."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=1, max_length=256)


class InvitationRead(BaseModel):
    """Admin directory view of an invitation."""

    id: str
    email: str
    first_name: str
    last_name: str
    role: str
    status: str
    invited_by: str
    expires_at: datetime
    accepted_at: datetime | None = None
    created_at: datetime
