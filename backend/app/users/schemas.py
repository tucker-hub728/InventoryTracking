"""Pydantic schemas for the user-administration API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Mirrors the seeded ``app.roles`` codes.
RoleLiteral = Literal["super_admin", "admin", "operator", "read_only"]

# Roles that may be *assigned* via invite or edit. ``super_admin`` is a fixed
# singleton (seeded once) and is deliberately NOT assignable — you can neither
# invite nor promote anyone to it, and the last one can't be demoted.
AssignableRole = Literal["admin", "operator", "read_only"]


class UserRead(BaseModel):
    id: str
    email: str
    full_name: str
    initials: str
    role: str
    status: str
    is_active: bool
    created_at: datetime


class UserUpdate(BaseModel):
    """Edit a user's name, role, and/or active flag. All optional — only the
    supplied fields are changed."""

    model_config = ConfigDict(extra="forbid")

    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    # Only admin/editor/viewer are assignable — no promoting anyone to super_admin.
    role: AssignableRole | None = None
    is_active: bool | None = None
