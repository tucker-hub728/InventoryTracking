"""Invitation orchestration — the edge-case-heavy core of the invite flow.

This module coordinates Cognito (via the sanctioned facade) and the local
``app.invitations`` table. It is the ONLY place that knows the invite lifecycle
rules:

  * create   — reserve a Cognito identity in ``FORCE_CHANGE_PASSWORD`` (Cognito
               emails a temporary password) and persist a pending tracking row
  * mark      — flip the pending row to ``accepted`` once the invitee completes
               the first-login set-password challenge
  * revoke   — HARD-DELETE the reserved identity from Cognito AND the DB
  * resend   — re-email a fresh temporary password and re-arm the row

Credential model: Cognito owns the credential. At invite time the account has a
Cognito-issued temporary password (emailed to the invitee, delivered via Amazon
SES in prod). On first sign-in the invitee hits ``NEW_PASSWORD_REQUIRED`` and
sets a real password (see :func:`app.auth.cognito_client.respond_to_new_password_challenge`).
The local ``app.users`` mirror is lazy-materialised on the first ``/auth/me``
(:mod:`app.auth.provisioning`); this module only owns the invitation record.

The ``invitations`` table is a display/lifecycle record for the admin panel
(who was invited, in what role, by whom, pending/accepted/revoked/expired). It
holds no credential — there is no app-issued token anymore.

In local dev cognito-local cannot deliver email, so the temporary password is
generated here, logged, and returned to the admin UI. In production it is
Cognito/SES-emailed and never logged or returned.
"""

from __future__ import annotations

import secrets
import string
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
    NotFoundError,
)
from app.core.logging import get_logger
from app.invitations import repository as invitations_repo
from app.models.identity import User
from app.models.invitations import Invitation

log = get_logger(__name__)


# ── Temporary-password helper ────────────────────────────────────────────────
# Cognito generates a temporary password itself, but we supply one so the value
# is known in local dev (cognito-local can't email it). It must satisfy the pool
# policy: 12+ chars with upper, lower, digit and symbol.

_TMP_SYMBOLS = "!@#$%^&*-_"


def _generate_temp_password() -> str:
    pools = (string.ascii_uppercase, string.ascii_lowercase, string.digits, _TMP_SYMBOLS)
    # One guaranteed char from each class, then fill to length 16 from all of them.
    chars = [secrets.choice(p) for p in pools]
    alphabet = "".join(pools)
    chars += [secrets.choice(alphabet) for _ in range(12)]
    # Shuffle so the guaranteed chars aren't always in the first four positions.
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def _now() -> datetime:
    return datetime.now(UTC)


def _is_expired(invite: Invitation) -> bool:
    return invite.expires_at <= _now()


def _display_name(first_name: str, last_name: str) -> str:
    return f"{first_name} {last_name}".strip()


def _is_active(user: User) -> bool:
    return user.status == "active"


def _dev_temp_password(raw: str) -> str | None:
    """Return the temp password to surface to the admin — only in local dev.

    In production the value is Cognito/SES-emailed and must never leave the
    backend, so this returns ``None`` there.
    """
    return raw if get_settings().is_development else None


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


def _reserve_cognito_identity(
    email: str, display_name: str, role: str, temp_password: str
) -> str:
    """Create (or recover) the Cognito identity for an invitee and return its
    ``sub``. Cognito emails the temporary password. Idempotent: an email that
    already has a not-yet-confirmed identity is re-enabled and re-emailed a fresh
    temporary password so a re-invite works cleanly."""
    try:
        return cognito_client.admin_create_user(
            email=email, name=display_name, role=role, temporary_password=temp_password
        )
    except ConflictError:
        got = cognito_client.admin_get_user(email=email)
        if got is None or not got.get("sub"):
            raise
        cognito_client.admin_set_user_enabled(email=email, enabled=True)
        cognito_client.admin_resend_invite(email=email, temporary_password=temp_password)
        return str(got["sub"])


# ── Create ──────────────────────────────────────────────────────────────────


async def create_invitation(
    session: AsyncSession,
    *,
    actor: User,
    email: str,
    first_name: str,
    last_name: str,
    role: str,
) -> tuple[Invitation, str | None]:
    """Invite a new user. Returns ``(invitation, temp_password_or_None)``.

    Cognito emails the invitee a temporary password; on first login they set a
    real one. The returned temp password is non-null only in local dev (where
    cognito-local can't deliver mail).

    Edge cases: existing active member (409), an existing live pending invite
    (409 — resend/revoke instead), a stale expired pending invite (recycled),
    and an email that already has a Cognito identity (recovered + re-emailed).
    """
    _assert_can_grant(actor, role)

    # 1. Refuse if an ACTIVE local member already owns this email. A deactivated
    #    member is allowed through — completing onboarding reactivates them.
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

    # 3. Reserve the Cognito identity (Cognito emails the temporary password).
    display_name = _display_name(first_name, last_name)
    temp_password = _generate_temp_password()
    sub = _reserve_cognito_identity(email, display_name, role, temp_password)

    # 4. Persist the pending tracking row.
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

    if settings.is_development:
        log.info("invitations.dev_temp_password", email=email, temporary_password=temp_password)
    log.info("invitations.created", invitation_id=str(invite.id), role=role, invited_by=str(actor.id))
    return invite, _dev_temp_password(temp_password)


# ── Accept (mark) ─────────────────────────────────────────────────────────────


async def mark_accepted_by_email(session: AsyncSession, *, email: str) -> None:
    """Consume the pending invitation for ``email`` after the invitee completes
    the first-login set-password challenge. No-op when there is no pending invite
    (e.g. the bootstrap super admin, who was never invited)."""
    invite = await invitations_repo.get_pending_by_email(session, email)
    if invite is None:
        return
    invite.status = "accepted"
    invite.accepted_at = _now()
    await session.commit()
    log.info("invitations.accepted", invitation_id=str(invite.id))


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
) -> tuple[Invitation, str | None]:
    """Re-email a fresh temporary password for a pending invite and re-arm its
    expiry. Returns ``(invitation, temp_password_or_None)`` (temp password is
    non-null only in local dev).

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
    temp_password = _generate_temp_password()

    if invite.cognito_sub is not None:
        cognito_client.admin_set_user_enabled(email=invite.email, enabled=True)
    cognito_client.admin_resend_invite(email=invite.email, temporary_password=temp_password)

    invite.status = "pending"
    invite.expires_at = _now() + timedelta(days=settings.invite_ttl_days)
    await session.commit()
    await session.refresh(invite)

    if settings.is_development:
        log.info(
            "invitations.dev_temp_password", email=invite.email, temporary_password=temp_password
        )
    log.info("invitations.resent", invitation_id=str(invite.id))
    return invite, _dev_temp_password(temp_password)


# ── Listing / display ─────────────────────────────────────────────────────────


async def list_invitations(session: AsyncSession, *, status: str | None = None) -> list[Invitation]:
    return await invitations_repo.list_all(session, status=status)


def effective_status(invite: Invitation) -> str:
    """Display status: a pending invite past its expiry reads as ``expired``."""
    if invite.status == "pending" and _is_expired(invite):
        return "expired"
    return invite.status
