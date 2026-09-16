"""Wipe all data from the database while keeping the schema intact.

This app spreads its tables across several schemas (``app``, ``meta``,
``audit``) with only ``alembic_version`` + extensions in ``public``. Both
modes below are schema-aware and discover schemas dynamically:

  * default (TRUNCATE): empties every table across all application schemas
    (RESTART IDENTITY, CASCADE) but leaves ``alembic_version`` alone, so the
    Alembic history stays valid and you do NOT re-run migrations.
  * ``--keep-reference``: same, minus the reference tables in
    ``_REFERENCE_TABLES`` (users, suppliers, item tiers + prefixes). Runs
    WITHOUT CASCADE on purpose, so Postgres aborts rather than silently
    emptying a kept table that turns out to depend on a wiped one. Pair it
    with ``scripts/seed_production.py`` to rebuild the clean rooms — the only
    location seed there is; see ``_POST_TRUNCATE_NOTES`` for what nothing
    rebuilds (Storage and LN2 are both built in the app, by design).
  * ``--schema``: DROPs the application schemas outright (app/meta/audit) and
    resets ``public`` (clearing ``alembic_version``). Extensions are recreated
    idempotently by the first migration, so pair it with ``--migrate`` (or run
    ``alembic upgrade head`` yourself) to rebuild everything from scratch.

Safety model (matches our "never auto-run destructive DB ops" policy):
  * Dry-run by default: prints exactly what it would wipe and exits 0. You
    must pass ``--yes`` to actually mutate data.
  * PRODUCTION requires a second, un-fumbleable confirmation: on top of
    ``--yes`` you must pass ``--confirm-production <host:port/dbname>`` where
    that exactly matches the target. A wrong/absent value refuses. This makes a
    prod wipe impossible to trigger by a stray flag or wrong shell.

    The token is HOST-qualified on purpose. The dev and prod databases are BOTH
    named ``cellready_ims`` on BOTH RDS instances, and dev runs
    ``APP_ENV=production``, so a bare database name authorises a wipe of EITHER
    environment — it proves the name, not the host. Including the host makes the
    two tokens read ``cellready-dev…`` and ``cellready-prod…``, which cannot be
    confused. Note this also means running through an SSM port-forward tunnel
    masks the host (``host.docker.internal``): run this ON the target instance.
  * Reuses app settings/DSN — there is no second place to misconfigure a URL.

This is irreversible. Dropping/truncating a production database destroys all
data with no undo. Take a snapshot/backup first if there's any doubt.

Usage (from the ``backend/`` directory):
    python -m scripts.reset_db                           # dry run — shows the plan
    python -m scripts.reset_db --yes                     # wipe data (dev/staging)
    python -m scripts.reset_db --yes --keep-reference    # ...but keep users/suppliers/tiers
    python -m scripts.reset_db --yes --schema            # DROP application schemas
    python -m scripts.reset_db --yes --schema --migrate  # ...then rebuild it in one go
    # Production also needs the host-qualified target echoed back:
    python -m scripts.reset_db --yes --schema --migrate \
        --confirm-production cellready-prod.abc123.us-east-2.rds.amazonaws.com:5432/cellready_ims

Exit codes: 0 = ok / dry-run, 1 = refused or aborted.
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_engine
from sqlalchemy import text

# Tables we never truncate, in ANY mode. Matched on the bare table name.
#
#  * ``alembic_version`` — Alembic's bookkeeping. Wiping it strands the DB at an
#    unknown migration state and forces a full re-migrate.
#  * ``roles`` (``app.roles``) — four ``is_system`` lookup rows created AND
#    populated by the migration, so they are part of the schema contract rather
#    than data, the same as ``alembic_version``. Emptying them leaves a database
#    where no user can be created at all: ``app.users.role`` and
#    ``app.invitations.role`` are both FKs onto ``roles.code``, and no seed
#    script puts the rows back.
_PROTECTED_TABLES = {"alembic_version", "roles"}

# ``--keep-reference``: the hand-curated rows that are painful to recreate and
# that no seed script owns — the people, the approved suppliers, and the item
# tier/prefix taxonomy. Everything else is transactional or seedable, so a
# reference-preserving wipe empties it and lets the seed scripts rebuild.
#
# "Seedable" is not the same as "all of it comes back". Items and the LN2 tree do
# NOT — see ``_POST_TRUNCATE_NOTES``, which the script prints after a wipe so
# that is discovered before the wipe rather than after.
#
# ``meta.item_suppliers`` is deliberately NOT here: it links a supplier to an
# item, and every item is being wiped, so those rows would dangle.
# The catalogue taxonomy and the supplier list survive EVERY mode (client
# decision, 2026-07-31). They are admin-curated reference data — renamed tiers,
# added prefixes, a cleaned-up supplier list — and losing them on a routine data
# wipe breaks /inventory/cr ("The Raw Materials tier is missing from the
# catalogue") and the Tier admin screen.
#
# They can't simply join _PROTECTED_TABLES: ``item_tiers`` and ``item_prefixes``
# carry ``created_by_user_id`` / ``updated_by_user_id`` FKs onto ``app.users``,
# and ``TRUNCATE app.users CASCADE`` empties every table that references it —
# schema-level, regardless of whether any row actually points there. So excluding
# them from the truncate list is not enough; they are snapshotted before the wipe
# and re-inserted after. ``meta.suppliers`` has no FK to users and would survive
# on exclusion alone, but it rides the same path for one code route.
#
# Ordered parent-first: prefixes carry an FK onto tiers, so tiers restore first.
_PRESERVED_TABLES: tuple[str, ...] = (
    "app.item_tiers",
    "app.item_prefixes",
    "meta.suppliers",
)

# Columns dropped to NULL on restore: the users they pointed at are gone. Both
# are nullable precisely because a system seed has no human author.
_PRESERVE_NULL_COLUMNS = ("created_by_user_id", "updated_by_user_id")

# ``app.roles`` is deliberately absent — it moved to _PROTECTED_TABLES, so it
# survives every mode and no longer needs to be listed here to keep users valid.
_REFERENCE_TABLES = {
    "app.users",
    "app.item_tiers",
    "app.item_prefixes",
}

# Schemas Postgres owns — never dropped/truncated. Everything else (app, meta,
# audit, public, …) is application-owned and fair game. Discovered dynamically
# so new module schemas are picked up automatically.
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")
# Safe to inline: fixed constant of known identifiers, never user input.
_SYSTEM_SCHEMAS_SQL = ", ".join(f"'{s}'" for s in _SYSTEM_SCHEMAS)


# Tables whose GxP immutability triggers reject TRUNCATE outright ("append-only;
# reverse via counter-movement instead"). Those triggers are the point — the
# ledger and the audit trail must not be editable or erasable in normal
# operation — and a reset is the single sanctioned exception. So they are
# disabled for the duration of the wipe and re-enabled in the same transaction,
# which means a failure part-way rolls the disable back with everything else.
#
# The ledger cannot simply be spared, either: ``app.stock_movements`` has FKs
# into ``meta.location_nodes``, so keeping it would block the location wipe.
_IMMUTABLE_TABLES = (
    "app.stock_movements",
    "audit.audit_events",
    "audit.reauth_events",
    "audit.reauth_consumptions",
)

# Printed after a TRUNCATE so the operator learns what a wipe costs while they
# still remember running it. Two of these are permanent losses on a dev box, and
# both used to be found out days later.
_POST_TRUNCATE_NOTES = """
Next steps
  scripts/seed_production.py --yes  rebuilds the six clean rooms (07-22-LOC-003).
    That is the ONLY location seed there is.

