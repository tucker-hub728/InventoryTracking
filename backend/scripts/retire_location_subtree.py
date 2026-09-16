"""Retire a whole room subtree that no longer has a screen (soft delete).

Retiring a module left its location rows behind. Materials Management, Cold
Storage and the Analytical Lab were removed on 2026-08-19 along with their
screens and seeds, but nothing deactivated the nodes they had already created.
On prod that left a ``room`` called "Materials Management" holding 32 active
nodes — a freezer group, a warehouse, 26 shelves and 3 freezer units — which:

  * the **Storage screen cannot draw**: it resolves its room by the ``STG``
    code, so a legacy room simply never appears; and
  * the **destination pickers CAN draw**: ``/location-nodes/freezer-tree``
    returns every room, and the picker only *sorts* rooms rather than filtering
    them, so those units are selectable as destinations right now; and
  * **still reserve their names installation-wide**. ``sub_location`` and
    ``shelf`` names are unique across the whole installation
    (``uq_location_nodes_unit_name_active``), because the name IS the client's
    equipment number. So a stranded ``T90020B`` blocks a real one from being
    created anywhere, with an error naming a group the operator cannot find.

This script retires such a subtree: ``is_active = false``, deepest node first.

SOFT, not hard, unlike ``renumber_production_areas``
---------------------------------------------------
Nothing is deleted. Soft delete is what the API's own ``DELETE
/location-nodes/{id}`` does, and it is the right shape here: ``node_label_map``
reads every node regardless of ``is_active``, so a retired location still names
itself on any historical row that references it, and the whole thing is undone
by setting the flag back.

It is also what frees the names: ``uq_location_nodes_unit_name_active`` and
``uq_location_nodes_parent_code`` are both partial on ``is_active`` (see
``loccode01``), so retiring a unit releases its name AND its code for immediate
re-use. That is the entire point of the exercise.

What blocks it
--------------
Active stock, and only active stock — ``lot_allocations`` on any node in the
subtree. Ledger history deliberately does NOT block, matching the rule the API
adopted on 2026-08-12: a soft-deleted node keeps naming itself on historical
movements, so history is not harmed by retiring it. Kit and ledger references
are REPORTED so the operator can see them, then the run proceeds.

Every flip writes an audit row (``actor_kind="system"``, attributed to a super
admin), because this is a 21 CFR Part 11 installation and a location change
made with raw SQL would leave no trace.

Usage (from backend/):
    uv run python -m scripts.retire_location_subtree --room-code MM
    uv run python -m scripts.retire_location_subtree --room-code MM --yes

    # APP_ENV=production additionally requires the DB name echoed back:
    uv run python -m scripts.retire_location_subtree --room-code MM \
        --confirm-production cellready_ims --yes

Targets a ROOT node by CODE, never by name: prod has three nodes named
"Materials Management" — this legacy room plus two ``storage_category`` nodes
the client is actively using — and matching on the name would blank the live
one.
"""

from __future__ import annotations

import argparse
import asyncio
import uuid

from app.audit import record_entity_change
from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_sessionmaker
from app.locations import repository as loc_repo
from app.models.locations import LocationNode
from scripts._location_seed import creator_id
from sqlalchemy import select, text

# Reported, not blocking — see the module docstring. Mirrors the FK list in
# ``renumber_production_areas`` minus the allocations, which block on their own.
_REFERENCING: tuple[tuple[str, str], ...] = (
    ("app.stock_movements", "from_location_node_id"),
    ("app.stock_movements", "to_location_node_id"),
    ("app.kits", "production_location_node_id"),
    ("app.kits", "output_location_node_id"),
    ("app.kit_lines", "source_location_node_id"),
    ("app.kit_lines", "return_location_node_id"),
    ("app.kanban_restock_requests", "kanban_node_id"),
)

# Depth-tagged so the retire order is deepest-first. Roots only: ``room`` is
# forced to be a root by ``ck_location_nodes_root_parentage``.
_SUBTREE_SQL = """
WITH RECURSIVE sub AS (
    SELECT id, 0 AS depth
    FROM meta.location_nodes
    WHERE code = :code AND parent_id IS NULL
    UNION ALL
    SELECT c.id, s.depth + 1
    FROM meta.location_nodes c
    JOIN sub s ON c.parent_id = s.id
)
SELECT id, depth FROM sub
"""


async def _subtree(session, code: str) -> list[tuple[uuid.UUID, int]]:
    rows = await session.execute(text(_SUBTREE_SQL), {"code": code})
    return [(r[0], r[1]) for r in rows]


async def _active_stock(session, ids: list[uuid.UUID]) -> int:
    return (
        await session.execute(
            text(
                "SELECT count(*) FROM app.lot_allocations "
                "WHERE is_active AND location_node_id = ANY(:ids)"
            ),
            {"ids": ids},
        )
    ).scalar_one()


