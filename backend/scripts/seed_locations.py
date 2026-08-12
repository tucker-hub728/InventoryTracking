"""Seed every location area, in order. A thin wrapper over the per-area scripts.

Each area owns its own file, so one area can be re-seeded, edited or dropped on
its own. This script runs all of them against a single session and commits once:

    scripts/seed_materials_management.py   Materials Management  LOC-005
        Warehouse One → Shelf A … Shelf Z
        Minus-20 Freezers → T90020B · T90020C · T90020D
    scripts/seed_cold_storage.py           Cold Storage          LOC-002 / LOC-006
        Minus-20 Freezers (units added by Super Admin)
        Minus-80 Freezers (units added by Super Admin)
    scripts/seed_analytical_lab.py         Analytical Lab        07-09-LOC-002
        Minus-20 Freezers → T90020A
        Minus-80 Freezers → T90019D
    scripts/seed_production.py             Production            07-22-LOC-003
        Clean Room One … Clean Room Six (six clean rooms, nothing else)

**LN2 is NEVER seeded — it is always created by the user** (client rule,
2026-07-30). LOC-001 makes a tank the root of its own cascade (tank → four
quadrants → rack → box grid), and the tank numbers are the client's, so tanks,
quadrants, racks and boxes are all built on the LN2 page by whoever has the role.
Do not add a `seed_ln2.py`: 07-22-LOC-004 keeps every LN2 level renameable, so
placeholder tanks would only be rows someone has to rename, and a seeded tank
number would be a number nobody's equipment carries.

The consequence is worth knowing before a wipe: `scripts/reset_db.py` truncates
`meta.location_nodes`, which destroys the LN2 cascade, and nothing here brings it
back. That script prints the same warning.

Location rows are NEVER created by a migration. ``created_by_user_id`` is NOT
NULL, and a fresh database has no users until Cognito seeding runs, so a
migration cannot honestly own a location row. Migrations carry the *schema* (the
node-type and parentage CHECKs on ``meta.location_nodes``); these scripts carry
the *rows*. Run ``scripts/seed_super_admins.py`` first.

Idempotent throughout: a node whose ``(parent, code)`` already exists is skipped,
so re-running is safe and never clobbers a client rename.

Usage (from backend/):
    uv run python -m scripts.seed_locations           # dry run — print the plan
    uv run python -m scripts.seed_locations --yes      # create the nodes

    # …or one area at a time:
    uv run python -m scripts.seed_cold_storage --yes
"""

from __future__ import annotations

import uuid

from scripts import (
    seed_analytical_lab,
    seed_cold_storage,
    seed_materials_management,
    seed_production,
    seed_storage,
)
from scripts._location_seed import cli

# (heading, plan) — the order rooms appear in the seed output, which matches the
# sidebar. Storage leads: it is the template-driven room the other three are
# being replaced by (LOC-001), and the seed output reading in a different order
# from the navigation is the kind of small mismatch that costs someone an hour.
AREAS = [
    ("Storage", seed_storage.plan),
    ("Materials Management", seed_materials_management.plan),
    ("Cold Storage", seed_cold_storage.plan),
    ("Analytical Lab", seed_analytical_lab.plan),
    ("Production areas", seed_production.plan),
]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    """Run every area's plan against one session (the caller commits)."""
    created = 0
    for index, (heading, area_plan) in enumerate(AREAS):
        # The first heading is printed by the CLI wrapper as the run label.
        if index:
            print(f"\n{heading}:")
        created += await area_plan(session, owner_id, apply)
    return created


if __name__ == "__main__":
    cli(
        AREAS[0][0],
        plan,
        description="Seed every location area (Materials Management → Production).",
    )
