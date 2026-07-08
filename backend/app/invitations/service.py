"""Invitation orchestration — the edge-case-heavy core of the invite flow.

This module coordinates Cognito (via the sanctioned facade) and the local
``app.invitations`` + ``app.users`` tables. It is the ONLY place that knows
the invite lifecycle rules:

  * create   — reserve a Cognito identity (locked) + persist a hashed token
  * resolve  — validate a link for the public accept page (no mutation)
  * accept   — set the chosen password, materialise the user, consume the invite
  * revoke   — cancel a pending invite (disable the reserved Cognito identity)
  * resend   — mint a fresh token + expiry, invalidating the previous link

Consistency stance: external Cognito calls happen before the DB write is
committed, and every step is idempotent on retry (``admin_get_user`` recovers a
pre-existing identity, ``admin_set_user_password`` is repeatable), so a partial
failure never strands an invitee. Only the SHA-256 hash of a link token is
persisted; the raw token is returned to the admin exactly once.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import cognito_client
from app.auth import repository as users_repo
from app.core.config import get_settings
from app.core.exceptions import (
    AuthorizationError,
    ConflictError,
    IntegrationError,
    NotFoundError,
    ValidationError,
)
from app.core.logging import get_logger
from app.invitations import repository as invitations_repo
from app.models.identity import User
from app.models.invitations import Invitation

log = get_logger(__name__)


# ── Token helpers ───────────────────────────────────────────────────────────
# 256 bits of entropy, URL-safe. We store only the hash; the raw token is the
# credential and must never be logged or persisted.


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _is_expired(invite: Invitation) -> bool:
    return invite.expires_at <= _now()


def _display_name(first_name: str, last_name: str) -> str:
    return f"{first_name} {last_name}".strip()


def _assert_can_grant(actor: User, role: str) -> None:
    """Who-can-invite-whom guard. v1: only ``super_admin`` may invite, and may
    grant any role. ``RequirePermission('users','create')`` already gates the
    route to super_admin; this is defence in depth against a future matrix
    change that grants ``users:create`` more widely without revisiting this.
    """
    if actor.role == "super_admin":
        return
    raise AuthorizationError(
        "Only a super admin may send invitations.",
        code="permission_denied",
        details={"actor_role": actor.role, "target_role": role},
    )


# ── Create ──────────────────────────────────────────────────────────────────


async def create_invitation(
    session: AsyncSession,
    *,
    actor: User,
    email: str,
    first_name: str,
    last_name: str,
    role: str,
) -> tuple[Invitation, str]:
    """Invite a new user. Returns ``(invitation, raw_token)``.

    Edge cases handled: existing active member (409), an existing *pending*
    invite (409 — resend/revoke instead), a stale expired pending invite
    (lazily expired to free the unique slot), and an email that already has a
    Cognito identity from a prior invite/seed (recovered + re-enabled).
    """
    _assert_can_grant(actor, role)

    # 1. Refuse if an ACTIVE local member already owns this email. A
    #    deactivated member is allowed through — accept will reactivate them.
    existing_user = await users_repo.get_by_email(session, email)
    if existing_user is not None and existing_user.is_active:
        raise ConflictError(
            "A user with this email already exists.",
            code="user_exists",
        )

    # 2. Enforce one live pending invite per email; recycle a stale one.
    pending = await invitations_repo.get_pending_by_email(session, email)
    if pending is not None:
        if not _is_expired(pending):
            raise ConflictError(
                "An invitation for this email is already pending. " "Resend or revoke it instead.",
                code="invite_pending",
            )
        pending.status = "expired"
        await session.flush()

    # 3. Reserve the Cognito identity. Idempotent: if the email already has an
    #    identity (prior invite/seed), recover its sub and make sure it's
    #    enabled so the invitee can accept.
    display_name = _display_name(first_name, last_name)
    try:
        sub = cognito_client.admin_create_user(email=email, name=display_name, role=role)
    except ConflictError:
        got = cognito_client.admin_get_user(email=email)
        if got is None or not got.get("sub"):
            raise
        sub = str(got["sub"])
        cognito_client.admin_set_user_enabled(email=email, enabled=True)

    # 4. Mint the single-use token + persist the row.
    raw_token = _new_token()
    settings = get_settings()
    expires_at = _now() + timedelta(days=settings.invite_ttl_days)
    try:
        invite = await invitations_repo.create(
            session,
            email=email,
            first_name=first_name,
            last_name=last_name,
            role=role,
            cognito_sub=sub,
            token_hash=_hash_token(raw_token),
            invited_by=actor.id,
            expires_at=expires_at,
        )
        await session.commit()
    except IntegrityError as exc:
        # Concurrent invite for the same email raced us to the pending slot.
        await session.rollback()
        raise ConflictError(
            "An invitation for this email is already pending. " "Resend or revoke it instead.",
            code="invite_pending",
        ) from exc

    await session.refresh(invite)
    log.info(
        "invitations.created",
        invitation_id=str(invite.id),
        role=role,
        invited_by=str(actor.id),
    )
    return invite, raw_token


# ── Resolve (public) ─────────────────────────────────────────────────────────


async def resolve_invitation(session: AsyncSession, raw_token: str) -> Invitation:
    """Validate a link for the public accept page. Never mutates.

    Returns a single generic error for any bad/consumed/expired/unknown token
    so the endpoint can't be used to enumerate which emails were invited.
    """
    invite = await invitations_repo.get_by_token_hash(session, _hash_token(raw_token))
    if invite is None or invite.status != "pending" or _is_expired(invite):
        raise ValidationError(
            "This invitation link is invalid or has expired.",
            code="invite_invalid",
        )
    return invite


# ── Accept (public) ───────────────────────────────────────────────────────────


async def accept_invitation(
    session: AsyncSession, *, raw_token: str, password: str
) -> dict[str, object]:
    """Accept an invite: set the password, materialise the user, consume the
    invite, and return a fresh Cognito token set for auto-login.

    Raises ``ValidationError`` for an invalid/used token (422), an expired one
    (422, lazily marked expired), or a password that fails the pool policy
    (422, surfaced from ``admin_set_user_password``).
    """
    invite = await invitations_repo.get_by_token_hash(session, _hash_token(raw_token))
    if invite is None or invite.status != "pending":
        raise ValidationError(
            "This invitation link is invalid or has already been used.",
            code="invite_invalid",
        )
    if _is_expired(invite):
        invite.status = "expired"
        await session.commit()
        raise ValidationError(
            "This invitation link has expired. Ask an admin to resend it.",
            code="invite_expired",
        )

    email = invite.email
    invite_id = invite.id

    # 1. Set the chosen password (permanent => account confirmed) and make sure
    #    the reserved identity is enabled. A weak password raises here (422)
    #    before anything is consumed, so the invitee can simply retry.
    cognito_client.admin_set_user_password(email=email, password=password, permanent=True)
    cognito_client.admin_set_user_enabled(email=email, enabled=True)

    # 2. Resolve the Cognito sub (set at invite time; recover defensively).
    sub = invite.cognito_sub
    if sub is None:
        got = cognito_client.admin_get_user(email=email)
        sub = str(got["sub"]) if got and got.get("sub") else None
    if sub is None:  # pragma: no cover — invite-time creation always sets sub
        raise IntegrationError("Cognito identity missing for invitation")

    # 3. Materialise/reactivate the mirror + consume the invite. Tolerant of a
    #    concurrent first-/me provision (near-impossible here — the invitee has
    #    no token until now — but cheap to guard).
    try:
        await _finalise_accept(session, invite_id=invite_id, sub=sub)
    except IntegrityError:
        await session.rollback()
        await _finalise_accept(session, invite_id=invite_id, sub=sub)

    # 4. Auto-login with the just-set password (returns access + refresh + id).
    log.info("invitations.accepted", invitation_id=str(invite_id))
    return cognito_client.sign_in(email=email, password=password)


async def _finalise_accept(session: AsyncSession, *, invite_id: uuid.UUID, sub: str) -> None:
    """Idempotent DB tail of accept: upsert the user, mark the invite accepted,
    commit. Re-reads the invite by id so it's safe to call after a rollback.
    """
    invite = await invitations_repo.get_by_id(session, invite_id)
    if invite is None or invite.status not in ("pending", "accepted"):
        raise ValidationError(
            "This invitation link is invalid or has already been used.",
            code="invite_invalid",
        )

    user = await users_repo.get_by_cognito_sub(session, sub)
    if user is None:
        user = await users_repo.create(
            session,
            cognito_sub=sub,
            email=invite.email,
            first_name=invite.first_name,
            last_name=invite.last_name,
            role=invite.role,
            is_active=True,
        )
    elif not user.is_active:
        # Deactivated re-invite (or the near-impossible first-/me race): reactivate
        # and apply the invited role/name.
        user.email = invite.email
        user.first_name = invite.first_name
        user.last_name = invite.last_name
        user.role = invite.role
        user.is_active = True
    else:
        # An ACTIVE member already owns this Cognito identity — this invite is
        # stale/duplicate. NEVER re-role or overwrite a live account through the
        # unauthenticated accept path: a stale invite carries the role captured
        # when it was created, so honouring it here would be privilege
        # escalation (or last-super-admin demotion) with no permission check.
        # Fail safe and consume nothing.
        raise ValidationError(
            "This invitation is no longer valid.",
            code="invite_invalid",
        )

    invite.status = "accepted"
    invite.accepted_at = _now()
    await session.commit()


# ── Revoke ────────────────────────────────────────────────────────────────────


async def revoke_invitation(session: AsyncSession, *, invitation_id: uuid.UUID) -> Invitation:
    """Cancel a pending invite and disable its reserved Cognito identity.

    Idempotent for an already-revoked invite; refuses to revoke one that was
    already accepted (the user is a real member — deactivate them via the
    users API instead).
    """
    invite = await invitations_repo.get_by_id(session, invitation_id)
    if invite is None:
        raise NotFoundError("Invitation not found")
    if invite.status == "accepted":
        raise ConflictError(
            "This invitation was already accepted; deactivate the user instead.",
            code="invite_accepted",
        )
    if invite.status == "revoked":
        return invite

    invite.status = "revoked"
    # Disable the reserved Cognito identity (reversible) ONLY if it isn't backing
    # an active member. There is one Cognito identity per email, so a stale
    # invite can share a ``sub`` with a since-activated user — disabling then
    # would silently lock a legitimate member out (the create-time active-user
    # 409 guard doesn't re-run at revoke time).
    if invite.cognito_sub is not None:
        member = await users_repo.get_by_cognito_sub(session, invite.cognito_sub)
        if member is None or not member.is_active:
            cognito_client.admin_set_user_enabled(email=invite.email, enabled=False)

    await session.commit()
    await session.refresh(invite)
    log.info("invitations.revoked", invitation_id=str(invite.id))
    return invite


# ── Resend ────────────────────────────────────────────────────────────────────


async def resend_invitation(
    session: AsyncSession, *, invitation_id: uuid.UUID
) -> tuple[Invitation, str]:
    """Issue a fresh token + expiry for a pending/revoked/expired invite,
    invalidating the previous link. Returns ``(invitation, raw_token)``.

    Refuses an already-accepted invite. Re-enables the Cognito identity in case
    a prior revoke disabled it.
    """
    invite = await invitations_repo.get_by_id(session, invitation_id)
    if invite is None:
        raise NotFoundError("Invitation not found")
    if invite.status == "accepted":
        raise ConflictError(
            "This invitation was already accepted.",
            code="invite_accepted",
        )
    # Refuse to resurrect an invite whose email now belongs to an ACTIVE member.
    # Otherwise a stale invite (carrying an old role) could be re-sent and then
    # accepted against a live account — defence in depth alongside the
    # active-user guard in _finalise_accept.
    member = await users_repo.get_by_email(session, invite.email)
    if member is not None and member.is_active:
        raise ConflictError(
            "This email already belongs to an active user.",
            code="user_exists",
        )

    raw_token = _new_token()
    settings = get_settings()
    invite.token_hash = _hash_token(raw_token)
    invite.status = "pending"
    invite.expires_at = _now() + timedelta(days=settings.invite_ttl_days)

    if invite.cognito_sub is not None:
        cognito_client.admin_set_user_enabled(email=invite.email, enabled=True)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise ConflictError(
            "Another pending invitation already exists for this email.",
            code="invite_pending",
        ) from exc

    await session.refresh(invite)
    log.info("invitations.resent", invitation_id=str(invite.id))
    return invite, raw_token


# ── Listing / display ─────────────────────────────────────────────────────────


async def list_invitations(session: AsyncSession, *, status: str | None = None) -> list[Invitation]:
    return await invitations_repo.list_all(session, status=status)


def effective_status(invite: Invitation) -> str:
    """Display status: a pending invite past its expiry reads as ``expired``
    even though the row hasn't been flipped yet (lazy expiry)."""
    if invite.status == "pending" and _is_expired(invite):
        return "expired"
    return invite.status
