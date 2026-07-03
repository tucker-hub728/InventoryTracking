"""Wipe all data from the database while keeping the schema intact.

This app spreads its tables across several schemas (``app``, ``meta``,
``audit``) with only ``alembic_version`` + extensions in ``public``. Both
modes below are schema-aware and discover schemas dynamically:

  * default (TRUNCATE): empties every table across all application schemas
    (RESTART IDENTITY, CASCADE) but leaves ``alembic_version`` alone, so the
    Alembic history stays valid and you do NOT re-run migrations.
  * ``--schema``: DROPs the application schemas outright (app/meta/audit) and
    resets ``public`` (clearing ``alembic_version``). Extensions are recreated
    idempotently by the first migration, so pair it with ``--migrate`` (or run
    ``alembic upgrade head`` yourself) to rebuild everything from scratch.

Safety model (matches our "never auto-run destructive DB ops" policy):
  * Dry-run by default: prints exactly what it would wipe and exits 0. You
    must pass ``--yes`` to actually mutate data.
  * PRODUCTION requires a second, un-fumbleable confirmation: on top of
    ``--yes`` you must pass ``--confirm-production <dbname>`` where <dbname>
    exactly matches the target database. A wrong/absent name refuses. This
    makes a prod wipe impossible to trigger by a stray flag or wrong shell.
  * Reuses app settings/DSN — there is no second place to misconfigure a URL.

This is irreversible. Dropping/truncating a production database destroys all
data with no undo. Take a snapshot/backup first if there's any doubt.

Usage (from the ``backend/`` directory):
    python -m scripts.reset_db                           # dry run — shows the plan
    python -m scripts.reset_db --yes                     # wipe data (dev/staging)
    python -m scripts.reset_db --yes --schema            # DROP application schemas
    python -m scripts.reset_db --yes --schema --migrate  # ...then rebuild it in one go
    # Production also needs the DB name echoed back:
    python -m scripts.reset_db --yes --schema --migrate --confirm-production cellready_ims

Exit codes: 0 = ok / dry-run, 1 = refused or aborted.
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

from sqlalchemy import text

from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_engine

# Tables we never truncate: Alembic's bookkeeping. Wiping this would strand the
# DB at an unknown migration state and force a full re-migrate.
_PROTECTED_TABLES = {"alembic_version"}

# Schemas Postgres owns — never dropped/truncated. Everything else (app, meta,
# audit, public, …) is application-owned and fair game. Discovered dynamically
# so new module schemas are picked up automatically.
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")
# Safe to inline: fixed constant of known identifiers, never user input.
_SYSTEM_SCHEMAS_SQL = ", ".join(f"'{s}'" for s in _SYSTEM_SCHEMAS)


def _db_name(dsn: str) -> str:
    """Extract the database name from a DSN's path (``.../dbname?params``)."""
    tail = dsn.rsplit("/", 1)[-1]  # everything after the last '/'
    return tail.split("?", 1)[0]  # drop any query string


async def _list_user_schemas(conn) -> list[str]:
    """Return application-owned schemas (app, meta, audit, public, …)."""
    rows = await conn.execute(
        text(
            f"""
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ({_SYSTEM_SCHEMAS_SQL})
              AND schema_name NOT LIKE 'pg_temp%'
              AND schema_name NOT LIKE 'pg_toast_temp%'
            ORDER BY schema_name
            """
        )
    )
    return [r[0] for r in rows]


async def _list_tables(conn) -> list[str]:
    """Return every base table in application schemas as ``schema.table``,
    minus protected ones. Spans app/meta/audit/public — NOT just public."""
    rows = await conn.execute(
        text(
            f"""
            SELECT schemaname, tablename
            FROM pg_tables
            WHERE schemaname NOT IN ({_SYSTEM_SCHEMAS_SQL})
            ORDER BY schemaname, tablename
            """
        )
    )
    return [f"{s}.{t}" for s, t in rows if t not in _PROTECTED_TABLES]


