"""Invitation orchestration — the edge-case-heavy core of the invite flow.

This module coordinates Cognito (via the sanctioned facade) and the local
``app.invitations`` + ``app.users`` tables. It is the ONLY place that knows the
invite lifecycle rules:

  * create   — reserve a locked Cognito identity + persist a hashed single-use
               token, then email the invitee a secure accept LINK
  * resolve  — validate a link for the public accept page (no mutation)
  * accept   — set the chosen password (token is the credential), materialise
               the user, consume the invite, and mint a session
  * revoke   — HARD-DELETE the reserved identity from Cognito AND the DB
  * resend   — mint a fresh token + expiry and re-email the accept link

Security model: the credential is the single-use, 256-bit, hashed, expiring
token delivered only in the invite email. The account has NO password until the
invitee sets one at accept time, so there is nothing to guess. The chosen
password is validated against the pool policy server-side
(:func:`app.core.passwords.validate_password_strength`) so a weak password is
rejected even where the identity backend doesn't enforce it (cognito-local).

Only the SHA-256 hash of a link token is persisted; the raw token is returned to
the admin exactly once (for the copyable link) and emailed to the invitee.
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
from app.core.email import send_invitation_email
from app.core.exceptions import (
    AuthorizationError,
    ConflictError,
    IntegrationError,
    NotFoundError,
    ValidationError,
)
from app.core.logging import get_logger
from app.core.passwords import validate_password_strength
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


def _initials(first_name: str, last_name: str) -> str:
    letters = (first_name[:1] + last_name[:1]).upper()
    return (letters or first_name[:2].upper() or "?")[:8]


def _is_active(user: User) -> bool:
    return user.status == "active"


def _assert_can_grant(actor: User, role: str) -> None:
    """Who-can-invite-whom guard. v1: only ``super_admin`` may invite, and may
    grant any assignable role. Defence in depth behind the route's
    ``RequirePermission('users','create')``."""
    if actor.role == "super_admin":
        return
    raise AuthorizationError(
        "Only a super admin may send invitations.",
        code="permission_denied",
        details={"actor_role": actor.role, "target_role": role},
    )


def _reserve_cognito_identity(email: str, display_name: str, role: str) -> str:
    """Create (or recover) the locked Cognito identity for an invitee and return
    its ``sub``. Idempotent: an email that already has an identity is recovered
    and re-enabled so a re-invite works cleanly."""
    try:
        return cognito_client.admin_create_user(email=email, name=display_name, role=role)
    except ConflictError:
        got = cognito_client.admin_get_user(email=email)
        if got is None or not got.get("sub"):
            raise
        cognito_client.admin_set_user_enabled(email=email, enabled=True)
        return str(got["sub"])


async def _deliver_invite_email(*, email: str, display_name: str, raw_token: str) -> None:
    """Email the invitee their single-use accept link. Best-effort — the admin
    can copy the link from the API response if delivery fails."""
    settings = get_settings()
    accept_url = settings.accept_invite_url(raw_token) or settings.accept_invite_path(raw_token)
    await send_invitation_email(to_email=email, display_name=display_name, accept_url=accept_url)


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

    Edge cases: existing active member (409), an existing live pending invite
    (409 — resend/revoke instead), a stale expired pending invite (recycled),
    and an email that already has a Cognito identity (recovered + re-enabled).
    """
    _assert_can_grant(actor, role)

    # 1. Refuse if an ACTIVE local member already owns this email. A deactivated
    #    member is allowed through — accept will reactivate them.
    existing_user = await users_repo.get_by_email(session, email)
    if existing_user is not None and _is_active(existing_user):
        raise ConflictError("A user with this email already exists.", code="user_exists")

    # 2. Enforce one live pending invite per email; recycle a stale one.
    pending = await invitations_repo.get_pending_by_email(session, email)
    if pending is not None:
        if not _is_expired(pending):
            raise ConflictError(
                "An invitation for this email is already pending. Resend or revoke it instead.",
                code="invite_pending",
            )
        pending.status = "expired"
        await session.flush()

    # 3. Reserve the locked Cognito identity (no password set).
    display_name = _display_name(first_name, last_name)
    sub = _reserve_cognito_identity(email, display_name, role)

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
        await session.rollback()
        raise ConflictError(
            "An invitation for this email is already pending. Resend or revoke it instead.",
            code="invite_pending",
        ) from exc

    await session.refresh(invite)

    # 5. Email the accept link (best-effort).
    await _deliver_invite_email(email=email, display_name=display_name, raw_token=raw_token)

    log.info("invitations.created", invitation_id=str(invite.id), role=role, invited_by=str(actor.id))
    return invite, raw_token


