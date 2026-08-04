"""Seed the Cold Storage room (REQ-2026-07-15-LOC-002 / LOC-006).

    Cold Storage                                room
      Minus-20 Freezers                         room_location
        (units added by Super Admin)            sub_location
      Minus-80 Freezers                         room_location
        (units added by Super Admin)            sub_location

LOC-002 renames the old "Freezers" category to **Cold Storage** and says it
holds minus-twenty freezers, minus-eighty freezers, and two-to-eight
refrigerators. This script seeds it as a room whose level-2 locations are those
unit-type groups. The leaves — the equipment units — are not seeded.

Why both groups start empty
---------------------------
This script seeds the GROUPS only; every unit is added by a Super Admin on the
Cold Storage page (client, 2026-08-04). Cold Storage is already the one room
allowed to create a location, and the client would rather type the units they
actually own than inherit a list. LOC-006 is satisfied either way: governance
here is by role, not by field constraint.

That was always true of the −20 group. The client's equipment list ("Freezer
List.xlsx") assigns every unit to a DEPARTMENT, not to a temperature category:

    Materials Management   −80: T90019A, C, E, F, G, H   −20: T90020B, C, D
    Analytical Lab         −80: T90019D                  −20: T90020A
    Sterility Lab          −80: T90019I, T90019J
    PD                     −80: T90019B                  −20: T90020E

Every −20 unit has a department room of its own — Materials Management
(``seed_materials_management.py``) and Analytical Lab
(``seed_analytical_lab.py``) — so seeding them here too would put one physical
freezer in two places. The six Materials Management −80 units were seeded here
until 2026-08-04, on the grounds that LOC-005 fixes that room at two locations
(Warehouse One and Minus-20 Freezers) and so leaves them homeless. They are now
typed in by hand like every other unit.

Nothing is DELETED by that change. These scripts only ever create, so a database
that already ran the old seed keeps its six −80 units; only a fresh database
(production) starts with both groups empty.

Still outstanding
-----------------
  * The 2–8 °C refrigerator group — LOC-004 defers it until the client provides
    the refrigerator list. The group is left below, commented out, ready.
  * A minus-forty group is believed absent (LOC-002, to be confirmed). Note the
    dev database currently carries an ad-hoc "Minus-40 Freezers" node created
    through the UI; this seed neither creates nor removes it.
  * Sterility Lab and PD units are not seeded — their rooms are not in scope
    yet (PD room count still open, LOC-004 / REQ-2026-07-09-LOC-005).

Rules honoured: no structure inside a unit; unit names are free text following
the client's T-number convention and are never parsed, validated, decomposed or
enumerated; the suffixes above are current usage, not a permitted set (LOC-006).

Usage (from backend/):
    uv run python -m scripts.seed_cold_storage         # dry run
    uv run python -m scripts.seed_cold_storage --yes   # create
"""

from __future__ import annotations

import uuid

from scripts._location_seed import Node, cli, seed_tree

ROOM_CODE = "CS"
ROOM_NAME = "Cold Storage"

# Both empty by design — see the module docstring. Cold Storage is seeded as
# groups only; a Super Admin adds the equipment units on the page. The tuples
# stay rather than collapsing to a bare `[]` so the shape of the room is still
# readable here, and so seeding a unit list again is a one-line change. The
# client's actual numbers are in the docstring.
MINUS_20_UNITS: tuple[str, ...] = ()
MINUS_80_UNITS: tuple[str, ...] = ()

# LOC-004: pending the client's refrigerator list.
# FRIDGE_UNITS: tuple[str, ...] = ()


def _units(names: tuple[str, ...]) -> list[Node]:
    return [("sub_location", name, name, []) for name in names]


def plan_nodes() -> list[Node]:
    """Cold Storage: one room, one level-2 location per unit type."""
    return [
        (
            "room",
            ROOM_CODE,
            ROOM_NAME,
            [
                (
                    "room_location",
                    "CS-F20",
                    "Minus-20 Freezers",
                    _units(MINUS_20_UNITS),
                ),
                (
                    "room_location",
                    "CS-F80",
                    "Minus-80 Freezers",
                    _units(MINUS_80_UNITS),
                ),
                # LOC-004 — add once the refrigerator list arrives:
                # ("room_location", "CS-FRIDGE", "2-8 Refrigerators",
                #  _units(FRIDGE_UNITS)),
            ],
        ),
    ]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    return await seed_tree(session, plan_nodes(), None, owner_id, apply=apply)


if __name__ == "__main__":
    cli(
        ROOM_NAME,
        plan,
        description="Seed the Cold Storage room (LOC-002 / LOC-006).",
    )
