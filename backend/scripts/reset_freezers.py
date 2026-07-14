"""Reset the Freezer location tree to match the sheet.

Hard-deleting freezer nodes is impossible once a freezer has any GxP ledger
history: ``app.stock_movements`` is immutable (append-only, protected by
triggers) and its rows reference the node, so the node can't be removed. That's
by design for audit compliance.

So this does the audit-safe equivalent of a wipe-and-reseed:

  1. **Retire** every current freezer node (``is_active = false``) — they drop
     out of the Freezers page and all active listings; their ledger history
     stays intact.
  2. **Reconcile** to the sheet structure (``scripts/seed_freezers.FREEZERS``):
     for each target node, reactivate the existing one with that (parent, code)
     if present, else create it. Nodes not in the sheet stay retired (hidden).

Scope — freezer area ONLY: node types ``room`` / ``room_location`` /
``sub_location``. LN2 (tank_quadrant … box) and Warehouse (warehouse / shelf)
are never touched. Nothing is ever deleted, so there are no FK surprises.

Idempotent: re-running lands on the same active tree.

Usage (from backend/):
    uv run python -m scripts.reset_freezers            # dry run — show the plan
    uv run python -m scripts.reset_freezers --yes       # retire old + activate sheet

On prod:
    sudo docker exec <backend-container> python -m scripts.reset_freezers --yes
"""

from __future__ import annotations

import argparse
import asyncio

from app.db.session import get_sessionmaker
from app.locations import repository as loc_repo
from app.models.locations import LocationNode
from scripts.seed_freezers import FREEZERS, _creator_id
from sqlalchemy import func, select, update

FREEZER_TYPES = ("room", "room_location", "sub_location")


async def _active_count(session) -> int:
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(LocationNode)
                .where(
                    LocationNode.node_type.in_(FREEZER_TYPES),
                    LocationNode.is_active.is_(True),
                )
            )
        ).scalar_one()
    )


async def _reconcile(
    session, *, node_type, code, name, parent_id, creator_id
) -> tuple[object, str]:
    """Reactivate the existing (parent, code) node or create it. Returns (id, action)."""
    existing = await loc_repo.get_sibling_by_code(session, parent_id=parent_id, code=code)
    if existing is not None:
        existing.is_active = True
        existing.name = name
        await session.flush()
        return existing.id, "reactivate"
    node = await loc_repo.create_node(
        session,
        node_type=node_type,
        code=code,
        name=name,
        created_by_user_id=creator_id,
        parent_id=parent_id,
    )
    return node.id, "create"


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Retire old freezer nodes and activate the sheet structure."
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually apply. Without it the script prints the plan.",
    )
    args = parser.parse_args()

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        active_before = await _active_count(session)
        target_n = sum(
            1 + sum(1 + len(units) for _, _, units in locs) for _, _, locs in FREEZERS
        )
        print(f"Active freezer nodes now : {active_before}")
        print(f"Sheet target nodes       : {target_n}")

        if not args.yes:
            print(
                "\nDRY RUN — would retire all current freezer nodes and activate "
                f"the {target_n} sheet nodes (reusing any with matching codes). "
                "Re-run with --yes to apply."
            )
            return 0

        creator_id = await _creator_id(session)
        if creator_id is None:
            print("REFUSING: no users exist to own the reseeded nodes.")
            return 1

        # 1) Retire every freezer node.
        retired = await session.execute(
            update(LocationNode)
            .where(
                LocationNode.node_type.in_(FREEZER_TYPES),
                LocationNode.is_active.is_(True),
            )
            .values(is_active=False)
        )
        print(f"\nRetired {retired.rowcount} freezer node(s).")

        # 2) Reconcile to the sheet — reactivate/create the target tree.
        reactivated = created = 0
        print("Activating sheet structure:")
        for room_code, room_name, locations in FREEZERS:
            room_id, act = await _reconcile(
                session,
                node_type="room",
                code=room_code,
                name=room_name,
                parent_id=None,
                creator_id=creator_id,
            )
            reactivated += act == "reactivate"
            created += act == "create"
            print(f"  {act:<10} room          {room_code:<8} {room_name}")
            for loc_suffix, loc_name, units in locations:
                loc_id, act = await _reconcile(
                    session,
                    node_type="room_location",
                    code=f"{room_code}-{loc_suffix}",
                    name=loc_name,
                    parent_id=room_id,
                    creator_id=creator_id,
                )
                reactivated += act == "reactivate"
                created += act == "create"
                print(f"  {act:<10} room_location {room_code}-{loc_suffix:<4} {loc_name}")
                for unit in units:
                    _, act = await _reconcile(
                        session,
                        node_type="sub_location",
                        code=unit,
                        name=unit,
                        parent_id=loc_id,
                        creator_id=creator_id,
                    )
                    reactivated += act == "reactivate"
                    created += act == "create"
                    print(f"  {act:<10} sub_location  {unit}")

        await session.commit()
        print(
            f"\nDone — retired {retired.rowcount}, then activated {target_n} sheet "
            f"nodes ({created} created, {reactivated} reactivated). "
            "Old non-sheet freezer nodes remain retired (hidden)."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
