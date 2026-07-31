"""``/v1/users`` routes — list users, switch roles, enable/disable.

Both ``super_admin`` and ``admin`` may view the user directory (``users:view``),
but changing a member's name / role / active flag is super-admin-only
(``users:edit`` — a permission no other role holds). Enabling/disabling a user is
routed through AWS Cognito (``admin_enable_user`` / ``admin_disable_user``) so a
disabled user can't even mint a token — the local ``app.users.status`` and the
Cognito identity are kept in lock-step.

**Becoming a Super Admin (REQ-2026-07-31-ROL-005)** — promotion is the only path.
An existing Super Admin edits the record of a user who has *accepted their invite
and logged in*, and lifts them to ``super_admin``. The role is never selectable at
invite time (see ``app.invitations.schemas.AssignableRole``). The first Super Admin
is seeded at deployment by ``scripts/seed_super_admins.py``.

A safety guard prevents demoting or deactivating the last remaining **active**
``super_admin`` — including by self-demotion — so the system can never be locked
out of super-admin access.

Every role change is written to ``audit.audit_events`` with the grantor, the
grantee, the old and new role, and a timestamp (REQ-2026-07-31-ROL-008).

Users are *created* in Cognito (via ``scripts/seed_super_admins.py`` or the
invite flow); this surface only edits the local ``app.users`` mirror + the
Cognito enabled flag.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit.recorder import record_entity_change
from app.auth import cognito_client
from app.auth import repository as users_repo
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from app.models.identity import User
from app.security.permissions import RequirePermission
from app.users.schemas import USER_UPDATE_ACTION, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _is_active(user: User) -> bool:
    return user.status == "active"


def _promotion_blocker(target: User) -> tuple[str, str] | None:
    """Why ``target`` isn't eligible for promotion yet, as ``(code, message)``.

    Returns ``None`` when the user *is* eligible. Single source of truth for
    REQ-2026-07-31-ROL-005's "has accepted their invitation and logged in": the
    route raises from it, and ``_to_read`` surfaces it to the UI so the dropdown
    can explain itself instead of failing on submit.

    A person who has never signed in is not yet "an existing active user", and
    promoting a dormant invite would hand the highest role to an unverified
    mailbox.

    **Why ``last_active_at`` and not ``accepted_invite_at``.** The client's phrase
    describes one journey, not two independent flags, and a login can only happen
    *after* acceptance: Cognito issues no tokens until the invitee clears the
    ``NEW_PASSWORD_REQUIRED`` challenge, which is exactly what acceptance is. So a
    non-NULL ``last_active_at`` already proves both halves.

    Testing this against the dev database also showed why it must not key off
    ``accepted_invite_at`` alone: that column was NULL for **every** user, because
    nothing wrote it until ``invitations.service.mark_accepted_by_email`` was
    fixed alongside this change. Gating on it would have made promotion impossible
    for everyone — the same dead end this requirement exists to remove.
    """
    if not _is_active(target):
        return (
            "promotion_target_inactive",
            f"{target.full_name} must be an active user before being promoted",
        )
    if target.last_active_at is None:
        return (
            "promotion_target_never_logged_in",
            f"{target.full_name} has not accepted their invitation and logged in yet",
        )
    return None


def _assert_can_grant_super_admin(actor: User, target: User) -> None:
    """Gate the promotion path (REQ-2026-07-31-ROL-005).

    Only an existing Super Admin may grant Super Admin. ``users:edit`` is already
    super-admin-only, so the actor check is defence in depth — it keeps the rule
    true even if the permission matrix is widened later.
    """
    if actor.role != "super_admin":
        raise AuthorizationError(
            "Only a super admin can promote someone to super admin",
            code="permission_denied",
            details={"required_role": "super_admin"},
        )

    blocker = _promotion_blocker(target)
    if blocker is not None:
        code, message = blocker
        raise ValidationError(message, code=code)


def _initials_from_name(full_name: str) -> str:
    """Two-letter initials from a display name, matching the invite flow
    (first letter of the first and last word; falls back for one-word names)."""
    parts = full_name.split()
    if not parts:
        return "?"
    letters = parts[0][:1] + (parts[-1][:1] if len(parts) > 1 else parts[0][1:2])
    return letters.upper()[:8] or "?"


def _to_read(user: User) -> UserRead:
    # ``blocker`` is None for an already-eligible user and for an existing super
    # admin (who trivially passes every condition) — the UI hides the option in
    # that case anyway, since there is nothing to promote them to.
    blocker = _promotion_blocker(user)
    return UserRead(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        initials=user.initials,
        role=user.role,
        status=user.status,
        is_active=_is_active(user),
        created_at=user.created_at,
        can_be_promoted=blocker is None,
        promotion_blocked_reason=blocker[1] if blocker else None,
        is_seed=user.is_seed,
    )


@router.get(
    "",
    response_model=list[UserRead],
    summary="List users",
    dependencies=[Depends(RequirePermission("users", "view"))],
)
async def list_users(db: DBSession) -> list[UserRead]:
    return [_to_read(u) for u in await users_repo.list_users(db)]


@router.patch(
    "/{user_id}",
    response_model=UserRead,
    summary="Edit a user's email, name, role, and/or active flag "
    "(role and email changes are e-signed)",
    dependencies=[Depends(RequirePermission("users", "edit"))],
)
async def update_user(
    db: DBSession,
    current: CurrentDbUserDep,
    user_id: Annotated[uuid.UUID, Path()],
    payload: UserUpdate,
) -> UserRead:
    user = await users_repo.get_by_id(db, user_id)
    if user is None:
        raise NotFoundError(f"User {user_id} not found")

    data = payload.model_dump(exclude_unset=True)
    # Not entity fields — pulled out so they never reach the assignment loop.
    data.pop("evidence_id", None)
    data.pop("reason", None)
    before_role = user.role
    before_email = user.email

    # Email change: reject a collision before touching Cognito, so a duplicate
    # fails cleanly instead of half-applying. The DB's partial-unique index on
    # lower(email) is the backstop; this is the friendly error.
    new_email = data.get("email")
    email_changed = new_email is not None and new_email.lower() != user.email.lower()
    if email_changed:
        clash = await users_repo.get_by_email(db, new_email)
        if clash is not None and clash.id != user.id:
            raise ConflictError(
                f"{new_email} is already used by another member",
                code="email_taken",
            )

    # Promotion to super_admin: only a super admin may grant it, and only to an
    # active user who has accepted their invite and logged in.
    promoting = data.get("role") == "super_admin" and before_role != "super_admin"
    if promoting:
        _assert_can_grant_super_admin(current, user)

    # ── The seeded super admin is permanent (client, 2026-07-31) ─────────
    # Stronger than the count-based guard below, and independent of it: this one
    # account is always super_admin, keeps its email forever, and can never be
    # deactivated — by anyone, including itself. Its *name* stays editable.
    #
    # Rationale: the count guard only promises that SOME super admin survives,
    # which could end up being an account created ad hoc during a support call.
    # This pins the deployment to a known identity.
    if user.is_seed:
        demoting_seed = "role" in data and data["role"] != "super_admin"
        if demoting_seed:
            raise ConflictError(
                "The seeded super admin's role can't be changed",
                code="seed_admin_immutable",
                details={"field": "role"},
            )
        if email_changed:
            raise ConflictError(
                "The seeded super admin's email address can't be changed",
                code="seed_admin_immutable",
                details={"field": "email"},
            )
        if data.get("is_active") is False:
            raise ConflictError(
                "The seeded super admin can't be deactivated",
                code="seed_admin_immutable",
                details={"field": "is_active"},
            )

    # Guard the last super_admin against demotion / deactivation so the system
    # can't be locked out. This is target-keyed, not actor-keyed, so it catches
    # self-demotion too (REQ-2026-07-31-ROL-007).
    #
    # ``_is_active(user)`` matters: ``count_super_admins`` counts only *active*
    # super admins, so a suspended one is not part of the count and removing its
    # role can't strand anybody. Without this condition, demoting a suspended
    # super admin while exactly one active super admin remained would be blocked
    # for no reason.
    demoting = "role" in data and data["role"] != "super_admin"
    deactivating = data.get("is_active") is False
    if user.role == "super_admin" and _is_active(user) and (demoting or deactivating):
        if await users_repo.count_super_admins(db) <= 1:
            raise ConflictError(
                "Can't demote or deactivate the last super admin",
                code="last_super_admin",
            )

    # ── Electronic signature (every edit) ───────────────────────────────────
    # Any change to a member record is signed: role and email decide what a
    # person may do and how they authenticate, the active flag decides whether
    # they can work at all, and the display name is what every audit row and
    # signature is attributed to. None of those should change without an
    # attributable signature in a Part 11 system.
    mutating = any(k in data for k in ("email", "full_name", "role", "is_active"))
    evidence_uuid: uuid.UUID | None = None
    if mutating:
        if not payload.evidence_id:
            raise ValidationError(
                "Editing a member requires your password signature",
                code="signature_required",
                details={"action": USER_UPDATE_ACTION},
            )
        try:
            evidence_uuid = uuid.UUID(payload.evidence_id)
        except ValueError as exc:
            raise ValidationError(
                "evidence_id is not a valid uuid", code="invalid_evidence_id"
            ) from exc
        # Consumed in this transaction: single-use, and a replay rolls the whole
        # edit back rather than applying it twice.
        await consume_reauth_evidence(
            db,
            evidence_id=evidence_uuid,
            user_id=current.id,
            expected_action=USER_UPDATE_ACTION,
            target_table="app.users",
            target_id=user.id,
        )

    before_name = user.full_name
    before_active = _is_active(user)

    if "full_name" in data and data["full_name"] is not None:
        user.full_name = data["full_name"].strip()
        # Keep initials (used for the avatar) in sync with the new name.
        user.initials = _initials_from_name(user.full_name)
    if "role" in data and data["role"] is not None:
        user.role = data["role"]

    active_changed = False
    if "is_active" in data and data["is_active"] is not None:
        target_active = data["is_active"]
        active_changed = target_active != _is_active(user)
        # ``suspended`` mirrors a disabled Cognito identity; ``active`` re-enables.
        user.status = "active" if target_active else "suspended"

    # Keep Cognito in lock-step so a deactivated user can't even mint a token
    # (the resolve_db_user guard already blocks protected routes, but disabling
    # the identity closes the login door too). Done before commit so a Cognito
    # failure aborts the change.
    #
    # Order matters: the email move goes first and is addressed by the OLD
    # address, because that's what still identifies the account in Cognito. The
    # enable/disable call below then uses ``user.email``, which by that point is
    # the new one — the same identity, reachable by its new alias.
    if email_changed:
        cognito_client.admin_update_email(email=before_email, new_email=new_email)
        user.email = new_email

    if active_changed:
        cognito_client.admin_set_user_enabled(email=user.email, enabled=_is_active(user))

    await db.flush()

    # Log the change: actor (grantor), subject (grantee), the before/after diff,
    # and a timestamp — REQ-2026-07-31-ROL-009. Every signed edit is recorded,
    # not just role grants: a signature with nothing to point at proves nothing.
    #
    # Role and email are escalated to ``warning`` so they stand out in the audit
    # viewer next to a routine rename.
    role_changed = user.role != before_role
    name_changed = user.full_name != before_name
    active_now_changed = _is_active(user) != before_active

    before_state: dict[str, str] = {}
    after_state: dict[str, str] = {}
    if role_changed:
        before_state["role"] = before_role
        after_state["role"] = user.role
    if email_changed:
        before_state["email"] = before_email
        after_state["email"] = user.email
    if name_changed:
        before_state["full_name"] = before_name
        after_state["full_name"] = user.full_name
    if active_now_changed:
        before_state["is_active"] = str(before_active)
        after_state["is_active"] = str(_is_active(user))

    if before_state:
        context: dict[str, str] = {
            "changed_by": current.email,
            "changed_for": user.email,
        }
        if payload.reason:
            context["reason"] = payload.reason
        await record_entity_change(
            db,
            actor_user_id=current.id,
            action="updated",
            subject_table="app.users",
            subject_id=user.id,
            subject_label=user.email,
            before=before_state,
            after=after_state,
            severity="warning" if role_changed or email_changed else None,
            context=context,
            # Ties the audit row to the e-signature that authorised it.
            signature_id=evidence_uuid,
        )

    await db.refresh(user)
    response = _to_read(user)
    await db.commit()
    return response
