"""Bridge Cognito identities into local ``app.users`` rows.

This is an internal platform — users are created by admins (via Cognito's
``admin-create-user``, not yet wired through a public endpoint) and the
local ``app.users`` row is written either by that admin flow (when it
ships) or lazily on the new user's first ``/auth/me``.

``provision_from_me`` is the lazy-upsert path. It handles:

* The bootstrap super admin from ``scripts/seed_cognito.sh``.
* Any admin-created user, if the admin module hasn't shipped yet (or
  failed to write the local row for any reason).
* Recovery: a user whose ``app.users`` row was deleted while the
  Cognito record remains gets transparently re-mirrored on next login.

The Cognito ``sub`` claim is the only stable identifier — emails can
change. We key off ``sub`` for both lookup and the UNIQUE constraint.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import repository as users_repo
from app.core.logging import get_logger
from app.models.identity import User

log = get_logger(__name__)


# The four canonical role codes — duplicated here from the migration's
# seed so a misconfigured Cognito ``custom:role`` falls back safely to
# ``read_only`` instead of taking down /me with a FK violation.
_VALID_ROLES: frozenset[str] = frozenset(
    {"super_admin", "admin", "operator", "read_only"},
)


def _safe_role(raw: str | None) -> str:
    return raw if raw in _VALID_ROLES else "read_only"


def _safe_initials(raw: str | None, fallback_email: str) -> str:
    if raw:
        return raw.strip().upper()[:8] or fallback_email[:2].upper()
    return fallback_email[:2].upper()


async def provision_from_me(
    session: AsyncSession,
    *,
    cognito_sub: str,
    cognito_attrs: dict[str, Any],
    username: str,
) -> User:
    """Lazy provisioning on /me. Always returns a User; never raises on
    "already exists". The Cognito attrs are the source of truth ONLY for
    the *initial* insert — once a local row exists, the local row wins
    (admins can change role / status without round-tripping to Cognito).
    """
    existing = await users_repo.get_by_cognito_sub(session, cognito_sub)
    if existing is not None:
        return existing

    email = cognito_attrs.get("email") or username
    full_name = cognito_attrs.get("name") or email
    initials = _safe_initials(cognito_attrs.get("custom:initials"), email)
    role = _safe_role(cognito_attrs.get("custom:role"))

    log.info(
        "auth.provision.lazy_create",
        cognito_sub=cognito_sub,
        role=role,
    )
    try:
        return await users_repo.create(
            session,
            cognito_sub=cognito_sub,
            email=email,
            full_name=full_name,
            initials=initials,
            role=role,
        )
    except IntegrityError:
        # Race: a concurrent request just provisioned the same sub.
        await session.rollback()
        winner = await users_repo.get_by_cognito_sub(session, cognito_sub)
        if winner is None:
            raise
        return winner