async def _truncate_all(conn, tables: list[str]) -> None:
    """TRUNCATE every table in one statement so CASCADE/FK order is a non-issue.

    ``tables`` are ``schema.table`` strings; each part is quoted separately.
    """
    quoted = ", ".join(f'"{s}"."{t}"' for s, t in (x.split(".", 1) for x in tables))
    # RESTART IDENTITY resets sequences; CASCADE handles FK dependencies in one shot.
    await conn.execute(text(f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE"))


async def _drop_schemas(conn, schemas: list[str]) -> None:
    """Nuclear option: drop every application schema (dropping ``alembic_version``
    with ``public``), so ``alembic upgrade head`` rebuilds schemas + extensions +
    tables from scratch. ``public`` is recreated because Postgres expects it to
    exist; its extensions are re-created idempotently by the first migration.
    """
    for schema in schemas:
        # Quote to be safe; these come from the catalog, not user input.
        await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        if schema == "public":
            await conn.execute(text("CREATE SCHEMA public"))


def _run_migrations() -> int:
    """Run ``alembic upgrade head`` in a subprocess and return its exit code.

    Must run out-of-process: this script is already inside an asyncio loop and
    Alembic's ``env.py`` calls ``asyncio.run()`` itself, which would raise
    "cannot be called from a running event loop" if invoked in-process. The
    subprocess also gets its own DB engine, avoiding any pool reuse issues.

    ``-c`` points at ``backend/alembic.ini`` explicitly so this works no matter
    what the current working directory is.
    """
    ini_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    # sys.executable + "-m alembic" avoids depending on `alembic` being on PATH.
    cmd = [sys.executable, "-m", "alembic", "-c", str(ini_path), "upgrade", "head"]
    print(f"\nRunning: {' '.join(cmd)}")
    return subprocess.run(cmd, check=False).returncode


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wipe all data from the database.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually perform the wipe. Without this the script only prints the plan.",
    )
    parser.add_argument(
        "--schema",
        action="store_true",
        help="DROP the application schemas (app/meta/audit) + reset public "
        "instead of TRUNCATE. Wipes alembic_version — pair with --migrate.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="DBNAME",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "database name to authorise an irreversible prod wipe.",
    )
    parser.add_argument(
        "--migrate",
        action="store_true",
        help="After a --schema drop, automatically run `alembic upgrade head` "
        "to rebuild the schema — one command does the full reset.",
    )
    return parser.parse_args()


async def _reset(args: argparse.Namespace) -> int:
    """Perform the wipe. Returns an exit code; does NOT run migrations (that
    happens out-of-process in ``main`` after the engine is disposed)."""
    settings = get_settings()

    # DSN with credentials stripped so we never print a password. Everything
    # after the last '@' is host/port/db.
    dsn = str(settings.database_url)
    target = dsn.rsplit("@", 1)[-1] if "@" in dsn else dsn
    db_name = _db_name(dsn)
    is_prod = settings.app_env == Environment.production
    mode = "DROP application schemas" if args.schema else "TRUNCATE all tables"

    # ── Production gate: --yes is not enough; the DB name must be echoed back ─
    if is_prod and args.yes:
        if args.confirm_production != db_name:
            print("!! PRODUCTION !!")
            print(f"Target DB   : {target}")
            print(
                "REFUSING: APP_ENV=production requires "
                f"--confirm-production {db_name} to authorise an irreversible wipe."
            )
            print(f"(got --confirm-production={args.confirm_production!r})")
            return 1
        print("!! PRODUCTION WIPE AUTHORISED — this is irreversible. !!\n")

    engine = get_engine()
    try:
        async with engine.begin() as conn:
            tables = await _list_tables(conn)
            schemas = await _list_user_schemas(conn)

            print(f"Environment : {settings.app_env.value}")
            print(f"Target DB   : {target}")
            print(f"Mode        : {mode}")
            print(f"Schemas     : {', '.join(schemas) or '(none)'}")
            print(f"Tables ({len(tables)}) : {', '.join(tables) or '(none)'}")

            if not args.yes:
                print("\nDRY RUN — nothing changed. Re-run with --yes to execute.")
                return 0

            if args.schema:
                await _drop_schemas(conn, schemas)
                dropped = ", ".join(s for s in schemas if s != "public") or "(none)"
                print(f"\nDropped schemas: {dropped}; reset public. DB is EMPTY.")
                if not args.migrate:
                    print("Next: run `alembic upgrade head` to rebuild the schema "
                          "(or re-run with --migrate to do it automatically).")
            elif tables:
                await _truncate_all(conn, tables)
                print(f"\nDone. Truncated {len(tables)} table(s). Schema + migrations intact.")
            else:
                print("\nNothing to truncate.")
        return 0
    finally:
        await dispose_engine()


def main() -> int:
    args = _parse_args()
    code = asyncio.run(_reset(args))
    if code != 0:
        return code

    # Auto-migrate only after an executed schema drop. Runs in a fresh
    # subprocess now that the async engine above is fully disposed.
    if args.migrate and args.yes:
        if not args.schema:
            print("\n(--migrate ignored: only applies with --schema; "
                  "TRUNCATE leaves schema + migrations intact.)")
            return 0
        code = _run_migrations()
        print("\nSchema rebuilt." if code == 0 else "\nMigration FAILED — see alembic output above.")
    return code


if __name__ == "__main__":
    sys.exit(main())
