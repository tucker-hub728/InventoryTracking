"""Remove EVERY user from Cognito and from the local ``app.users`` mirror.

A user lives in two places (Cognito owns the credentials, ``app.users`` owns app
state, joined by the Cognito ``sub``), so wiping "the users" means wiping both.
This script does both in one pass, in the order that actually works: local rows
first, then the Cognito identities.

Pair it with ``scripts/seed_super_admins.py`` to rebuild a clean single
super admin:

    python -m scripts.purge_users --yes
    python -m scripts.seed_super_admins --yes

WHY THIS CAN REFUSE
-------------------
Every foreign key pointing at ``app.users`` is ``ON DELETE RESTRICT`` — 29 of
them, from ``app.items.created_by_user_id`` to ``audit.audit_events.actor_user_id``.
That is deliberate: you must not be able to erase the person attached to a
signed movement or an audit row. So deleting users only succeeds on a database
whose *data* is already gone.

If anything still references a user, this script prints exactly which tables and
how many rows, then refuses. It does NOT cascade, and it does not try to disable
the append-only triggers on the ledger and audit tables — ``scripts/reset_db.py``
already does that correctly, in one transaction, and is the sanctioned way to
clear the data:

    python -m scripts.reset_db --yes      # wipes all data INCLUDING app.users
    python -m scripts.purge_users --yes   # then clears the Cognito identities

Run standalone (without reset_db) when the database is already empty, or when
users genuinely have no data attached — a fresh environment, or right after a
reset. In that case the local delete succeeds on its own.

Safety (mirrors scripts/reset_db.py):
  * Dry-run by default: prints exactly what it would delete and exits 0. You
    must pass ``--yes`` to actually mutate anything.
  * PRODUCTION requires a second, un-fumbleable confirmation: on top of
    ``--yes`` you must pass ``--confirm-production <pool-id>`` matching the
    target Cognito pool exactly. A wrong or absent value refuses.
  * Reuses app settings for both the DSN and the pool id — one source of truth.

This is irreversible. Deleting a Cognito identity destroys its credentials; the
``sub`` is not recoverable, so a re-created user is a different person as far as
every historical row is concerned.

Usage (from ``backend/``):
    python -m scripts.purge_users                                  # dry run
    python -m scripts.purge_users --yes                            # dev/staging
    python -m scripts.purge_users --yes --keep admin@example.com   # spare one
    python -m scripts.purge_users --yes --confirm-production us-east-1_ABC123

Exit codes: 0 = ok / dry-run, 1 = refused or aborted.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from app.auth.cognito_client import get_cognito_client
from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_engine
from botocore.exceptions import ClientError
from sqlalchemy import text

# Every table with an FK onto ``app.users``, and the column that points there.
# Used for the pre-flight blocker report. ``app.users.invited_by_user_id`` is
# omitted on purpose: it is the one FK with ON DELETE SET NULL, so a user
# inviting another user never blocks the purge.
_REFERENCING: tuple[tuple[str, str], ...] = (
    ("app.bom_lines", "created_by_user_id"),
    ("app.bom_lines", "updated_by_user_id"),
    ("app.customers", "created_by_user_id"),
    ("app.customers", "updated_by_user_id"),
    ("app.forecast_entries", "created_by_user_id"),
    ("app.forecast_entries", "updated_by_user_id"),
    ("app.item_prefixes", "created_by_user_id"),
    ("app.item_prefixes", "updated_by_user_id"),
    ("app.item_tiers", "created_by_user_id"),
    ("app.item_tiers", "updated_by_user_id"),
    ("app.items", "created_by_user_id"),
    ("app.items", "updated_by_user_id"),
    ("app.kits", "closed_by_user_id"),
    ("app.kits", "created_by_user_id"),
    ("app.kits", "issued_by_user_id"),
    ("app.kits", "updated_by_user_id"),
    ("app.lot_allocations", "created_by_user_id"),
    ("app.lots", "created_by_user_id"),
    ("app.lots", "updated_by_user_id"),
    ("app.receipt_events", "received_by_user_id"),
    ("app.receipt_transactions", "created_by_user_id"),
    ("app.receipt_transactions", "received_by_user_id"),
    ("app.stock_movements", "performed_by_user_id"),
    ("audit.audit_events", "actor_user_id"),
    ("audit.reauth_consumptions", "consumed_by_user_id"),
    ("audit.reauth_events", "user_id"),
    ("meta.item_suppliers", "created_by_user_id"),
    ("meta.location_nodes", "created_by_user_id"),
)

# Deleted before ``app.users``: its ``invited_by`` FK is RESTRICT, so a pending
# invitation would block the purge. Invitations are worthless without the users
# they belong to, so they go too rather than being reported as a blocker.
_CASCADE_FIRST = ("app.invitations",)


def _list_cognito_users(client: Any, pool_id: str) -> list[str]:
    """Every username in the pool, following pagination."""
    usernames: list[str] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"UserPoolId": pool_id, "Limit": 60}
        if token:
            kwargs["PaginationToken"] = token
        resp = client.list_users(**kwargs)
        for user in resp.get("Users", []):
            name = user.get("Username")
            if name:
                usernames.append(str(name))
        token = resp.get("PaginationToken")
        if not token:
            return usernames


async def _blockers(conn: Any, keep_subs: list[str]) -> list[tuple[str, str, int]]:
    """Rows that still point at a user we're about to delete.

    Counts only references to users being removed — a row owned by a ``--keep``
    user is not a blocker, since that user survives.
    """
    found: list[tuple[str, str, int]] = []
    for table, column in _REFERENCING:
        if keep_subs:
            sql = (
                f"SELECT count(*) FROM {table} t "  # noqa: S608 - fixed identifiers
                f"WHERE t.{column} IS NOT NULL AND t.{column} NOT IN "
                "(SELECT id FROM app.users WHERE cognito_sub = ANY(:keep))"
            )
            result = await conn.execute(text(sql), {"keep": keep_subs})
        else:
            sql = f"SELECT count(*) FROM {table} WHERE {column} IS NOT NULL"  # noqa: S608
            result = await conn.execute(text(sql))
        count = int(result.scalar_one())
        if count:
            found.append((table, column, count))
    return found


async def _purge(args: argparse.Namespace) -> int:
    settings = get_settings()
    pool_id = settings.cognito_user_pool_id
    if not pool_id:
        print(
            "REFUSING: Cognito is not configured (COGNITO_USER_POOL_ID unset). "
            "Run scripts/seed_cognito.sh and set it in .env first."
        )
        return 1

    is_prod = settings.app_env == Environment.production
    keep = {e.strip().lower() for e in args.keep if e.strip()}

    client = get_cognito_client()
    try:
        cognito_users = _list_cognito_users(client, pool_id)
    except ClientError as exc:
        print(f"REFUSING: could not list Cognito users — {exc}")
        return 1
    cognito_targets = [u for u in cognito_users if u.lower() not in keep]

    engine = get_engine()
    try:
        async with engine.begin() as conn:
            total = int(
                (await conn.execute(text("SELECT count(*) FROM app.users"))).scalar_one()
            )
            keep_subs: list[str] = []
            if keep:
                rows = await conn.execute(
                    text(
                        "SELECT cognito_sub FROM app.users "
                        "WHERE lower(email) = ANY(:keep)"
                    ),
                    {"keep": sorted(keep)},
                )
                keep_subs = [r[0] for r in rows]
            db_targets = total - len(keep_subs)

            print("Target")
            print(f"  environment   : {settings.app_env.value}")
            print(f"  cognito pool  : {pool_id}")
            print(f"  database      : {engine.url.database}")
            print()
            print("Would delete")
            print(f"  cognito users : {len(cognito_targets)} of {len(cognito_users)}")
            print(f"  app.users rows: {db_targets} of {total}")
            if keep:
                print(f"  keeping       : {', '.join(sorted(keep))}")
            print()

            blockers = await _blockers(conn, keep_subs)
            if blockers:
                print("REFUSING: these rows still reference a user being deleted")
                width = max(len(f"{t}.{c}") for t, c, _ in blockers)
                for table, column, count in blockers:
                    print(f"  {f'{table}.{column}':<{width}}  {count}")
                print()
                print(
                    "Every FK onto app.users is ON DELETE RESTRICT, by design — a signed\n"
                    "movement or audit row must keep its person. Clear the data first:\n"
                    "    python -m scripts.reset_db --yes    # wipes data INCLUDING app.users\n"
                    "then re-run this script to clear the Cognito identities."
                )
                return 1

            if not args.yes:
                print("Dry run — nothing deleted. Re-run with --yes to execute.")
                return 0

            if is_prod:
                if args.confirm_production != pool_id:
                    print("!! PRODUCTION !!")
                    print(
                        "REFUSING: APP_ENV=production requires "
                        f"--confirm-production {pool_id} to authorise purging a prod pool."
                    )
                    print(f"(got --confirm-production={args.confirm_production!r})")
                    return 1

            # ── Local rows first ────────────────────────────────────────────
            # If Cognito went first and the DB delete then failed, the mirror
            # would point at identities that no longer exist and nobody could
            # log in to fix it. This order fails safe: the DB is transactional,
            # so a problem here rolls back with Cognito still intact.
            for table in _CASCADE_FIRST:
                await conn.execute(text(f"DELETE FROM {table}"))  # noqa: S608
            if keep_subs:
                await conn.execute(
                    text("DELETE FROM app.users WHERE NOT (cognito_sub = ANY(:keep))"),
                    {"keep": keep_subs},
                )
            else:
                await conn.execute(text("DELETE FROM app.users"))
            print(f"✓ deleted {db_targets} app.users row(s)")
    finally:
        await dispose_engine()

    # ── Then the Cognito identities ─────────────────────────────────────────
    deleted = 0
    failed: list[tuple[str, str]] = []
    for username in cognito_targets:
        try:
            client.admin_delete_user(UserPoolId=pool_id, Username=username)
            deleted += 1
        except ClientError as exc:
            failed.append((username, str(exc)))
    print(f"✓ deleted {deleted} Cognito user(s)")
    for username, err in failed:
        print(f"  ! {username}: {err}")

    print()
    print("Next step")
    print("  python -m scripts.seed_super_admins --yes   # recreate one super admin")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Delete every user from Cognito and app.users.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually delete. Without this the script only prints the plan.",
    )
    parser.add_argument(
        "--keep",
        action="append",
        default=[],
        metavar="EMAIL",
        help="Spare this address (repeatable). Useful to keep your own login.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="POOL_ID",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "Cognito user pool id to authorise purging a prod pool.",
    )
    args = parser.parse_args()
    return asyncio.run(_purge(args))


if __name__ == "__main__":
    sys.exit(main())
