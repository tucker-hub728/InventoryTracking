"""Pydantic schemas for the user-administration API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Mirrors the ``app.user_role`` enum / ``app.models.identity.ROLES``.
RoleLiteral = Literal["super_admin", "admin", "operator"]


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
    """Switch a user's role and/or active flag. Both optional."""

    model_config = ConfigDict(extra="forbid")

    role: RoleLiteral | None = None
    is_active: bool | None = None
