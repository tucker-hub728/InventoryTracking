"""Reusable FastAPI dependencies.

Cross-cutting "things a route needs" live here: DB session, current user
(authenticated principal + corresponding ``app.users`` row), pagination
later, etc. Annotated types are exposed so route signatures stay clean::

    async def list_items(db: DBSession, user: CurrentDbUserDep) -> ...
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import provisioning, repository as users_repo
from app.auth.cognito_client import get_user as cognito_get_user
from app.auth.dependencies import CurrentUser, CurrentUserDep
from app.core.exceptions import NotFoundError
from app.db.session import get_session
from app.models.identity import User

DBSession = Annotated[AsyncSession, Depends(get_session)]


async def resolve_db_user(
    current: CurrentUser,
    db: AsyncSession,
) -> User:
    """Return the ``app.users`` row for the authenticated principal.

    Lazy-provisions on first call (same path as ``/auth/me``) so any
    protected route works for an admin-created user even before they've
    hit ``/auth/me``.
    """
    existing = await users_repo.get_by_cognito_sub(db, current.sub)
    if existing is not None:
        return existing
    # First call for an admin-created user — provision from Cognito attrs.
    fresh = cognito_get_user(access_token=current.access_token)
    user = await provisioning.provision_from_me(
        db,
        cognito_sub=current.sub,
        cognito_attrs=fresh["attributes"],
        username=fresh["username"],
    )
    if user is None:  # pragma: no cover — provisioning always returns
        raise NotFoundError("User record not found")
    return user


async def _current_db_user(
    current: CurrentUserDep,
    db: DBSession,
) -> User:
    return await resolve_db_user(current, db)


CurrentDbUserDep = Annotated[User, Depends(_current_db_user)]
