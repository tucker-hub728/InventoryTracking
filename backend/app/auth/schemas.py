"""Pydantic schemas for the auth API.

Request models reject anything that doesn't validate at the edge (length,
shape, type). Response models declare exactly what we expose — never use a
raw dict on a route signature.
"""

from __future__ import annotations

import re
from datetime import datetime
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


def _trim_non_blank(v: str) -> str:
    """Strip surrounding whitespace and reject an all-blank value."""
    if not isinstance(v, str):
        raise ValueError("must be a string")
    v = v.strip()
    if not v:
        raise ValueError("must not be blank")
    return v


# Required free-text rationale on an e-signature. Trimmed; non-blank;
# capped to mirror the ``meaning`` column width.
Comment = Annotated[str, BeforeValidator(_trim_non_blank), Field(max_length=512)]


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


class ReauthRequest(BaseModel):
    """Payload for ``POST /v1/auth/reauth``.

    The caller asserts an ``action`` (the kind of write they're about to
    perform) and supplies their password to prove it's really them. The
    backend verifies via Cognito and returns an evidence ID the write
    endpoint will accept for the next ~2 minutes.
    """

    model_config = ConfigDict(extra="forbid")

    # Free-text action verb (e.g. ``movement.receipt``). The endpoint
    # consuming the evidence checks ``action`` matches its own expected
    # value — so a ticket minted for ``movement.receipt`` cannot be
    # replayed to satisfy ``vendor.update``.
    action: str = Field(min_length=3, max_length=64, pattern=r"^[a-z][a-z0-9_.-]+$")
    password: str = Field(min_length=1, max_length=128)
    # Optional attestation. The frontend dialog renders this verbatim
    # ("I attest the dispense quantity is accurate") so the audit row
    # carries the same text the user saw.
    meaning: str | None = Field(default=None, max_length=512)
    # Optional free-text rationale (the *why* recorded alongside the *who*).
    # The mandatory-comment rule was relaxed 2026-06-29 (client request) — the
    # e-signature's identity + timestamp + attestation (``meaning``) remain the
    # Part 11 manifestation; the reason is now optional. A few domain endpoints
    # may still require their own reason (enforced there / in the dialog).
    comment: str | None = Field(default=None, max_length=512)
    # Optional S3 key returned by ``POST /v1/uploads/signature`` —
    # the canvas image the operator drew. Stored on the audit row
    # alongside the textual evidence; never returned by the reauth
    # response itself (the audit viewer fetches it on demand).
    signature_image_s3_key: str | None = Field(default=None, max_length=512)


class ReauthResponse(BaseModel):
    """Successful reauth — frontend stashes ``evidence_id`` for the next write."""

    evidence_id: str
    action: str
    expires_at: datetime
    # Echoed so the frontend can confirm the image landed on the row.
    signature_image_s3_key: str | None = None
    # Echoed so the caller can also thread the rationale into the domain
    # record's notes/reason (e.g. the movement ledger), keeping the audit
    # log and the per-domain view in sync.
    comment: str | None = None


class MeResponse(BaseModel):
    """Identity surface for the authenticated user.

    Tokens come from Cognito; *attributes* come from the local
    ``app.users`` row (the source of truth post-provisioning). On the
    first /me after admin-creating a user in Cognito, the row is lazy-
    inserted from the Cognito attributes — see ``app.auth.provisioning``.
    """

    # Local DB id — the FK target for inventory / ledger / audit rows.
    id: str
    # Cognito immutable user id. Kept on the response so the frontend
    # can correlate against Cognito-side tools if needed.
    sub: str
    # Email-aliased Cognito Username. The "email" field below is the
    # display value; ``username`` is the system identifier.
    username: str
    email: str
    full_name: str
    initials: str
    role: str
    status: str