async def _references(session, ids: list[uuid.UUID]) -> list[tuple[str, str, int]]:
    found: list[tuple[str, str, int]] = []
    for table, column in _REFERENCING:
        exists = (
            await session.execute(text("SELECT to_regclass(:t)"), {"t": table})
        ).scalar()
        if exists is None:
            continue
        sql = f"SELECT count(*) FROM {table} WHERE {column} = ANY(:ids)"  # noqa: S608
        count = (await session.execute(text(sql), {"ids": ids})).scalar_one()
        if count:
            found.append((table, column, int(count)))
    return found


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Retire a room subtree that no longer has a screen (soft delete)."
    )
    parser.add_argument(
        "--room-code",
        required=True,
        help="CODE of the root node to retire, e.g. MM. Never the name — prod "
        "has three nodes named 'Materials Management'.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually retire. Without it the script only prints the plan.",
    )
    parser.add_argument(
        "--confirm-production",
        metavar="HOST:PORT/DBNAME",
        default=None,
        help="Required when APP_ENV=production: echo back the exact target "
        "host:port/dbname (as printed on the 'Target DB' line) to authorise "
        "the change. Host-qualified because dev and prod share the database "
        "name cellready_ims.",
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    dsn = str(settings.database_url)
    target = dsn.rsplit("@", 1)[-1] if "@" in dsn else dsn
    is_prod = settings.app_env == Environment.production

    sessionmaker = get_sessionmaker()
    try:
        async with sessionmaker() as session:
            print(f"Environment : {settings.app_env.value}")
            print(f"Target DB   : {target}")
            print(f"Root code   : {args.room_code}")

            pairs = await _subtree(session, args.room_code)
            if not pairs:
                print(f"\nNothing to do — no root node with code '{args.room_code}'.")
                return 0

            depth_of = dict(pairs)
            ids = list(depth_of)
            nodes = (
                (await session.execute(select(LocationNode).where(LocationNode.id.in_(ids))))
                .scalars()
                .all()
            )
            # Deepest first: a parent cannot be retired while an ACTIVE child
            # still hangs off it (the API's own ``node_has_children`` rule).
            nodes.sort(key=lambda n: (-depth_of[n.id], n.node_type, n.name))
            active = [n for n in nodes if n.is_active]

            print(f"\nSubtree ({len(nodes)} node(s), {len(active)} active):")
            for n in nodes:
                mark = " " if n.is_active else "~"
                indent = "  " * depth_of[n.id]
                state = "" if n.is_active else "  [already inactive]"
                print(f"  {mark} {indent}{n.node_type:<14} {n.code:<10} {n.name}{state}")

            stock = await _active_stock(session, ids)
            if stock:
                print(f"\nREFUSING: {stock} active lot allocation(s) in this subtree.")
                print("Nothing was changed. Move or consume the stock first.")
                return 1

            refs = await _references(session, ids)
            if refs:
                # Not a blocker: a retired node still names itself on history.
                print("\nHistorical references (kept, and still resolve after retiring):")
                for table, column, count in refs:
                    print(f"  {count:>6}  {table}.{column}")
            print("\nNo active stock — safe to retire.")

            # Production gate: --yes alone is not enough. The echo is
            # HOST-QUALIFIED: dev and prod are BOTH named cellready_ims and dev
            # runs APP_ENV=production, so a bare database name would prove the
            # name rather than the environment and authorise either one.
            if is_prod and args.yes and args.confirm_production != target:
                print("\n!! PRODUCTION !!")
                print(
                    "REFUSING: APP_ENV=production requires "
                    f"--confirm-production {target} to authorise the change."
                )
                return 1

            if not args.yes:
                print(
                    f"\nDRY RUN — {len(active)} node(s) would be retired. "
                    "Re-run with --yes to apply."
                )
                return 0

            actor_id = await creator_id(session)
            for node in active:
                before = loc_repo.node_to_audit_snapshot(node)
                node.is_active = False
                await session.flush()
                await record_entity_change(
                    session,
                    actor_user_id=actor_id,
                    action="deleted",
                    subject_table="meta.location_nodes",
                    subject_id=node.id,
                    subject_label=node.name,
                    before=before,
                    after=loc_repo.node_to_audit_snapshot(node),
                    # A script, not a person clicking Delete. Part 11 wants the
                    # actor to be honest about that.
                    actor_kind="system",
                    context={"script": "retire_location_subtree", "root_code": args.room_code},
                )

            await session.commit()
            print(f"\nDone — retired {len(active)} node(s). No rows were deleted.")
            print("Their unit names and codes are now free for re-use.")
            return 0
    finally:
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(_run(_parse_args())))


if __name__ == "__main__":
    main()
