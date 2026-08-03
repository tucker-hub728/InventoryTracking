"""Pydantic schemas for the auth API.

Request models reject anything that doesn't validate at the edge (length,
shape, type). Response models declare exactly what we expose — never use a
raw dict on a route signature.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

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


class NewPasswordChallengeResponse(BaseModel):
    """Returned from ``/auth/login`` when an invited user signs in with their
    temporary password. The BFF stashes ``session`` and sends the user to the
    set-password step, which calls ``/auth/set-password`` to complete it.

    ``session`` is a short-lived Cognito challenge continuation token — NOT an
    access token. It only survives a few minutes and is single-use.
    """

    challenge: str = "NEW_PASSWORD_REQUIRED"
    session: str
    email: str


class SetPasswordRequest(BaseModel):
    """Complete the first-login ``NEW_PASSWORD_REQUIRED`` challenge.

    ``session`` comes from the login response; ``password`` is the invitee's
    chosen password. On success the account is confirmed and a session minted.
    """

    model_config = ConfigDict(extra="forbid")

    email: Email
    session: str = Field(min_length=1)
    password: str = Field(min_length=1, max_length=256)


class ForgotPasswordRequest(BaseModel):
    """Start a self-service password reset. Public — the user is locked out."""

    model_config = ConfigDict(extra="forbid")

    email: Email


class ForgotPasswordResponse(BaseModel):
    """Deliberately uninformative.

    Always the same shape whether or not the address belongs to a real, active
    account, so this endpoint can't be used to enumerate who has one. The
    ``destination`` Cognito reports is NOT echoed back for the same reason.
    """

    message: str = (
        "If that address belongs to an account, a reset code is on its way. "
        "The code expires shortly."
    )


class ResetPasswordRequest(BaseModel):
    """Finish a reset with the emailed code and a new password."""

    model_config = ConfigDict(extra="forbid")

    email: Email
    # Cognito's confirmation codes are 6 digits; keep the bound loose enough
    # that a format change upstream doesn't turn into a spurious 422 here.
    code: str = Field(min_length=4, max_length=32)
    password: str = Field(min_length=1, max_length=256)


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
    # replayed to satisfy ``supplier.update``.
    action: str = Field(min_length=3, max_length=64, pattern=r"^[a-z][a-z0-9_.-]+$")
    password: str = Field(min_length=1, max_length=128)
    # The record being signed for — "Lot A-100", not "some lot" (VR-006).
    # Asserted at consumption, so a ticket minted while looking at one record
    # cannot be spent on another inside its 120-second life.
    #
    # Optional because three flows create a record that does not exist yet
    # (tier, prefix, BOM line); those bind to the action alone. Supplying one
    # is strictly stronger, and both fields must travel together.
    record_table: str | None = Field(default=None, max_length=128)
    record_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _subject_is_all_or_nothing(self) -> ReauthRequest:
        """Half a subject would bind nothing while looking like it did."""
        if (self.record_table is None) != (self.record_id is None):
            raise ValueError(
                "record_table and record_id must be supplied together"
            )
        return self
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
    # NOTE: no ``signature_image_s3_key``. The hand-drawn canvas image was
    # removed on 2026-08-03 (client decision). The signature manifestation
    # is the re-authenticated identity + timestamp + ``meaning`` on the
    # audit row — which is what 21 CFR Part 11 §11.50 actually asks for.
    # ``extra="forbid"`` on this model means an old client still sending
    # the field now gets a clear 422 instead of having it silently dropped.


class ReauthResponse(BaseModel):
    """Successful reauth — frontend stashes ``evidence_id`` for the next write."""

    evidence_id: str
    action: str
    expires_at: datetime
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