# ── Resolve (public) ─────────────────────────────────────────────────────────


async def resolve_invitation(session: AsyncSession, raw_token: str) -> Invitation:
    """Validate a link for the public accept page. Never mutates.

    Returns a single generic error for any bad/consumed/expired/unknown token so
    the endpoint can't be used to enumerate which emails were invited.
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
    """Accept an invite: the token is the credential. Sets the chosen password,
    materialises the user, consumes the invite, and returns a fresh Cognito
    token set for auto-login.

    Raises ``ValidationError`` for an invalid/used token (422), an expired one
    (422, lazily marked expired), or a password that fails the policy (422 —
    enforced server-side, then again by Cognito).
    """
    # 1. The token must resolve to a live pending invite. This is the ONLY
    #    credential — a wrong/absent token can't get past here.
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

    # 2. Enforce the password policy server-side BEFORE touching Cognito, so a
    #    weak password is rejected even where the backend doesn't enforce it.
    validate_password_strength(password)

    email = invite.email
    invite_id = invite.id

    # 3. Set the chosen password (permanent => account confirmed) and make sure
    #    the reserved identity is enabled. Cognito re-validates the policy.
    cognito_client.admin_set_user_password(email=email, password=password, permanent=True)
    cognito_client.admin_set_user_enabled(email=email, enabled=True)

    # 4. Resolve the Cognito sub (set at invite time; recover defensively).
    sub = invite.cognito_sub
    if sub is None:
        got = cognito_client.admin_get_user(email=email)
        sub = str(got["sub"]) if got and got.get("sub") else None
    if sub is None:  # pragma: no cover — invite-time creation always sets sub
        raise IntegrationError("Cognito identity missing for invitation")

    # 5. Materialise/reactivate the mirror + consume the invite.
    try:
        await _finalise_accept(session, invite_id=invite_id, sub=sub)
    except IntegrityError:
        await session.rollback()
        await _finalise_accept(session, invite_id=invite_id, sub=sub)

    # 6. Auto-login with the just-set password (returns access + refresh + id).
    log.info("invitations.accepted", invitation_id=str(invite_id))
    return cognito_client.sign_in(email=email, password=password)


async def _finalise_accept(session: AsyncSession, *, invite_id: uuid.UUID, sub: str) -> None:
    """Idempotent DB tail of accept: upsert the user, mark the invite accepted,
    commit. Re-reads the invite by id so it's safe to call after a rollback."""
    invite = await invitations_repo.get_by_id(session, invite_id)
    if invite is None or invite.status not in ("pending", "accepted"):
        raise ValidationError(
            "This invitation link is invalid or has already been used.",
            code="invite_invalid",
        )

    full_name = _display_name(invite.first_name, invite.last_name)
    user = await users_repo.get_by_cognito_sub(session, sub)
    if user is None:
        user = await users_repo.create(
            session,
            cognito_sub=sub,
            email=invite.email,
            full_name=full_name,
            initials=_initials(invite.first_name, invite.last_name),
            role=invite.role,
            status="active",
        )
    elif not _is_active(user):
        user.email = invite.email
        user.full_name = full_name
        user.initials = _initials(invite.first_name, invite.last_name)
        user.role = invite.role
        user.status = "active"
        user.accepted_invite_at = _now()
    else:
        # An ACTIVE member already owns this identity — never re-role a live
        # account through the unauthenticated accept path (privilege-escalation
        # guard). Fail safe and consume nothing.
        raise ValidationError("This invitation is no longer valid.", code="invite_invalid")

    invite.status = "accepted"
    invite.accepted_at = _now()
    await session.commit()


