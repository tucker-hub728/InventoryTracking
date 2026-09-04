"""Retire the legacy placeholder production areas (``PROD-CR1``…``PROD-CR6``).

The app shipped six placeholder clean rooms named ``Clean Room One``…``Clean Room
Six``. On 2026-09-04 the client confirmed the real numbering — 101, 201, 301,
401, 501, 601 — so ``scripts/seed_production.py`` now carries ``PROD-CR101``…
``PROD-CR601``. This script removes the old rows so that seed can create the new
ones on a database that is NOT being fully reset.

Why a delete and not a rename
-----------------------------
``code`` has no mutation path anywhere in the API: ``NodeUpdateRequest`` accepts
``name`` only and is ``extra="forbid"``, and ``update_node_name`` assigns exactly
that one field. So ``PROD-CR1`` can never become ``PROD-CR101`` in place.

A rename would also be the *destructive* option, which is the opposite of the
intuition. The live UI resolves location names through ``node_label_map``, which
reads the CURRENT name — so renaming retroactively relabels every historical
movement. But the finance export deliberately reads the frozen
``stock_movements.from/to_location_path`` snapshots, and those rows sit behind
the ``tg_movements_immutable`` trigger, so the stale text can never be repaired.
Renaming would leave the UI and the export permanently disagreeing about where
material was. A delete cannot cause that: this script refuses outright if any
ledger row references the node (see below).

Why a HARD delete, unlike ``DELETE /location-nodes/{id}``
---------------------------------------------------------
The API soft-deletes (``is_active = false``, the row survives), which is right
when history points at the node. Here the point is to free the row entirely —
``uq_location_nodes_parent_code`` is partial on ``is_active``, so a soft-deleted
``PROD-CR1`` would linger forever holding a code nobody wants. A hard delete is
only reachable once nothing references the row, and every FK into
``meta.location_nodes`` is ``ON DELETE RESTRICT``, so the database is the
backstop behind the guard below.

Scope: ONLY rows whose ``flat_category = 'production'`` and whose code is in the
legacy list. An area a Super Admin added by hand (``PROD-<SLUG>``) is left alone.

Usage (from backend/):
    uv run python -m scripts.renumber_production_areas          # dry run
    uv run python -m scripts.renumber_production_areas --yes    # apply

    # APP_ENV=production additionally requires the DB name echoed back:
    uv run python -m scripts.renumber_production_areas --confirm-production cellready_ims --yes

Then, always:
    uv run python -m scripts.seed_production --yes

Run the seed AFTER this, never before: ``seed_flat`` skips a code that already
exists, so seeding first leaves you with twelve areas instead of six.
"""

from __future__ import annotations

import argparse
import asyncio

from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_engine
from sqlalchemy import text

# The placeholder codes this script retires. Both active and soft-deleted rows
# are taken: a previously soft-deleted PROD-CR1 still holds the code.
_LEGACY_CODES: tuple[str, ...] = (
    "PROD-CR1",
    "PROD-CR2",
    "PROD-CR3",
    "PROD-CR4",
    "PROD-CR5",
    "PROD-CR6",
)

# Every FK into meta.location_nodes, as (table, column). All are ON DELETE
# RESTRICT, so a surviving row here would abort the delete anyway — checking
# first turns a Postgres FK error into a readable refusal that names the table.
# ``parent_id`` is included because a Kanban node hangs off a production area.
_REFERENCING: tuple[tuple[str, str], ...] = (
    ("meta.location_nodes", "parent_id"),
    ("app.lot_allocations", "location_node_id"),
    ("app.stock_movements", "from_location_node_id"),
    ("app.stock_movements", "to_location_node_id"),
    ("app.kits", "production_location_node_id"),
    ("app.kits", "output_location_node_id"),
    ("app.kit_lines", "source_location_node_id"),
    ("app.kit_lines", "return_location_node_id"),
    ("app.kanban_restock_requests", "kanban_node_id"),
)


