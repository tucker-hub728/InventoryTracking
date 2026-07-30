"""Seed the Analytical Lab room (Q-2026-07-01-002 + the client's equipment list).

    Analytical Lab                              room
      Minus-20 Freezers                         room_location  cold storage
        T90020A                                 sub_location   the equipment unit
      Minus-80 Freezers                         room_location  cold storage
        T90019D                                 sub_location   the equipment unit

PROVISIONAL — read this before changing anything here
-----------------------------------------------------
The only REQUIREMENT that ever placed freezers in the Analytical Lab was
REQ-2026-07-09-LOC-002 ("…the analytical lab shall contain a minus-twenty and a
minus-eighty freezer") — and REQ-2026-07-15-LOC-005 explicitly **supersedes** it
while saying nothing about the room. That supersession is why the room was
dropped from the seeded set on 2026-07-29.

What supports it now is weaker, but real: the resolution recorded against
Q-2026-07-01-002 lists "analytical lab (a minus-twenty and a minus-eighty)" as
part of the confirmed location list, and the client's equipment list ("Freezer
List.xlsx") names both units — T90020A (−20 °C) and T90019D (−80 °C). The client
directed on 2026-07-30 that the room be kept and cited to those instead.

So: keep seeding it, but do not treat it as settled. It needs an amendment that
names the Analytical Lab. If one says the room is gone, delete this file and
decide where T90020A and T90019D live instead.

The two locations carry the Cold Storage naming from LOC-002 — the category was
renamed from "Freezers" because the same level also holds refrigerators. The
Analytical Lab has no refrigerator on the client's list.

Its two locations are fixed, so the Analytical Lab page adds SUB-LOCATIONS only:
new locations are created on the Cold Storage page (client rule, 2026-07-30 —
see ``frontend/src/components/rooms/room-config.ts``). Nothing else moved;
Materials Management and Cold Storage keep their own units.

Rules honoured: no structure inside a unit; the unit name is free text following
the client's T-number convention and is never parsed or validated (LOC-006);
only a Super Admin may create cold storage locations (enforced by the API).

Usage (from backend/):
    uv run python -m scripts.seed_analytical_lab         # dry run
    uv run python -m scripts.seed_analytical_lab --yes   # create
"""

from __future__ import annotations

import uuid

from scripts._location_seed import Node, cli, seed_tree

ROOM_CODE = "AL"
ROOM_NAME = "Analytical Lab"

# One unit per group, from the client's equipment list. Free text (LOC-006).
MINUS_20_UNIT = "T90020A"
MINUS_80_UNIT = "T90019D"


def plan_nodes() -> list[Node]:
    """Analytical Lab: one −20 °C freezer and one −80 °C freezer."""
    return [
        (
            "room",
            ROOM_CODE,
            ROOM_NAME,
            [
                (
                    "room_location",
                    "AL-F20",
                    "Minus-20 Freezers",
                    [("sub_location", MINUS_20_UNIT, MINUS_20_UNIT, [])],
                ),
                (
                    "room_location",
                    "AL-F80",
                    "Minus-80 Freezers",
                    [("sub_location", MINUS_80_UNIT, MINUS_80_UNIT, [])],
                ),
            ],
        ),
    ]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    return await seed_tree(session, plan_nodes(), None, owner_id, apply=apply)


if __name__ == "__main__":
    cli(
        ROOM_NAME,
        plan,
        description="Seed the Analytical Lab room (provisional — see the module docstring).",
    )
