"""Seed the Freezer + Warehouse location nodes.

These two areas started as frontend mock; this makes them real
``meta.location_nodes`` so unit-in (from Receipt Admin) and transfers can write
real allocations against them.

Structure (SRS 2026-07-09 §6):
    Freezer:  rooms + locations are seeded; freezer SUB-LOCATIONS are left
              empty (added on the Freezers page — they are variable T-number
              units, not a fixed set).
      Materials Management (room)
        Open-Inventory, -20°C Freezer 1/2/3   (locations, no sub-locations)
      Analytical Lab (room)
        -20°C Freezer, -80°C Freezer          (locations, no sub-locations)
    Warehouse: shelves are the fixed A–Z set, so they ARE seeded.
      Warehouse One (warehouse)        -> Shelf A … Shelf Z         (shelves)

Nodes need a creating user (``created_by_user_id`` is NOT NULL), so this runs as
a script after users exist — not in a migration. Idempotent: a node whose
(parent, code) already exists is skipped, so re-running is safe.

Usage (from backend/):
    uv run python -m scripts.seed_locations           # dry run — print the plan
    uv run python -m scripts.seed_locations --yes      # create the nodes
"""

from __future__ import annotations

import argparse
import asyncio
import string

from app.db.session import get_sessionmaker
from app.locations import repository as loc_repo
from app.models.identity import User
from sqlalchemy import select

# (node_type, code, name, children)
Node = tuple[str, str, str, list]


def _freezer_structure() -> list[Node]:
    # Sub-locations are intentionally empty — they're added on the Freezers page.
    return [
        (
            "room",
            "MM",
            "Materials Management",
            [
                ("room_location", "MM-OPEN", "Open-Inventory", []),
                ("room_location", "MM-F1", "-20°C Freezer 1", []),
                ("room_location", "MM-F2", "-20°C Freezer 2", []),
                ("room_location", "MM-F3", "-20°C Freezer 3", []),
            ],
        ),
        (
            "room",
            "AL",
            "Analytical Lab",
            [
                ("room_location", "AL-F20", "-20°C Freezer", []),
                ("room_location", "AL-F80", "-80°C Freezer", []),
            ],
        ),
    ]


def _warehouse_structure() -> list[Node]:
    shelves: list[Node] = [
        ("shelf", f"WH1-{letter}", f"Shelf {letter}", [])
        for letter in string.ascii_uppercase
    ]
    return [("warehouse", "WH1", "Warehouse One", shelves)]


async def _creator_id(session) -> object | None:
    """A user to own the seeded nodes — prefer a super_admin, else any user."""
    admin = (
        await session.execute(
            select(User).where(User.role == "super_admin").limit(1)
        )
    ).scalars().first()
    if admin is not None:
        return admin.id
    any_user = (await session.execute(select(User).limit(1))).scalars().first()
    return any_user.id if any_user is not None else None


async def _seed(session, nodes: list[Node], parent_id, creator_id, *, apply: bool) -> int:
    created = 0
    for node_type, code, name, children in nodes:
        existing = await loc_repo.get_sibling_by_code(
            session, parent_id=parent_id, code=code
        )
        if existing is not None:
            node_id = existing.id
            print(f"  = exists  {node_type:<13} {code:<10} {name}")
        elif apply:
            node = await loc_repo.create_node(
                session,
                node_type=node_type,
                code=code,
                name=name,
                created_by_user_id=creator_id,
                parent_id=parent_id,
            )
            node_id = node.id
            created += 1
            print(f"  + create  {node_type:<13} {code:<10} {name}")
        else:
            node_id = None
            created += 1
            print(f"  + would   {node_type:<13} {code:<10} {name}")
        # Recurse. In dry-run we can't know the parent id for un-created nodes,
        # so children of a would-be node are listed without a parent link.
        created += await _seed(session, children, node_id, creator_id, apply=apply)
    return created


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed Freezer + Warehouse locations.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the nodes. Without it the script prints the plan.",
    )
    args = parser.parse_args()

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        creator_id = await _creator_id(session)
        if creator_id is None:
            print(
                "REFUSING: no users exist yet to own the seeded nodes. "
                "Seed users first (scripts/seed_super_admins.py)."
            )
            return 1

        print("Freezer:")
        n1 = await _seed(
            session, _freezer_structure(), None, creator_id, apply=args.yes
        )
        print("Warehouse:")
        n2 = await _seed(
            session, _warehouse_structure(), None, creator_id, apply=args.yes
        )

        if args.yes:
            await session.commit()
            print(f"\nDone — created {n1 + n2} node(s).")
        else:
            print(
                f"\nDRY RUN — {n1 + n2} node(s) would be created. "
                "Re-run with --yes to apply."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
