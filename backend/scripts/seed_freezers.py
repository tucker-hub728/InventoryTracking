"""Seed the Freezer location tree from the client's "Freezer List.xlsx".

Maps the equipment list to our 3-level freezer structure:

    Room (department)  →  Location (temperature freezer)  →  Sub-location (unit)

Each spreadsheet row is one freezer UNIT: "<T-number+letter>  <temp>  <dept>",
e.g. "T90019A  -80°C  Materials Management". Per SRS 2026-07-09 §6 / LOC-003 the
freezer unit (the T-number + letter) is the storage leaf — no positions inside —
so each unit becomes a ``sub_location``. Units are grouped by department (room)
and temperature (location).

Data note: the sheet has one typo — "Material Management" (T90020C) — normalised
here to "Materials Management".

Structure derived from the 15 rows in the sheet:

    Materials Management
        -80°C Freezer : T90019A, T90019C, T90019E, T90019F, T90019G, T90019H
        -20°C Freezer : T90020B, T90020C, T90020D
    Analytical Lab
        -80°C Freezer : T90019D
        -20°C Freezer : T90020A
    Sterility Lab
        -80°C Freezer : T90019I, T90019J
    PD
        -80°C Freezer : T90019B
        -20°C Freezer : T90020E

Nodes need a creating user (``created_by_user_id`` is NOT NULL), so this runs as
a script after users exist — not in a migration. Idempotent: a node whose
(parent, code) already exists is skipped, so re-running is safe.

Usage (from backend/):
    uv run python -m scripts.seed_freezers            # dry run — print the plan
    uv run python -m scripts.seed_freezers --yes       # create the nodes
"""

from __future__ import annotations

import argparse
import asyncio

from app.db.session import get_sessionmaker
from app.locations import repository as loc_repo
from app.models.identity import User
from sqlalchemy import select

# room_code, room_name, [ (loc_code_suffix, loc_name, [unit_ids]) ]
FREEZERS: list[tuple[str, str, list[tuple[str, str, list[str]]]]] = [
    (
        "MM",
        "Materials Management",
        [
            (
                "F80",
                "-80°C",
                ["T90019A", "T90019C", "T90019E", "T90019F", "T90019G", "T90019H"],
            ),
            ("F20", "-20°C", ["T90020B", "T90020C", "T90020D"]),
        ],
    ),
    (
        "AL",
        "Analytical Lab",
        [
            ("F80", "-80°C", ["T90019D"]),
            ("F20", "-20°C", ["T90020A"]),
        ],
    ),
    # (
    #     "SL",
    #     "Sterility Lab",
    #     [
    #         ("F80", "-80°C Freezer", ["T90019I", "T90019J"]),
    #     ],
    # ),
    # (
    #     "PD",
    #     "PD",
    #     [
    #         ("F80", "-80°C Freezer", ["T90019B"]),
    #         ("F20", "-20°C Freezer", ["T90020E"]),
    #     ],
    # ),
]


async def _creator_id(session) -> object | None:
    """A user to own the seeded nodes — prefer a super_admin, else any user."""
    admin = (
        await session.execute(select(User).where(User.role == "super_admin").limit(1))
    ).scalars().first()
    if admin is not None:
        return admin.id
    any_user = (await session.execute(select(User).limit(1))).scalars().first()
    return any_user.id if any_user is not None else None


async def _ensure(
    session, *, node_type, code, name, parent_id, creator_id, apply: bool
) -> tuple[object | None, int]:
    """Create a node if a sibling with this code doesn't already exist."""
    existing = await loc_repo.get_sibling_by_code(session, parent_id=parent_id, code=code)
    if existing is not None:
        print(f"  = exists  {node_type:<13} {code:<10} {name}")
        return existing.id, 0
    if not apply:
        print(f"  + would   {node_type:<13} {code:<10} {name}")
        return None, 1
    node = await loc_repo.create_node(
        session,
        node_type=node_type,
        code=code,
        name=name,
        created_by_user_id=creator_id,
        parent_id=parent_id,
    )
    print(f"  + create  {node_type:<13} {code:<10} {name}")
    return node.id, 1


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed freezer locations from the sheet.")
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

        created = 0
        for room_code, room_name, locations in FREEZERS:
            room_id, n = await _ensure(
                session,
                node_type="room",
                code=room_code,
                name=room_name,
                parent_id=None,
                creator_id=creator_id,
                apply=args.yes,
            )
            created += n
            for loc_suffix, loc_name, units in locations:
                loc_id, n = await _ensure(
                    session,
                    node_type="room_location",
                    code=f"{room_code}-{loc_suffix}",
                    name=loc_name,
                    parent_id=room_id,
                    creator_id=creator_id,
                    apply=args.yes,
                )
                created += n
                for unit in units:
                    _, n = await _ensure(
                        session,
                        node_type="sub_location",
                        code=unit,
                        name=unit,
                        parent_id=loc_id,
                        creator_id=creator_id,
                        apply=args.yes,
                    )
                    created += n

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
