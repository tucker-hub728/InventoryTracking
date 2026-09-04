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
    SEED_USER_PASSWORD='…' python -m scripts.seed_users --user you@example:admin
    ...and again with --yes to create them (dev/staging only)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any

from app.auth import repository as users_repo
from app.auth.cognito_client import get_cognito_client
from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_sessionmaker
from botocore.exceptions import ClientError

# dev credentials — this script refuses to run against production.
# NO user list, and no passwords. Both used to live here as a literal, which
# put working logins for every seeded environment into version control — public
# the moment the repo is cloned, and identical on every box that ran this
# script. "It is only a dev password" is not a mitigation; it is the reason the
# same string ends up in a staging box nobody re-seeded.
#
# Who gets seeded is now given per run, on the command line, and the password
# comes from the environment so it never reaches shell history or ``ps``:
#
#     SEED_USER_PASSWORD='…' python -m scripts.seed_users --yes \
#         --user you@example:admin
#
# ``--user`` repeats. One password covers the batch, which is right for what
# this is — throwaway dev logins created together — and each is set PERMANENT
# in Cognito so the account signs in immediately.

_ASSIGNABLE_ROLES = {"admin", "operator", "read_only"}

#: Populated from --user at run time; never a literal in this file.
_USERS: list[dict[str, str]] = []


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


def _collect_users(specs: list[str]) -> bool:
    """Fill ``_USERS`` from ``--user EMAIL:ROLE`` plus the password in the
    environment. ``False`` (having explained why) if the run is not usable.

    The password is read here and nowhere else, and it is never echoed — not in
    the plan, not in the per-user OK line. A seeding script that prints the
    credential it just set has published it to the terminal scrollback and any
    CI log capturing the job.
    """
    password = os.environ.get("SEED_USER_PASSWORD", "")
    if not password:
        print("REFUSING: SEED_USER_PASSWORD is not set.")
        print(
            "\nThis script stores no credentials. Supply one for the run — from the\n"
            "environment rather than an argument, so it stays out of shell history:\n\n"
            "    SEED_USER_PASSWORD='…' python -m scripts.seed_users --yes \\\n"
            "        --user you@example:admin\n"
        )
        return False

    _USERS.clear()
    for spec in specs:
        email, _, role = spec.partition(":")
        if not email.strip() or not role.strip():
            print(f"REFUSING: --user {spec!r} is not EMAIL:ROLE.")
            return False
        _USERS.append({"email": email.strip(), "role": role.strip(), "password": password})

    if not _USERS:
        print("REFUSING: no --user given. Nothing to seed.")
        print("\n    --user you@example:admin   (repeatable)")
        return False
    return True


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed dev/staging test users.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the users. Without this the script only prints the plan.",
    )
    parser.add_argument(
        "--user",
        action="append",
        default=[],
        metavar="EMAIL:ROLE",
        help="Repeatable. Role is one of: admin, operator, read_only.",
    )
    args = parser.parse_args()

    if not _collect_users(args.user):
        return 1

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
