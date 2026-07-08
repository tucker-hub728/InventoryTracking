"""Pydantic schemas for the user-administration API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Mirrors the ``app.user_role`` enum / ``app.models.identity.ROLES``.
RoleLiteral = Literal["super_admin", "admin", "operator"]

# Roles that may be *assigned* via invite or edit. ``super_admin`` is a fixed
# singleton (seeded once) and is deliberately NOT assignable — you can neither
# invite nor promote anyone to it, and the last one can't be demoted.
AssignableRole = Literal["admin", "operator"]


class UserRead(BaseModel):
    id: str
    email: str
    full_name: str | None = None
    first_name: str
    last_name: str
    role: str
    is_active: bool
    created_at: datetime


class UserUpdate(BaseModel):
    """Edit a user's name, role, and/or active flag. All optional — only the
    supplied fields are changed."""

    model_config = ConfigDict(extra="forbid")

    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    # Only admin/operator are assignable — no promoting anyone to super_admin.
    role: AssignableRole | None = None
    is_active: bool | None = None
