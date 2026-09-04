"""Renumber the production clean rooms in ONE command (2026-09-04).

Retires the legacy placeholder areas ``PROD-CR1``…``PROD-CR6`` (``Clean Room
One``…``Six``) together with their empty child nodes, then creates the client's
real numbering ``PROD-CR101``…``PROD-CR601`` (``CR 101``…``CR 601``).

Delete and create in ONE transaction, on purpose
------------------------------------------------
This was originally two scripts — this one to delete, ``seed_production`` to
create — and that split caused a live incident on prod (2026-09-04): the delete
refused (a Kanban child blocked it), but both commands had been queued in the
shell, so the seed ran anyway and the environment ended up with TWELVE areas.
``seed_flat`` skips a code that already exists, so it could not detect that the
delete had failed.

Making it one transaction removes the failure mode rather than documenting it:
either the old areas go and the new ones arrive, or nothing changes at all.

``seed_production.py`` stays a pure, additive seed — it is what runs after
``reset_db.py``, where there is nothing to delete. This script imports its area
list, so the two can never disagree about the six rooms.

Why delete rather than rename
-----------------------------
``code`` has no mutation path anywhere in the API: ``NodeUpdateRequest`` accepts
``name`` only and is ``extra="forbid"``. ``PROD-CR1`` can never become
``PROD-CR101`` in place.

A rename would also be the *destructive* option, which is the opposite of the
intuition. The live UI resolves names through ``node_label_map``, which reads the
CURRENT name, so a rename retroactively relabels every historical movement —
while the finance export deliberately reads the FROZEN
``stock_movements.from/to_location_path`` snapshots, which sit behind the
``tg_movements_immutable`` trigger and can never be repaired. The two would
disagree forever. A delete cannot cause that: this script refuses outright if a
single ledger row references anything it is about to remove.

Why a HARD delete, unlike ``DELETE /location-nodes/{id}``
---------------------------------------------------------
The API soft-deletes (``is_active = false``, the row survives), which is right
when history points at the node. Here the point is to free the row entirely —
a soft-deleted ``PROD-CR1`` would sit on the old code forever, and its
``parent_id`` would still pin the child that blocks the parent's removal.

Child nodes go too
------------------
A production area's only permitted child is a Kanban bin (``PARENT_OF``). Those
are deleted with their room, but ONLY once proven empty: a Kanban holds no
``lot_allocations`` by design, so "empty" means nothing in the guard list below
points at it either. Children are deleted before their parents, because every FK
into ``meta.location_nodes`` is ``ON DELETE RESTRICT``.

Idempotent, and safe to run anywhere. With no legacy areas present it simply
ensures the six current rooms exist, which is what it does on a freshly reset
database.

Usage (from backend/):
    uv run python -m scripts.renumber_production_areas          # dry run
    uv run python -m scripts.renumber_production_areas --yes    # apply

    # APP_ENV=production additionally requires the DB name echoed back:
    uv run python -m scripts.renumber_production_areas --confirm-production cellready_ims --yes
"""

from __future__ import annotations

import argparse
import asyncio

from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_sessionmaker
from scripts._location_seed import creator_id, seed_flat
from scripts.seed_production import FLAT_CATEGORY, PRODUCTION_AREAS
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
#
# ``meta.location_nodes.parent_id`` is handled separately in ``_blockers``: rows
# pointing INTO the delete set from inside it are the children we are removing
# on purpose, so only a reference from OUTSIDE the set is a blocker.
_REFERENCING: tuple[tuple[str, str], ...] = (
    ("app.lot_allocations", "location_node_id"),
    ("app.stock_movements", "from_location_node_id"),
    ("app.stock_movements", "to_location_node_id"),
    ("app.kits", "production_location_node_id"),
    ("app.kits", "output_location_node_id"),
    ("app.kit_lines", "source_location_node_id"),
    ("app.kit_lines", "return_location_node_id"),
    ("app.kanban_restock_requests", "kanban_node_id"),
)

_NODES = "meta.location_nodes"


def _db_name(dsn: str) -> str:
    """Extract the database name from a DSN's path (``.../dbname?params``)."""
    tail = dsn.rsplit("/", 1)[-1]
    return tail.split("?", 1)[0]


