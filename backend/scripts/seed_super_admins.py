"""Seed the single Super Admin user into Cognito + the local ``app.users`` mirror.

Only the super admin is seeded here — the fixed singleton that bootstraps the
system. Every other user (admin / operator) is onboarded through the in-app
invite flow, never this script.

A user in this system is a Cognito identity with a local mirror row:
  * Cognito owns the password / MFA (created via admin APIs here).
  * ``app.users`` owns app state and is keyed by the Cognito ``sub``.

So each user is provisioned in TWO places, and this script does both in one
pass, idempotently:

  1. Cognito ``admin_create_user`` (email pre-verified, invite email
     SUPPRESSED) then ``admin_set_user_password(..., Permanent=True)`` so the
     account can sign in immediately with no FORCE_CHANGE_PASSWORD challenge.
  2. Insert the ``app.users`` row with ``role='super_admin'`` using the ``sub``
     minted by Cognito.

Re-running is safe: an existing Cognito user is looked up (password re-applied),
and an existing local row for that ``sub`` is left as-is.

This is not a cross-environment seeder — it seeds into whatever Cognito pool +
database the current environment points at. Run it once per environment against
that environment's config.

Safety:
  * Dry-run by default — prints the plan and exits. Pass ``--yes`` to execute.
  * PRODUCTION requires a second, un-fumbleable confirmation: on top of
    ``--yes`` you must pass ``--confirm-production <pool-id>`` where <pool-id>
    exactly matches the target Cognito user pool.
  * PRODUCTION also enforces a password policy — any weak password in the list
    (e.g. the ``unlock`` dev defaults) is refused BEFORE anything is created,
    so trivially-guessable super-admins can never land in a real pool. Edit
    ``_USERS`` with strong, unique passwords (or export them from a secret
    store) before seeding prod.

Usage (from ``backend/``):
    python -m scripts.seed_super_admins            # dry run — show the plan
    python -m scripts.seed_super_admins --yes      # create the super admin (dev/staging)
    # Production also needs the pool id echoed back:
    python -m scripts.seed_super_admins --yes --confirm-production us-east-1_ABC123
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

# ── User to seed ────────────────────────────────────────────────────────────
# This seeder creates ONLY the single super admin (the fixed singleton). Every
# other user — admin or operator — is onboarded through the in-app invite flow,
# not here. Change the email/name below and set a strong, unique password
# (ideally from a secret store) before seeding a real environment.
_USERS: list[dict[str, str]] = [
    {
        "email": "superadmin@cellready.local",
        "password": "HzZcZuIA2kKWjusP_96",
        "first_name": "Super",
        "last_name": "Admin",
        "role": "super_admin",
    },
]

# This seeder writes ONLY super_admin — admins/operators come via the invite
# flow. Any other role in _USERS is refused before anything is created.
_ALLOWED_ROLES = frozenset({"super_admin"})


def _weak_password_reason(password: str) -> str | None:
    """Return why ``password`` is too weak for prod, or None if it passes.

    Mirrors AWS Cognito's default password policy (>=8 chars with upper, lower,
    digit, and symbol) so we fail fast here with a clear message instead of
    getting an opaque InvalidPasswordException mid-run — or, worse, succeeding
    against a laxly-configured pool and leaving a guessable super-admin.
    """
    checks = (
        (len(password) >= 8, "at least 8 characters"),
        (any(c.islower() for c in password), "a lowercase letter"),
        (any(c.isupper() for c in password), "an uppercase letter"),
        (any(c.isdigit() for c in password), "a digit"),
        (any(not c.isalnum() for c in password), "a symbol"),
    )
    missing = [need for ok, need in checks if not ok]
    return "must contain " + ", ".join(missing) if missing else None


def _display_name(first_name: str, last_name: str) -> str:
    """Cognito ``name`` attribute — the human label shown in Cognito tooling."""
    return f"{first_name} {last_name}".strip()


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
    display_name: str,
    role: str,
) -> tuple[str, bool]:
    """Create (or find) the Cognito user and set a permanent password.

    Returns ``(sub, created)``. Idempotent: if the user already exists we look
    it up instead of failing, then re-apply the password either way.
    """
    attributes = [
        {"Name": "email", "Value": email},
        {"Name": "email_verified", "Value": "true"},
        {"Name": "name", "Value": display_name},
        {"Name": "custom:role", "Value": role},
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
        # Most likely: the user already exists. Recover by fetching it. If the
        # lookup also fails, the original error was something else — re-raise it.
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
    first_name: str,
    last_name: str,
    role: str,
) -> tuple[Any, bool]:
    """Insert the ``app.users`` row if it isn't already mirrored. Caller commits."""
    existing = await users_repo.get_by_cognito_sub(session, sub)
    if existing is not None:
        return existing, False
    user = await users_repo.create(
        session,
        cognito_sub=sub,
        email=email,
        first_name=first_name,
        last_name=last_name,
        role=role,
        is_active=True,
    )
    return user, True


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed Super Admin users.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the users. Without this the script only prints the plan.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="POOL_ID",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "Cognito user pool id to authorise seeding a prod pool.",
    )
    args = parser.parse_args()

    settings = get_settings()

    pool_id = settings.cognito_user_pool_id
    client_id = settings.cognito_client_id
    if not pool_id or not client_id:
        print(
            "REFUSING: Cognito is not configured "
            "(COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID unset). "
            "Run scripts/seed_cognito.sh and set them in .env first."
        )
        return 1

    is_prod = settings.app_env == Environment.production

    # Fail fast on a mistyped role before touching Cognito or the DB.
    bad_roles = sorted({u["role"] for u in _USERS} - _ALLOWED_ROLES)
    if bad_roles:
        print(
            "REFUSING: _USERS contains role(s) this seeder won't write: "
            f"{', '.join(bad_roles)} (allowed: {', '.join(sorted(_ALLOWED_ROLES))})."
        )
        return 1

    # ── Production gate: --yes is not enough; the pool id must be echoed back ─
    if is_prod and args.yes:
        if args.confirm_production != pool_id:
            print("!! PRODUCTION !!")
            print(f"Target pool : {pool_id}")
            print(
                "REFUSING: APP_ENV=production requires "
                f"--confirm-production {pool_id} to authorise seeding a prod pool."
            )
            print(f"(got --confirm-production={args.confirm_production!r})")
            return 1
        # Refuse weak passwords BEFORE touching Cognito — don't half-seed.
        weak = [
            (u["email"], reason)
            for u in _USERS
            if (reason := _weak_password_reason(u["password"])) is not None
        ]
        if weak:
            print("!! PRODUCTION !!")
            print("REFUSING: weak password(s) — edit _USERS with strong values first:")
            for email, reason in weak:
                print(f"  - {email}: {reason}")
            return 1
        print("!! PRODUCTION super-admin seed AUTHORISED. !!\n")

    endpoint = str(settings.cognito_endpoint_url) if settings.cognito_endpoint_url else "AWS"
    print(f"Environment  : {settings.app_env.value}")
    print(f"Cognito pool : {pool_id}  (endpoint: {endpoint})")
    print("Users        :")
    for u in _USERS:
        display = _display_name(u["first_name"], u["last_name"])
        print(f"  - {u['email']:<28} name={display!r} role={u['role']}")

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
                display_name = _display_name(u["first_name"], u["last_name"])
                try:
                    sub, cog_created = _ensure_cognito_user(
                        client,
                        pool_id=pool_id,
                        email=email,
                        password=u["password"],
                        display_name=display_name,
                        role=u["role"],
                    )
                    _, db_created = await _upsert_local_user(
                        session,
                        sub=sub,
                        email=email,
                        first_name=u["first_name"],
                        last_name=u["last_name"],
                        role=u["role"],
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