# ── Revoke (hard delete) ───────────────────────────────────────────────────────


async def revoke_invitation(session: AsyncSession, *, invitation_id: uuid.UUID) -> None:
    """Revoke a pending invitation: HARD-DELETE the reserved identity from
    Cognito AND remove the invitation (and any not-yet-active mirror) from the
    DB, so the email is free to be invited again cleanly.

    Refuses to revoke an already-accepted invite — that's a real member; use the
    users API to deactivate them instead.
    """
    invite = await invitations_repo.get_by_id(session, invitation_id)
    if invite is None:
        raise NotFoundError("Invitation not found")
    if invite.status == "accepted":
        raise ConflictError(
            "This invitation was already accepted; deactivate the user instead.",
            code="invite_accepted",
        )

    email = invite.email

    # Delete any not-yet-active mirror sharing this identity. An ACTIVE member is
    # never touched — revoke only applies to a reserved/pending identity.
    if invite.cognito_sub is not None:
        member = await users_repo.get_by_cognito_sub(session, invite.cognito_sub)
        if member is not None and not _is_active(member):
            await users_repo.hard_delete(session, member)

    # Destroy the reserved Cognito identity (idempotent if already gone).
    cognito_client.admin_delete_user(email=email)

    # Remove the invitation row entirely.
    await invitations_repo.delete(session, invite)
    await session.commit()
    log.info("invitations.revoked_deleted", email=email)


# ── Resend ────────────────────────────────────────────────────────────────────


async def resend_invitation(
    session: AsyncSession, *, invitation_id: uuid.UUID
) -> tuple[Invitation, str]:
    """Issue a fresh token + expiry for a pending invite and re-email the accept
    link, invalidating the previous link. Returns ``(invitation, raw_token)``.

    Refuses an already-accepted invite. Re-enables the identity in case it was
    disabled.
    """
    invite = await invitations_repo.get_by_id(session, invitation_id)
    if invite is None:
        raise NotFoundError("Invitation not found")
    if invite.status == "accepted":
        raise ConflictError("This invitation was already accepted.", code="invite_accepted")

    member = await users_repo.get_by_email(session, invite.email)
    if member is not None and _is_active(member):
        raise ConflictError("This email already belongs to an active user.", code="user_exists")

    settings = get_settings()
    display_name = _display_name(invite.first_name, invite.last_name)

    if invite.cognito_sub is not None:
        cognito_client.admin_set_user_enabled(email=invite.email, enabled=True)

    raw_token = _new_token()
    invite.token_hash = _hash_token(raw_token)
    invite.status = "pending"
    invite.expires_at = _now() + timedelta(days=settings.invite_ttl_days)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise ConflictError(
            "Another pending invitation already exists for this email.",
            code="invite_pending",
        ) from exc

    await session.refresh(invite)
    await _deliver_invite_email(email=invite.email, display_name=display_name, raw_token=raw_token)

    log.info("invitations.resent", invitation_id=str(invite.id))
    return invite, raw_token


# ── Listing / display ─────────────────────────────────────────────────────────


async def list_invitations(session: AsyncSession, *, status: str | None = None) -> list[Invitation]:
    return await invitations_repo.list_all(session, status=status)


def effective_status(invite: Invitation) -> str:
    """Display status: a pending invite past its expiry reads as ``expired``."""
    if invite.status == "pending" and _is_expired(invite):
        return "expired"
    return invite.status
