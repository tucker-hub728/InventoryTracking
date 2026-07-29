"""Seed the Materials Management location tree (REQ-2026-07-15-LOC-005/006).

One shape, three levels — the same everywhere:

    Room (what LOC-005 calls a "location category")
      → Location (an area in that room)
        → Sub-location (the free-storage leaf; stock lands here)

Materials Management holds two PEER locations. They are different node types
only so the UI can tab between them — structurally they hang off the same room:

    Materials Management                        room
      Warehouse One                             warehouse   (ambient)
        Shelf A … Shelf Z                       shelf       26 leaves
      Minus-20 Freezers                         room_location (Cold Storage)
        T90020B, T90020C, T90020D               sub_location  the equipment units

Rules this seed honours:
  * Nothing below shelf level — no bins, positions or slots (LOC-005).
  * Nothing inside a freezer unit; placement is by physical labeling (LOC-006).
  * A unit's name is free text following the client's equipment numbering
    (T-number + suffix). Nothing here parses or validates it — the suffixes
    B/C/D below are the client's current values, not a permitted set (LOC-006).
  * "Open inventory" is descriptive language only and appears nowhere — the
    ambient shelving IS Warehouse One (LOC-005). The old ``MM-OPEN`` node and
    its Shelf A/B/C are gone, along with the duplicate ``MM-F1/F2/F3``.

Cold Storage (LOC-002) also covers −80 °C freezers and 2–8 °C refrigerators.
Only the −20 °C units are seeded: the client removed the −80 °C group from
scope on 2026-07-29, and the refrigerator list is still outstanding (LOC-004).
Both are added on the Materials Management page when they arrive.

Analytical Lab was deleted from scope on 2026-07-29 (client) and is not seeded.

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

# The client's −20 °C units in the Materials Management room, from their
# equipment list. Free text — never parsed (LOC-006).
MINUS_20_UNITS: tuple[str, ...] = ("T90020B", "T90020C", "T90020D")


def _materials_management() -> list[Node]:
    """Materials Management: Warehouse One + Minus-20 Freezers, as peers."""
    shelves: list[Node] = [
        ("shelf", f"WH1-{letter}", f"Shelf {letter}", [])
        for letter in string.ascii_uppercase
    ]
    cold_units: list[Node] = [
        ("sub_location", unit, unit, []) for unit in MINUS_20_UNITS
    ]
    return [
        (
            "room",
            "MM",
            "Materials Management",
            [
                ("warehouse", "WH1", "Warehouse One", shelves),
                ("room_location", "MM-F20", "Minus-20 Freezers", cold_units),
            ],
        ),
    ]


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
    parser = argparse.ArgumentParser(
        description="Seed the Materials Management location tree."
    )
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

        print("Materials Management:")
        created = await _seed(
            session, _materials_management(), None, creator_id, apply=args.yes
        )

        if args.yes:
            await session.commit()
            print(f"\nDone — created {created} node(s).")
        else:
            print(
                f"\nDRY RUN — {created} node(s) would be created. "
                "Re-run with --yes to apply."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
