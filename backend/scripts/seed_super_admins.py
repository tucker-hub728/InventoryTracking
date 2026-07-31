"""Seed THE Super Admin into Cognito + the local ``app.users`` mirror.

Creates exactly one account, the one you name on the command line. This is the
bootstrap identity and the only super admin that is ever *created*: every other
member is invited, and any further super admin is made by PROMOTING an existing
active user through the Users page (REQ-2026-07-31-ROL-005).

CREDENTIALS are passed on the command line — ``--email`` and ``--password`` are
both REQUIRED. There is no default and no environment fallback, so the account
you type is the account you get. Note the password lands in your shell history.

A user in this system is a Cognito identity with a local mirror row:
  * Cognito owns the password / MFA (created via admin APIs here).
  * ``app.users`` owns app state and is keyed by the Cognito ``sub``.

So the user is provisioned in TWO places, and this script does both in one pass,
idempotently:

  1. Cognito ``admin_create_user`` (email pre-verified, invite email
     SUPPRESSED) then ``admin_set_user_password(..., Permanent=True)`` so the
     account can sign in immediately with no FORCE_CHANGE_PASSWORD challenge.
  2. Insert the ``app.users`` row with ``role='super_admin'`` using the ``sub``
     minted by Cognito.

Re-running is safe: an existing Cognito user is looked up (password re-applied),
and an existing local row for that ``sub`` is left as-is.

Pairs with ``scripts/purge_users.py`` for a clean auth reset:
    python -m scripts.purge_users --yes
    python -m scripts.seed_super_admins --yes --email you@example.com --password '...'

Safety:
  * Dry-run by default — prints the plan and exits. Pass ``--yes`` to execute.
  * PRODUCTION requires a second, un-fumbleable confirmation: on top of
    ``--yes`` you must pass ``--confirm-production <pool-id>`` where <pool-id>
    exactly matches the target Cognito user pool.
  * PRODUCTION also enforces a password policy, checked BEFORE anything is
    created so a prod pool is never half-seeded. The value that used to ship in
    ``.env.example`` is rejected outright there.

Usage (from ``backend/``):
    # Dry run — show the plan:
    python -m scripts.seed_super_admins --email superadmin@cellready.dev --password '...'
    # Create the user (dev/staging):
    python -m scripts.seed_super_admins --yes --email superadmin@cellready.dev --password '...'
    # Production also needs the pool id echoed back:
    python -m scripts.seed_super_admins --yes --email dan@example.com --password '...' \\
        --confirm-production us-east-1_ABC123
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

# ── The user to seed ────────────────────────────────────────────────────────
# ONE super admin. Everyone else is invited, and any further super admin is made
# by PROMOTING an existing active user (REQ-2026-07-31-ROL-005) — never by
# adding a row here.
#
# Credentials come from --email / --password ONLY. There is no default and no
# environment fallback, deliberately: a stored value is one nobody re-reads, and
# the first symptom is the account being seeded at the wrong address. Making
# both explicit at the call site means the account you type is the account you
# get, in every environment.
#
# The placeholder that used to ship in .env.example. Kept purely so the
# production gate can recognise and refuse it — anyone holding the repo knows it.
_PUBLISHED_PASSWORD = "ChangeMe!Now123"  # noqa: S105 - sentinel to refuse, not a credential


def _seed_users(args: argparse.Namespace) -> list[dict[str, str]]:
    """The single super admin to create, straight from the CLI arguments."""
    return [{"email": args.email.strip().lower(), "password": args.password}]


_ROLE = "super_admin"


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


def _full_name(email: str) -> str:
    """`admin@cellready.dev` -> `Super Admin (dev)` for a readable display name."""
    domain = email.split("@", 1)[-1]
    suffix = domain.rsplit(".", 1)[-1] if "." in domain else domain
    return f"Super Admin ({suffix})"


def _initials(email: str) -> str:
    return "SA"


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
    full_name: str,
    initials: str,
) -> tuple[str, bool]:
    """Create (or find) the Cognito user and set a permanent password.

    Returns ``(sub, created)``. Idempotent: if the user already exists we look
    it up instead of failing, then re-apply the password either way.
    """
    attributes = [
        {"Name": "email", "Value": email},
        {"Name": "email_verified", "Value": "true"},
        {"Name": "name", "Value": full_name},
        {"Name": "custom:role", "Value": _ROLE},
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
        # Most likely: the user already exists. Recover by fetching it. If the
        # lookup also fails, the original error was something else — re-raise it.
        try:
            got = client.admin_get_user(UserPoolId=pool_id, Username=email)
            sub = _extract_sub(got["UserAttributes"])
            created = False
        except ClientError:
            # The recovery lookup failed too; the original create error is the
            # meaningful one. `from None` drops the incidental lookup traceback.
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
    full_name: str,
    initials: str,
) -> tuple[Any, bool]:
    """Insert the ``app.users`` row if it isn't already mirrored. Caller commits."""
    existing = await users_repo.get_by_cognito_sub(session, sub)
    if existing is not None:
        # Re-running the seeder repairs the flag on an account that predates the
        # seedadmin01 migration, so an existing deployment gets the lock without
        # a manual UPDATE.
        if not existing.is_seed and not await users_repo.seed_admin_exists(session):
            existing.is_seed = True
        return existing, False
    user = await users_repo.create(
        session,
        cognito_sub=sub,
        email=email,
        full_name=full_name,
        initials=initials,
        role=_ROLE,
        # This is the permanent account: always super_admin, immutable email,
        # cannot be deactivated. At most one row may carry the flag.
        is_seed=not await users_repo.seed_admin_exists(session),
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
        "--email",
        required=True,
        help="Address of the super admin to create. Required — there is no default.",
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Password to set. Required — there is no default and no env fallback. "
        "Note it will appear in your shell history.",
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

    users = _seed_users(args)

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
            for u in users
            if (reason := _weak_password_reason(u["password"])) is not None
        ]
        # The old .env.example value is public — anyone with the repo has it.
        # Never let it reach a real pool, however strong it looks.
        if any(u["password"] == _PUBLISHED_PASSWORD for u in users):
            weak.append(
                (users[0]["email"], "is the published example value — choose a real one")
            )
        if weak:
            print("!! PRODUCTION !!")
            print("REFUSING: unusable password(s) — set SUPERADMIN_PASSWORD first:")
            for email, reason in weak:
                print(f"  - {email}: {reason}")
            return 1
        print("!! PRODUCTION super-admin seed AUTHORISED. !!\n")

    endpoint = str(settings.cognito_endpoint_url) if settings.cognito_endpoint_url else "AWS"
    print(f"Environment  : {settings.app_env.value}")
    print(f"Cognito pool : {pool_id}  (endpoint: {endpoint})")
    print(f"Role         : {_ROLE}")
    print("Users        :")
    for u in users:
        print(f"  - {u['email']:<28} name={_full_name(u['email'])!r} initials={_initials(u['email'])}")

    if not args.yes:
        print("\nDRY RUN — nothing created. Re-run with --yes to execute.")
        return 0

    client = get_cognito_client()
    sessionmaker = get_sessionmaker()

    exit_code = 0
    try:
        async with sessionmaker() as session:
            for u in users:
                email = u["email"]
                full_name = _full_name(email)
                initials = _initials(email)
                try:
                    sub, cog_created = _ensure_cognito_user(
                        client,
                        pool_id=pool_id,
                        email=email,
                        password=u["password"],
                        full_name=full_name,
                        initials=initials,
                    )
                    _, db_created = await _upsert_local_user(
                        session,
                        sub=sub,
                        email=email,
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
