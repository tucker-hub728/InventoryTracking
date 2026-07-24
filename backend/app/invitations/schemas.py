"""Pydantic schemas for the invitation API.

Reuses the shared ``Email`` normaliser (lowercases + validates at the edge so
invite dedup is case-insensitive) and the ``AssignableRole`` domain from the
users module (admin/operator/read_only only — super_admin is a fixed singleton).
Request models forbid unknown fields. Cognito generates and emails the temporary
password (via SES in prod); the backend never sees, returns, or logs it, so no
credential appears in any API response.
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

    Carries no credential: Cognito emails the invitee their temporary password
    directly, so the response never exposes it in any environment.
    """

    id: str
    email: str
    first_name: str
    last_name: str
    role: str
    status: str
    expires_at: datetime


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