def _db_name(dsn: str) -> str:
    """Extract the database name from a DSN's path (``.../dbname?params``)."""
    tail = dsn.rsplit("/", 1)[-1]
    return tail.split("?", 1)[0]


async def _targets(conn) -> list[tuple[str, str, str, bool]]:
    """The legacy rows present, as ``(id, code, name, is_active)``."""
    rows = await conn.execute(
        text(
            """
            SELECT id, code, name, is_active
            FROM meta.location_nodes
            WHERE flat_category = 'production' AND code = ANY(:codes)
            ORDER BY code
            """
        ),
        {"codes": list(_LEGACY_CODES)},
    )
    return [(str(r[0]), r[1], r[2], r[3]) for r in rows]


async def _blockers(conn, ids: list[str]) -> list[tuple[str, str, int]]:
    """Rows still pointing at a target node, as ``(table, column, count)``."""
    found: list[tuple[str, str, int]] = []
    for table, column in _REFERENCING:
        # A table can legitimately be absent on an older database — skip rather
        # than crash, so this stays runnable across environments.
        exists = (
            await conn.execute(text("SELECT to_regclass(:t)"), {"t": table})
        ).scalar()
        if exists is None:
            continue
        sql = f"SELECT count(*) FROM {table} WHERE {column} = ANY(:ids)"  # noqa: S608
        count = (
            await conn.execute(text(sql), {"ids": ids})
        ).scalar_one()
        if count:
            found.append((table, column, int(count)))
    return found


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Delete the legacy PROD-CR1…PROD-CR6 production areas."
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually delete. Without it the script only prints the plan.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="DBNAME",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "database name to authorise the delete.",
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    dsn = str(settings.database_url)
    target = dsn.rsplit("@", 1)[-1] if "@" in dsn else dsn
    db_name = _db_name(dsn)
    is_prod = settings.app_env == Environment.production

    engine = get_engine()
    try:
        async with engine.begin() as conn:
            targets = await _targets(conn)
            if not targets:
                print("Nothing to do — no legacy PROD-CR1…PROD-CR6 areas present.")
                return 0

            print(f"Environment : {settings.app_env.value}")
            print(f"Target DB   : {target}")
            print(f"\nLegacy areas found ({len(targets)}):")
            for _id, code, name, active in targets:
                state = "active" if active else "inactive"
                print(f"  - {code:<12} {name:<20} [{state}]")

            ids = [t[0] for t in targets]
            blockers = await _blockers(conn, ids)
            if blockers:
                print("\nREFUSING: these areas are still referenced —")
                for table, column, count in blockers:
                    print(f"  {count:>6}  {table}.{column}")
                print(
                    "\nNothing was deleted. Clear the stock, kits and Kanban "
                    "children off these areas first, or reset the database."
                )
                return 1

            print("\nNo references — safe to delete.")

            # Production gate: --yes alone is not enough. NOTE the dev and prod
            # databases are BOTH named cellready_ims, so this echo proves the
            # name, not the environment — confirm which host you are on.
            if is_prod and args.yes and args.confirm_production != db_name:
                print("\n!! PRODUCTION !!")
                print(
                    "REFUSING: APP_ENV=production requires "
                    f"--confirm-production {db_name} to authorise the delete."
                )
                return 1

            if not args.yes:
                print(
                    f"\nDRY RUN — {len(targets)} area(s) would be deleted. "
                    "Re-run with --yes to apply."
                )
                return 0

            await conn.execute(
                text("DELETE FROM meta.location_nodes WHERE id = ANY(:ids)"),
                {"ids": ids},
            )
            print(f"\nDeleted {len(targets)} legacy area(s).")
            print("\nNext step")
            print("  python -m scripts.seed_production --yes   creates CR 101 … CR 601.")
            return 0
    finally:
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(_run(_parse_args())))


if __name__ == "__main__":
    main()