NOT rebuilt by any seed - recreate these yourself
  * Storage locations. Nothing seeds them: the server creates the STG room when
    a Super Admin adds the first location, and the sub-types are added after
    that, by kind (LOC-001). Build them in the app.
  * The LN2 tree (tanks, quadrants, racks, boxes). LN2 is NEVER seeded: the tank
    numbers are the client's, so tanks are always created by a user on the LN2
    page. A wipe destroys the whole cascade and nothing brings it back.
  * Items, their BOM lines and supplier links. No item seed exists - import with
    scripts/sync-from-xlsx.py, or add them in the app. Smoke tests that expect an
    item will fail until one exists.
  * The audit trail and e-signature evidence. Gone for good; that is the one
    sanctioned exception to the append-only guarantee.

alembic_version was left alone, so the schema and migration history are intact
and there is nothing to re-migrate.
"""


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


async def _set_user_triggers(conn, tables: list[str], *, enabled: bool) -> None:
    """Enable/disable the USER triggers on ``tables`` (``schema.table`` strings).

    ``DISABLE TRIGGER USER`` leaves Postgres' own internal FK triggers running,
    so referential integrity is still enforced while the immutability guards are
    off. Requires table ownership, which the app's migration role has.
    """
    verb = "ENABLE" if enabled else "DISABLE"
    for qualified in tables:
        schema, table = qualified.split(".", 1)
        await conn.execute(text(f'ALTER TABLE "{schema}"."{table}" {verb} TRIGGER USER'))


async def _snapshot(conn, tables: tuple[str, ...]) -> dict[str, tuple[str, int]]:
    """Copy the preserved tables into TEMP tables before the wipe.

    Deliberately a pure in-database copy — ``CREATE TEMP TABLE … AS SELECT *``
    rather than reading rows into Python. Round-tripping through the driver means
    every column type has to survive being decoded and re-encoded, and JSONB does
    not: ``meta.suppliers.address`` comes back as a ``dict`` that asyncpg then
    refuses to send as a bind parameter. Keeping the data inside Postgres sidesteps
    type marshalling entirely and stays correct if a column is added later.

    ``ON COMMIT DROP`` ties the temp tables to this transaction, so they vanish
    whether the wipe commits or rolls back.
    """
    temps: dict[str, tuple[str, int]] = {}
    for index, qualified in enumerate(tables):
        schema, table = qualified.split(".", 1)
        tmp = f"_preserved_{index}"
        await conn.execute(
            text(
                f'CREATE TEMP TABLE "{tmp}" ON COMMIT DROP AS '
                f'SELECT * FROM "{schema}"."{table}"'
            )
        )
        # The users these point at are about to be deleted, and the FKs are
        # RESTRICT — so blank them in the copy. Both columns are nullable
        # precisely because a system seed has no human author.
        for col in _PRESERVE_NULL_COLUMNS:
            present = (
                await conn.execute(
                    text(
                        "SELECT 1 FROM information_schema.columns "
                        "WHERE table_schema = :s AND table_name = :t "
                        "AND column_name = :c"
                    ),
                    {"s": schema, "t": table, "c": col},
                )
            ).first()
            if present:
                await conn.execute(text(f'UPDATE "{tmp}" SET "{col}" = NULL'))
        count = (
            await conn.execute(text(f'SELECT count(*) FROM "{tmp}"'))
        ).scalar_one()
        temps[qualified] = (tmp, int(count))
    return temps


async def _restore(conn, temps: dict[str, tuple[str, int]]) -> list[str]:
    """Copy the snapshotted rows back after the wipe.

    Rows keep their original ids, so anything that referenced a tier, prefix or
    supplier by id still resolves. Insert order follows ``_PRESERVED_TABLES``
    (parent-first), so the prefix → tier FK is satisfied.
    """
    summary: list[str] = []
    for qualified, (tmp, count) in temps.items():
        if not count:
            continue
        schema, table = qualified.split(".", 1)
        await conn.execute(
            text(f'INSERT INTO "{schema}"."{table}" SELECT * FROM "{tmp}"')
        )
        summary.append(f"{qualified} ({count})")
    return summary


async def _truncate_all(conn, tables: list[str], *, cascade: bool = True) -> None:
    """TRUNCATE every table in one statement so CASCADE/FK order is a non-issue.

    ``tables`` are ``schema.table`` strings; each part is quoted separately.

    ``cascade=False`` is what ``--keep-reference`` uses, and the omission is the
    safety mechanism rather than an oversight: without CASCADE, Postgres refuses
    the statement if any table NOT in the list has a foreign key into one that
    is. So if a table we meant to keep turns out to depend on a table we are
    wiping, the wipe aborts with that table named — instead of CASCADE silently
    emptying it too.
    """
    quoted = ", ".join(f'"{s}"."{t}"' for s, t in (x.split(".", 1) for x in tables))
    # RESTART IDENTITY resets sequences.
    suffix = " CASCADE" if cascade else ""
    await conn.execute(text(f"TRUNCATE TABLE {quoted} RESTART IDENTITY{suffix}"))


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
        "--keep-reference",
        action="store_true",
        help="Truncate everything EXCEPT users, suppliers and the item "
        "tier/prefix taxonomy, so the seed scripts can rebuild the rest. "
        "Cannot be combined with --schema (which drops those tables too).",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="HOST:PORT/DBNAME",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "host:port/dbname (as printed on the dry run's 'Target DB' line) to "
        "authorise an irreversible prod wipe. Host-qualified because dev and "
        "prod share the database name cellready_ims.",
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
    is_prod = settings.app_env == Environment.production

    if args.schema and args.keep_reference:
        print(
            "REFUSING: --keep-reference and --schema are contradictory — "
            "dropping the schemas destroys the very tables --keep-reference preserves."
        )
        return 1

    if args.schema:
        mode = "DROP application schemas"
    elif args.keep_reference:
        mode = "TRUNCATE all tables EXCEPT reference data"
    else:
        mode = "TRUNCATE all tables"

    # ── Production gate: --yes is not enough; the HOST-QUALIFIED target must be
    # echoed back. Comparing the bare database name would authorise a wipe of
    # either environment: dev and prod are both `cellready_ims` and dev runs
    # APP_ENV=production, so the name proves nothing about which host you are
    # pointed at. `target` is host:port/dbname, so the two tokens differ.
    if is_prod and args.yes:
        if args.confirm_production != target:
            print("!! PRODUCTION !!")
            print(f"Target DB   : {target}")
            print(
                "REFUSING: APP_ENV=production requires "
                f"--confirm-production {target} to authorise an irreversible wipe."
            )
            print(f"(got --confirm-production={args.confirm_production!r})")
            return 1
        print("!! PRODUCTION WIPE AUTHORISED — this is irreversible. !!\n")

    engine = get_engine()
    try:
        async with engine.begin() as conn:
            tables = await _list_tables(conn)
            schemas = await _list_user_schemas(conn)

            kept: list[str] = []
            if args.keep_reference:
                kept = sorted(t for t in tables if t in _REFERENCE_TABLES)
                tables = [t for t in tables if t not in _REFERENCE_TABLES]
                # A reference table named here but absent from the DB means the
                # keep-list has drifted from the schema — say so rather than
                # quietly preserving less than the operator expects.
                missing = sorted(_REFERENCE_TABLES - set(kept))
                if missing:
                    print(
                        "REFUSING: these reference tables are in the keep-list but "
                        f"do not exist in this database: {', '.join(missing)}. "
                        "Update _REFERENCE_TABLES before running."
                    )
                    return 1

            print(f"Environment : {settings.app_env.value}")
            print(f"Target DB   : {target}")
            print(f"Mode        : {mode}")
            print(f"Schemas     : {', '.join(schemas) or '(none)'}")
            if kept:
                print(f"Keeping ({len(kept)}) : {', '.join(kept)}")
            print(f"Tables ({len(tables)}) : {', '.join(tables) or '(none)'}")

            if not args.yes:
                # Show the cost in the DRY RUN too — that is the run where it can
                # still change the operator's mind.
                if not args.schema:
                    print(_POST_TRUNCATE_NOTES)
                print("DRY RUN — nothing changed. Re-run with --yes to execute.")
                return 0

            if args.schema:
                await _drop_schemas(conn, schemas)
                dropped = ", ".join(s for s in schemas if s != "public") or "(none)"
                print(f"\nDropped schemas: {dropped}; reset public. DB is EMPTY.")
                if not args.migrate:
                    print("Next: run `alembic upgrade head` to rebuild the schema "
                          "(or re-run with --migrate to do it automatically).")
            elif tables:
                guarded = [t for t in _IMMUTABLE_TABLES if t in set(tables)]
                if guarded:
                    print(
                        "\n!! Temporarily disabling GxP immutability triggers on: "
                        f"{', '.join(guarded)}"
                    )
                    await _set_user_triggers(conn, guarded, enabled=False)
                # Snapshot inside the same transaction as the truncate, so a
                # failure anywhere rolls back to the original rows rather than
                # leaving the catalogue half-restored.
                preserved = tuple(t for t in _PRESERVED_TABLES if t in set(tables))
                snap = await _snapshot(conn, preserved)
                try:
                    await _truncate_all(conn, tables, cascade=not args.keep_reference)
                    restored = await _restore(conn, snap)
                    if restored:
                        print(f"   …preserved: {', '.join(restored)}")
                finally:
                    # Re-enabled inside the same transaction, so an exception
                    # above rolls the disable back rather than leaving the
                    # ledger unguarded.
                    if guarded:
                        await _set_user_triggers(conn, guarded, enabled=True)
                        print("   …immutability triggers re-enabled.")
                print(f"\nDone. Truncated {len(tables)} table(s). Schema + migrations intact.")
                if kept:
                    print(f"Preserved {len(kept)} reference table(s): {', '.join(kept)}")
                print(_POST_TRUNCATE_NOTES)
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
