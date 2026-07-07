"""Bridge Cognito identities into local ``app.users`` rows.

This is an internal platform — users are created by admins (via Cognito's
``admin-create-user``) and the local ``app.users`` row is written either by
that admin flow or lazily on the new user's first ``/auth/me``.

``provision_from_me`` is the lazy-upsert path. It handles:

* The bootstrap super admin from ``scripts/seed_super_admins.py``.
* Any admin-created user, if the admin module hasn't written the row.
* Recovery: a user whose ``app.users`` row was deleted while the Cognito
  record remains gets transparently re-mirrored on next login.

The Cognito ``sub`` claim is the only stable identifier — emails can
change. We key off ``sub`` for both lookup and the UNIQUE constraint.

Week-1 reset (2026-07-06): the row carries ``first_name`` / ``last_name`` /
``role`` / ``is_active``. The Cognito ``name`` attribute is split
best-effort into first / last; ``custom:role`` seeds the role (falling back
to ``operator``).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import repository as users_repo
from app.core.logging import get_logger
from app.models.identity import ROLES, User

log = get_logger(__name__)

# Fallback role for a misconfigured Cognito ``custom:role`` so lazy /me
# provisioning never fails the CHECK constraint.
_DEFAULT_ROLE = "operator"


def _safe_role(raw: str | None) -> str:
    return raw if raw in ROLES else _DEFAULT_ROLE


def _split_name(raw: str | None, *, fallback_email: str) -> tuple[str, str]:
    """Split a Cognito ``name`` into (first_name, last_name), best-effort.

    First whitespace token becomes ``first_name``; the remainder becomes
    ``last_name``. A single token leaves ``last_name`` blank-ish; a missing
    name falls back to the email local-part.
    """
    name = (raw or "").strip()
    if not name:
        name = fallback_email.split("@", 1)[0]
    parts = name.split()
    if not parts:  # pragma: no cover — email local-part is never empty here
        return fallback_email, ""
    first = parts[0]
    last = " ".join(parts[1:])
    return first, last


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
    (admins can change role / active flag without round-tripping to Cognito).
    """
    existing = await users_repo.get_by_cognito_sub(session, cognito_sub)
    if existing is not None:
        return existing

    email = cognito_attrs.get("email") or username
    first_name, last_name = _split_name(
        cognito_attrs.get("name"), fallback_email=email
    )
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
            first_name=first_name,
            last_name=last_name,
            role=role,
        )
    except IntegrityError:
        # Race: a concurrent request just provisioned the same sub.
        await session.rollback()
        winner = await users_repo.get_by_cognito_sub(session, cognito_sub)
        if winner is None:
            raise
        return winner
