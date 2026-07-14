"""Pydantic schemas for the invitation API.

Reuses the shared ``Email`` normaliser (lowercases + validates at the edge so
invite dedup is case-insensitive) and the ``AssignableRole`` domain from the
users module (admin/operator/read_only only — super_admin is a fixed singleton).
Request models forbid unknown fields. Cognito emails the temporary password; the
create/resend responses surface it back only in local dev (where cognito-local
can't deliver mail), never in production.
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

    Cognito emails the invitee a temporary password. ``temporary_password`` is
    populated ONLY in local dev (cognito-local can't deliver mail, so the admin
    UI shows it for testing); it is always ``null`` in production.
    """

    id: str
    email: str
    first_name: str
    last_name: str
    role: str
    status: str
    expires_at: datetime
    # Dev-only convenience: the temp password Cognito would have emailed.
    temporary_password: str | None = None


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
