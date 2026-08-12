"""Seed the Storage room (REQ-2026-08-04-LOC-001 / LOC-004).

    Storage                                       room
      (locations added by Super Admin)            storage_category
        Shelf / Refrigerator / Freezer            room_location
          (units added by Super Admin)            sub_location

LOC-001 provisions a new location "from a standard template that automatically
includes a configurable shelf, refrigerator, and freezer", renameable, and any
of which may be left unused. This script seeds only the ROOM those locations
live in; everything below it is created on the page.

Why the room starts empty
-------------------------
The template's whole point is that the client provisions their own locations —
naming each one and switching on the sub-types it actually uses. Seeding a
"Materials Management" here would prejudge both, and the client would then be
renaming a guess rather than typing what they have. Same reasoning as Cold
Storage, which seeds its groups but none of their units.

The groups are NOT seeded either, because they belong to a category and no
category exists yet. They are created by
``POST /location-nodes/{room_id}/storage-categories`` alongside the category, in
one transaction, so a location can never exist without the sub-types it was
provisioned with.

Relationship to the deprecated rooms
------------------------------------
Materials Management, Cold Storage and the Analytical Lab are marked deprecated
in the sidebar as of 2026-08-12, and Storage is intended to replace their
structure. Nothing about that is destructive: this script only ever creates, the
three rooms keep working exactly as before, and both models are expected to run
side by side through the overlap. Do not add anything here that touches them.

Shape note
----------
Storage is the one room with FOUR levels. Every other room runs
room → location → sub-location; Storage inserts the category between the room
and the groups, which is why ``storage_category`` exists at all (migration
``storage01``). From the group down it is byte-identical to Cold Storage, and
that is deliberate — the same create route, dialogs and components serve both.

Usage (from backend/):
    uv run python -m scripts.seed_storage         # dry run
    uv run python -m scripts.seed_storage --yes   # create
"""

from __future__ import annotations

import uuid

from scripts._location_seed import Node, cli, seed_tree

ROOM_CODE = "STG"
ROOM_NAME = "Storage"


def plan_nodes() -> list[Node]:
    """Storage: the room only. Its locations are provisioned from the template
    by a Super Admin — see the module docstring."""
    return [
        ("room", ROOM_CODE, ROOM_NAME, []),
    ]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    return await seed_tree(session, plan_nodes(), None, owner_id, apply=apply)


if __name__ == "__main__":
    cli(
        ROOM_NAME,
        plan,
        description="Seed the Storage room (LOC-001 / LOC-004).",
    )
