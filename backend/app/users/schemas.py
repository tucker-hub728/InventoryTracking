"""Pydantic schemas for the user-administration API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.auth.schemas import Email

# Mirrors the seeded ``app.roles`` codes.
RoleLiteral = Literal["super_admin", "admin", "operator", "read_only"]

# Roles that may be assigned **at invite time**. ``super_admin`` is deliberately
# absent: it is never selectable when inviting somebody (REQ-2026-07-31-ROL-005).
# Imported by ``app.invitations.schemas`` — keep it invite-shaped.
AssignableRole = Literal["admin", "operator", "read_only"]

# Roles that may be assigned **by editing an existing user**. This one DOES
# include ``super_admin``: per REQ-2026-07-31-ROL-005 the only way to become a
# Super Admin is promotion of an already-active user by an existing Super Admin.
# (This reverses the earlier "fixed singleton, never grantable" reading of
# REQ-2026-07-09-ROL-002, which left the system unable to ever create a second
# Super Admin.) The actor check and the eligibility gate live in the route.
GrantableRole = Literal["super_admin", "admin", "operator", "read_only"]


class UserRead(BaseModel):
    id: str
    email: str
    full_name: str
    initials: str
    role: str
    status: str
    is_active: bool
    created_at: datetime
    # Promotion eligibility (REQ-2026-07-31-ROL-005). Computed server-side so the
    # "accepted their invite and logged in" rule lives in exactly one place; the
    # UI uses these to enable/disable the Super Admin option and say why.
    can_be_promoted: bool = True
    promotion_blocked_reason: str | None = None
    # The permanent seeded super admin: role, email and active flag are locked.
    # Surfaced so the UI disables those fields instead of failing on submit.
    is_seed: bool = False


# Action verb the e-signature must carry. Checked against the reauth event when
# the evidence is consumed, so a signature minted for another flow can't be
# replayed here.
USER_UPDATE_ACTION = "user.update"


class UserUpdate(BaseModel):
    """Edit a user's email, name, role, and/or active flag. All optional — only
    the supplied fields are changed.

    **Every** edit requires an electronic signature. Role and email decide what
    a person may do and how they authenticate; the active flag decides whether
    they can work at all; and the display name is what every audit row and
    signature is attributed to. None of those should move without an
    attributable signature in a Part 11 system.
    """

    model_config = ConfigDict(extra="forbid")

    # Required whenever the patch changes anything. The route rejects a
    # mutating request without it.
    evidence_id: str | None = Field(
        default=None, min_length=1, description="Fresh reauth evidence id"
    )
    reason: str = Field(
        default="",
        max_length=512,
        description="Optional reason, recorded on the audit row",
    )

    # Changing this moves the Cognito sign-in alias too — the user signs in with
    # the new address afterwards. Super-admin-only, like every other member edit.
    email: Email | None = None
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    # ``super_admin`` is accepted here (promotion path) but guarded in the route:
    # only an existing Super Admin may grant it, and only to an active user who
    # has accepted their invite and logged in at least once.
    role: GrantableRole | None = None
    is_active: bool | None = None