async def _legacy_areas(session) -> list[tuple[str, str, str, bool]]:
    """The legacy rooms present, as ``(id, code, name, is_active)``."""
    rows = await session.execute(
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


async def _children(session, parent_ids: list[str]) -> list[tuple[str, str, str, str]]:
    """Direct children of the legacy rooms, as ``(id, code, name, node_type)``."""
    rows = await session.execute(
        text(
            """
            SELECT c.id, c.code, c.name, c.node_type
            FROM meta.location_nodes c
            WHERE c.parent_id = ANY(:ids)
            ORDER BY c.name
            """
        ),
        {"ids": parent_ids},
    )
    return [(str(r[0]), r[1], r[2], r[3]) for r in rows]


async def _blockers(session, doomed: list[str]) -> list[tuple[str, str, int]]:
    """Rows outside the delete set still pointing into it, as (table, column, n)."""
    found: list[tuple[str, str, int]] = []

    # Anything hanging off a node we are about to delete that is NOT itself in
    # the set — a grandchild. Nothing can currently parent under a Kanban, but
    # refusing beats discovering that assumption is stale via an FK error.
    orphaned = (
        await session.execute(
            text(
                "SELECT count(*) FROM meta.location_nodes "
                "WHERE parent_id = ANY(:ids) AND id <> ALL(:ids)"
            ),
            {"ids": doomed},
        )
    ).scalar_one()
    if orphaned:
        found.append((_NODES, "parent_id", int(orphaned)))

    for table, column in _REFERENCING:
        # A table can legitimately be absent on an older database — skip rather
        # than crash, so this stays runnable across environments.
        exists = (
            await session.execute(text("SELECT to_regclass(:t)"), {"t": table})
        ).scalar()
        if exists is None:
            continue
        sql = f"SELECT count(*) FROM {table} WHERE {column} = ANY(:ids)"  # noqa: S608
        count = (await session.execute(text(sql), {"ids": doomed})).scalar_one()
        if count:
            found.append((table, column, int(count)))
    return found


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Renumber the production clean rooms to CR 101…CR 601."
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually apply. Without it the script only prints the plan.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="DBNAME",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "database name to authorise the change.",
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    dsn = str(settings.database_url)
    target = dsn.rsplit("@", 1)[-1] if "@" in dsn else dsn
    db_name = _db_name(dsn)
    is_prod = settings.app_env == Environment.production

    sessionmaker = get_sessionmaker()
    try:
        async with sessionmaker() as session:
            print(f"Environment : {settings.app_env.value}")
            print(f"Target DB   : {target}")

            areas = await _legacy_areas(session)
            kids = await _children(session, [a[0] for a in areas]) if areas else []
            doomed = [a[0] for a in areas] + [k[0] for k in kids]

            if areas:
                print(f"\nLegacy areas to remove ({len(areas)}):")
                for _id, code, name, active in areas:
                    state = "active" if active else "inactive"
                    print(f"  - {code:<12} {name:<20} [{state}]")
                if kids:
                    print(f"\nTheir child nodes, removed with them ({len(kids)}):")
                    for _id, code, name, node_type in kids:
                        print(f"  - {code:<12} {name:<20} ({node_type})")

                blockers = await _blockers(session, doomed)
                if blockers:
                    print("\nREFUSING: these nodes are still referenced —")
                    for table, column, count in blockers:
                        print(f"  {count:>6}  {table}.{column}")
                    print(
                        "\nNothing was changed. Clear the stock, kits and restock "
                        "requests off them first, or reset the database."
                    )
                    return 1
                print("\nNo references — safe to delete.")
            else:
                print("\nNo legacy PROD-CR1…PROD-CR6 areas present — nothing to remove.")

            # Production gate: --yes alone is not enough. NOTE the dev and prod
            # databases are BOTH named cellready_ims, so this echo proves the
            # name, not the environment — confirm which host you are on.
            if is_prod and args.yes and args.confirm_production != db_name:
                print("\n!! PRODUCTION !!")
                print(
                    "REFUSING: APP_ENV=production requires "
                    f"--confirm-production {db_name} to authorise the change."
                )
                return 1

            if args.yes and doomed:
                # Children first: every FK into location_nodes is RESTRICT, so a
                # parent cannot go while its child still points at it.
                if kids:
                    await session.execute(
                        text("DELETE FROM meta.location_nodes WHERE id = ANY(:ids)"),
                        {"ids": [k[0] for k in kids]},
                    )
                await session.execute(
                    text("DELETE FROM meta.location_nodes WHERE id = ANY(:ids)"),
                    {"ids": [a[0] for a in areas]},
                )
                print(f"\nDeleted {len(areas)} area(s) and {len(kids)} child node(s).")

            owner_id = await creator_id(session)
            if owner_id is None:
                print(
                    "\nREFUSING: no users exist yet to own the seeded nodes. "
                    "Seed users first (scripts/seed_super_admins.py)."
                )
                return 1

            print("\nProduction areas:")
            created = await seed_flat(
                session,
                PRODUCTION_AREAS,
                owner_id,
                flat_category=FLAT_CATEGORY,
                apply=args.yes,
            )

            if args.yes:
                await session.commit()
                print(f"\nDone — removed {len(areas)}, created {created}.")
            else:
                print(
                    f"\nDRY RUN — {len(areas)} area(s) and {len(kids)} child node(s) "
                    f"would be removed, {created} created. Re-run with --yes to apply."
                )
            return 0
    finally:
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(_run(_parse_args())))


if __name__ == "__main__":
    main()
