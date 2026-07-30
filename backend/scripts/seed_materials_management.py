"""Seed the Materials Management room (REQ-2026-07-15-LOC-005).

    Materials Management                        room
      Warehouse One                             warehouse     ambient storage
        Shelf A … Shelf Z                       shelf         26 leaves
      Minus-20 Freezers                         room_location cold storage
        T90020B · T90020C · T90020D             sub_location  the equipment units

LOC-005 verbatim: "The Materials Management room shall be a location category
containing two peer locations: Warehouse One and Minus-20 Freezers." Those two
are different node types only so the UI can tab between them — structurally they
are peers under the same room.

Rules this seed honours:
  * Nothing below shelf level — no bins, positions or slots (LOC-005). Physical
    placement within a shelf is controlled by labeling.
  * Nothing inside a freezer unit (LOC-005 / LOC-006).
  * A unit's name is free text following the client's equipment numbering
    (T-number + unit suffix); nothing here parses, validates or enumerates it.
    The suffixes below are the client's current values, NOT a permitted set
    (LOC-006).
  * "Open inventory" is descriptive language only and appears nowhere — the
    ambient shelving IS Warehouse One (LOC-005).

The −20 °C units come from the client's equipment list ("Freezer List.xlsx",
Materials Management rows). The six −80 °C units on that same list are seeded by
``scripts/seed_cold_storage.py`` instead: LOC-005 names only two locations in
this room, so they are not this room's to hold.

Usage (from backend/):
    uv run python -m scripts.seed_materials_management         # dry run
    uv run python -m scripts.seed_materials_management --yes   # create
"""

from __future__ import annotations

import string
import uuid

from scripts._location_seed import Node, cli, seed_tree

# The client's −20 °C units in this room, from their equipment list. Free text —
# never parsed (LOC-006).
MINUS_20_UNITS: tuple[str, ...] = ("T90020B", "T90020C", "T90020D")

ROOM_CODE = "MM"
ROOM_NAME = "Materials Management"


def plan_nodes() -> list[Node]:
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
            ROOM_CODE,
            ROOM_NAME,
            [
                ("warehouse", "WH1", "Warehouse One", shelves),
                ("room_location", "MM-F20", "Minus-20 Freezers", cold_units),
            ],
        ),
    ]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    return await seed_tree(session, plan_nodes(), None, owner_id, apply=apply)


if __name__ == "__main__":
    cli(
        ROOM_NAME,
        plan,
        description="Seed the Materials Management room (LOC-005).",
    )
