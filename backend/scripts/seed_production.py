"""Seed the Production areas (REQ-2026-07-22-LOC-003).

    Production                                  the group (flat_category)
      CR 101 … CR 601                           flat

Six clean rooms, and nothing else.

07-22-LOC-003 is the governing line: the areas "shall be seeded to cover all
existing spaces (client indicated six clean rooms) rather than providing dynamic
add; new areas, if ever needed, are added by admin on request".

07-22-LOC-001 also named Manufacturing Floor, PD Lab One and PD Lab Two — but it
named them as the set to seed "initially… to be renamed to the client's actual
area names on input". That list was always provisional, pending exactly this
input, and on 2026-07-30 the client confirmed six clean rooms and asked for the
other three to be dropped. So they are gone rather than renamed. Two further
reasons this is the right reading:

  * The PD room count is still formally OPEN (REQ-2026-07-15-LOC-004,
    REQ-2026-07-09-LOC-005 — "added once the floor team confirms whether PD is
    one room or several"), so PD Lab One/Two were never confirmed to exist.
  * Nothing binds their codes. The only remaining mentions of PROD-MFG / PROD-PD1
    / PROD-PD2 anywhere are prose in comments and the retired frontend mock.

If the floor team later confirms a manufacturing floor or a PD room, it is added
on the Production page by a Super Admin — which is what LOC-003 says happens to
new areas — or added back to the list below.

Production is the one area with no room node above it. Its areas are ``flat``
nodes carrying ``flat_category = 'production'``, and a ``flat`` node must be a
root (``ck_location_nodes_root_parentage``) — so the "group" is the set of nodes
sharing that category, not a parent row. Kitting depends on exactly that shape:
``kits.production_location_node_id`` is validated against
``flat_category = 'production'`` (``app/kitting/repository.py``), so these areas
must not be nested under a room.

Location rows are NEVER created by a migration — ``created_by_user_id`` is NOT
NULL and a fresh database has no users yet. Migration ``kitting01`` carries only
the schema half (adding ``production`` to the ``flat_category`` CHECK).

Idempotent: an area whose code already exists is skipped, so re-running is safe
and never clobbers a client rename.

Usage (from backend/):
    uv run python -m scripts.seed_production            # dry run — print the plan
    uv run python -m scripts.seed_production --yes      # create the areas
"""

from __future__ import annotations

import uuid

from scripts._location_seed import cli, seed_flat

GROUP_NAME = "Production areas"
FLAT_CATEGORY = "production"

# (code, name). The six clean rooms the client confirmed (07-22-LOC-003), and
# nothing else — see the module docstring for why Manufacturing Floor and the two
# PD labs are not here. The admin "Add area" path derives codes from the name
# instead, so these fixed codes stay stable and human-readable.
#
# The numbers are the client's own, confirmed 2026-09-04: 101, 201, 301, 401,
# 501, 601 — one room per hundred-series, NOT 101-106. They replace the
# placeholder "Clean Room One … Clean Room Six" the app shipped with, which
# 07-22-LOC-001 always described as provisional "to be renamed to the client's
# actual area names on input". This is that input.
#
# Renumbering an existing database is done by RESEED, never by rename, for two
# reasons: ``code`` has no mutation path at all (``NodeUpdateRequest`` is
# name-only with ``extra="forbid"``), and a rename would leave the live UI
# showing the new name on every historical movement while the finance export
# keeps reading the frozen ``stock_movements.from/to_location_path`` snapshots,
# which a trigger makes unrepairable. ``scripts/renumber_production_areas.py``
# retires the old rows first; this script then creates these.
PRODUCTION_AREAS: list[tuple[str, str]] = [
    ("PROD-CR101", "CR 101"),
    ("PROD-CR201", "CR 201"),
    ("PROD-CR301", "CR 301"),
    ("PROD-CR401", "CR 401"),
    ("PROD-CR501", "CR 501"),
    ("PROD-CR601", "CR 601"),
]


async def plan(session, owner_id: uuid.UUID, apply: bool) -> int:
    return await seed_flat(
        session,
        PRODUCTION_AREAS,
        owner_id,
        flat_category=FLAT_CATEGORY,
        apply=apply,
    )


if __name__ == "__main__":
    cli(
        GROUP_NAME,
        plan,
        description="Seed the Production areas — six clean rooms (07-22-LOC-003).",
    )
