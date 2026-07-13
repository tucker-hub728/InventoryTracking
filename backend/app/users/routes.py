"""``/v1/users`` routes — list users, switch roles, enable/disable.

Both ``super_admin`` and ``admin`` may view the user directory and change roles
(``users:view`` / ``users:edit``). Enabling/disabling a user is a super-admin
action routed through AWS Cognito (``admin_enable_user`` / ``admin_disable_user``)
so a disabled user can't even mint a token — the local ``app.users.status`` and
the Cognito identity are kept in lock-step.

A safety guard prevents demoting or deactivating the last remaining
``super_admin`` so the system can never be locked out of super-admin access.

Users are *created* in Cognito (via ``scripts/seed_super_admins.py`` or the
invite flow); this surface only edits the local ``app.users`` mirror + the
Cognito enabled flag.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.api.deps import DBSession
from app.auth import cognito_client
from app.auth import repository as users_repo
from app.core.exceptions import ConflictError, NotFoundError
from app.models.identity import User
from app.security.permissions import RequirePermission
from app.users.schemas import UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _is_active(user: User) -> bool:
    return user.status == "active"


def _to_read(user: User) -> UserRead:
    return UserRead(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        initials=user.initials,
        role=user.role,
        status=user.status,
        is_active=_is_active(user),
        created_at=user.created_at,
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
    summary="Edit a user's name, role, and/or active flag",
    dependencies=[Depends(RequirePermission("users", "edit"))],
)
async def update_user(
    db: DBSession,
    user_id: Annotated[uuid.UUID, Path()],
    payload: UserUpdate,
) -> UserRead:
    user = await users_repo.get_by_id(db, user_id)
    if user is None:
        raise NotFoundError(f"User {user_id} not found")

    data = payload.model_dump(exclude_unset=True)

    # Guard the last super_admin against demotion / deactivation so the system
    # can't be locked out.
    demoting = "role" in data and data["role"] != "super_admin"
    deactivating = data.get("is_active") is False
    if user.role == "super_admin" and (demoting or deactivating):
        if await users_repo.count_super_admins(db) <= 1:
            raise ConflictError(
                "Can't demote or deactivate the last super admin",
                code="last_super_admin",
            )

    if "full_name" in data and data["full_name"] is not None:
        user.full_name = data["full_name"].strip()
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
    if active_changed:
        cognito_client.admin_set_user_enabled(email=user.email, enabled=_is_active(user))

    await db.flush()
    await db.refresh(user)
    response = _to_read(user)
    await db.commit()
    return response
