"""Seed ordinary (non-super-admin) test users into Cognito + ``app.users``.

This is the LOCAL/DEV replacement for the invite flow. The production invite
flow (``POST /v1/invitations``) has Cognito email a temporary password via SES;
cognito-local can't deliver mail, so instead of surfacing that password anywhere
this script provisions ready-to-use accounts directly — mirroring how
``scripts.seed_super_admins`` bootstraps the super admins.

Each user is provisioned in TWO places, idempotently, in one pass:

  1. Cognito ``admin_create_user`` (email pre-verified, invite email SUPPRESSED)
     then ``admin_set_user_password(..., Permanent=True)`` so the account signs in
     immediately with a KNOWN password — no ``FORCE_CHANGE_PASSWORD`` challenge and
     no temporary password to email, log, or return.
  2. Insert the ``app.users`` row with the requested role, keyed by the Cognito
     ``sub``.

Re-running is safe: an existing Cognito user is looked up (password re-applied),
and an existing local row for that ``sub`` is left as-is.

Safety:
  * Dry-run by default — prints the plan and exits. Pass ``--yes`` to execute.
  * REFUSES to run against production. This is a dev/staging convenience for
    seeding known-password logins; real users onboard through the invite flow so
    their credential is set by them and never known to us. Production user
    creation must go through ``POST /v1/invitations``.

Usage (from ``backend/``):
    python -m scripts.seed_users            # dry run — show the plan
    python -m scripts.seed_users --yes      # create the users (dev/staging only)
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from app.auth import repository as users_repo
from app.auth.cognito_client import get_cognito_client
from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_sessionmaker
from botocore.exceptions import ClientError

# ── Users to seed ───────────────────────────────────────────────────────────
# Edit this list to change who gets seeded. Roles: admin | operator | read_only.
# (Super admins are seeded by scripts.seed_super_admins.) Passwords are known
# dev credentials — this script refuses to run against production.
_USERS: list[dict[str, str]] = [
    {"email": "admin.user@cellready.dev", "role": "admin", "password": "DevAdmin_123!"},
    {"email": "operator@cellready.dev", "role": "operator", "password": "DevOperator_123!"},
    {"email": "readonly@cellready.dev", "role": "read_only", "password": "DevReadOnly_123!"},
]

_ASSIGNABLE_ROLES = {"admin", "operator", "read_only"}


def _full_name(email: str) -> str:
    """`operator@cellready.dev` -> `Operator` for a readable display name."""
    local = email.split("@", 1)[0]
    return local.replace(".", " ").replace("_", " ").title() or email


def _initials(email: str) -> str:
    parts = _full_name(email).split()
    letters = parts[0][:1] + (parts[-1][:1] if len(parts) > 1 else parts[0][1:2])
    return (letters.upper()[:8] or "?").strip() or "?"


def _extract_sub(attributes: list[dict[str, str]]) -> str:
    for a in attributes:
        if a.get("Name") == "sub":
            return a["Value"]
    raise RuntimeError("Cognito returned no 'sub' attribute for the user")


def _ensure_cognito_user(
    client: Any,
    *,
    pool_id: str,
    email: str,
    password: str,
    role: str,
    full_name: str,
    initials: str,
) -> tuple[str, bool]:
    """Create (or find) the Cognito user and set a permanent password.

    Returns ``(sub, created)``. Idempotent: if the user already exists we look it
    up instead of failing, then re-apply the password either way.
    """
    attributes = [
        {"Name": "email", "Value": email},
        {"Name": "email_verified", "Value": "true"},
        {"Name": "name", "Value": full_name},
        {"Name": "custom:role", "Value": role},
        {"Name": "custom:initials", "Value": initials},
    ]
    try:
        resp = client.admin_create_user(
            UserPoolId=pool_id,
            Username=email,
            MessageAction="SUPPRESS",  # no invite email — we set the password directly
            UserAttributes=attributes,
        )
        sub = _extract_sub(resp["User"]["Attributes"])
        created = True
    except ClientError as exc:
        try:
            got = client.admin_get_user(UserPoolId=pool_id, Username=email)
            sub = _extract_sub(got["UserAttributes"])
            created = False
        except ClientError:
            raise exc from None

    # Permanent password => account is immediately usable, no reset challenge.
    client.admin_set_user_password(
        UserPoolId=pool_id,
        Username=email,
        Password=password,
        Permanent=True,
    )
    return sub, created


async def _upsert_local_user(
    session: Any,
    *,
    sub: str,
    email: str,
    role: str,
    full_name: str,
    initials: str,
) -> tuple[Any, bool]:
    """Insert the ``app.users`` row if it isn't already mirrored. Caller commits."""
    existing = await users_repo.get_by_cognito_sub(session, sub)
    if existing is not None:
        return existing, False
    user = await users_repo.create(
        session,
        cognito_sub=sub,
        email=email,
        full_name=full_name,
        initials=initials,
        role=role,
    )
    return user, True


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed dev/staging test users.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the users. Without this the script only prints the plan.",
    )
    args = parser.parse_args()

    settings = get_settings()

    # Hard refusal on production — known-password seeding is a dev/staging aid.
    if settings.app_env == Environment.production:
        print(
            "REFUSING: seed_users is dev/staging only. In production, create users "
            "via the invite flow (POST /v1/invitations) so their credential is set "
            "by them and never known to us."
        )
        return 1

    bad_roles = [u for u in _USERS if u["role"] not in _ASSIGNABLE_ROLES]
    if bad_roles:
        print("REFUSING: _USERS has invalid role(s) — allowed: admin, operator, read_only:")
        for u in bad_roles:
            print(f"  - {u['email']}: role={u['role']!r}")
        return 1

    pool_id = settings.cognito_user_pool_id
    client_id = settings.cognito_client_id
    if not pool_id or not client_id:
        print(
            "REFUSING: Cognito is not configured "
            "(COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID unset). "
            "Run scripts/seed_cognito.sh and set them in .env first."
        )
        return 1

    endpoint = str(settings.cognito_endpoint_url) if settings.cognito_endpoint_url else "AWS"
    print(f"Environment  : {settings.app_env.value}")
    print(f"Cognito pool : {pool_id}  (endpoint: {endpoint})")
    print("Users        :")
    for u in _USERS:
        print(
            f"  - {u['email']:<28} role={u['role']:<10} "
            f"name={_full_name(u['email'])!r} initials={_initials(u['email'])}"
        )

    if not args.yes:
        print("\nDRY RUN — nothing created. Re-run with --yes to execute.")
        return 0

    client = get_cognito_client()
    sessionmaker = get_sessionmaker()

    exit_code = 0
    try:
        async with sessionmaker() as session:
            for u in _USERS:
                email = u["email"]
                role = u["role"]
                full_name = _full_name(email)
                initials = _initials(email)
                try:
                    sub, cog_created = _ensure_cognito_user(
                        client,
                        pool_id=pool_id,
                        email=email,
                        password=u["password"],
                        role=role,
                        full_name=full_name,
                        initials=initials,
                    )
                    _, db_created = await _upsert_local_user(
                        session,
                        sub=sub,
                        email=email,
                        role=role,
                        full_name=full_name,
                        initials=initials,
                    )
                    cog = "created" if cog_created else "exists"
                    db = "created" if db_created else "exists"
                    print(f"  OK  {email:<28} cognito={cog:<7} db_row={db:<7} sub={sub}")
                except Exception as exc:
                    exit_code = 1
                    print(f"  FAIL {email:<28} {type(exc).__name__}: {exc}")
            await session.commit()
        print("\nDone." if exit_code == 0 else "\nDone with errors (see FAIL rows above).")
        return exit_code
    finally:
        await dispose_engine()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
