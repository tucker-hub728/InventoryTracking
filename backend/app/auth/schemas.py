"""Pydantic schemas for the auth API.

Request models reject anything that doesn't validate at the edge (length,
shape, type). Response models declare exactly what we expose — never use a
raw dict on a route signature.
"""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

# Loose email format check. We deliberately don't use ``pydantic.EmailStr``
# because it rejects reserved-use TLDs like ``.local`` and ``.test`` (per
# RFC 6761), which are exactly the kinds of addresses we want to accept in
# dev / staging / e2e tests. Cognito itself validates format properly on
# its side, so the worst case of accepting a weird-looking address here is
# a 4xx from Cognito on login — which surfaces as a normal validation
# error anyway.
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")


def _normalise_email(v: str) -> str:
    v = v.strip().lower()
    if not _EMAIL_RE.match(v):
        raise ValueError("not a valid email address")
    return v


Email = Annotated[str, BeforeValidator(_normalise_email)]


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: Email
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refresh_token: str = Field(min_length=1)


class TokenResponse(BaseModel):
    """Token payload the frontend stores after login / refresh."""

    id_token: str | None = None
    access_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str = "Bearer"


class MeResponse(BaseModel):
    """Identity surface for the authenticated user.

    Tokens come from Cognito; *attributes* come from the local
    ``app.users`` row (the source of truth post-provisioning). On the
    first /me after admin-creating a user in Cognito, the row is lazy-
    inserted from the Cognito attributes — see ``app.auth.provisioning``.
    """

    # Local DB id — the FK target for inventory / transaction rows.
    id: str
    # Cognito immutable user id. Kept on the response so the frontend
    # can correlate against Cognito-side tools if needed.
    sub: str
    # Email-aliased Cognito Username. The "email" field below is the
    # display value; ``username`` is the system identifier.
    username: str
    email: str
    first_name: str
    last_name: str
    role: str
    is_active: bool
