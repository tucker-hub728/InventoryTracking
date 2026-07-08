"""Seed freezer locations from ``freezer_locations.json``.

Reads the JSON produced from ``temp/Freezer List.xlsx`` and materialises it into
the ``app.locations`` tree:

    category (app.location_category)   e.g. "Analytical Lab"
      └─ top-level location            e.g. "-80°C Freezer"
           └─ shelf sub-location       e.g. "T90019D"

Each category+freezer pair becomes its own top-level location (so the same
"-80°C Freezer" exists once per category), and each equipment ID becomes a shelf
under it — matching the on-screen By-Category view.

PREREQUISITE: the new categories (Analytical Lab / Sterility Lab / PD) must
already exist in the ``app.location_category`` enum — run the ``loccat01``
migration first (``alembic upgrade head``), otherwise the inserts fail.

Idempotent: a location is matched by (name, category, parent) and skipped if it
already exists, so re-running only fills gaps.

Usage (from ``backend/``):
    python -m scripts.seed_locations            # dry run — print the plan
    python -m scripts.seed_locations --yes      # create the locations
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.db.session import dispose_engine, get_sessionmaker
from app.models.locations import LOCATION_CATEGORIES, Location
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_JSON_PATH = Path(__file__).resolve().parent / "freezer_locations.json"


async def _find(
    session: AsyncSession,
    *,
    name: str,
    category: str,
    parent_id: uuid.UUID | None,
) -> Location | None:
    """Match an existing location by name + category + parent (idempotency key)."""
    parent_cond = (
        Location.parent_location_id.is_(None)
        if parent_id is None
        else Location.parent_location_id == parent_id
    )
    stmt = select(Location).where(
        Location.location_name == name,
        Location.location_type == category,
        parent_cond,
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _get_or_create(
    session: AsyncSession,
    *,
    name: str,
    category: str,
    parent_id: uuid.UUID | None,
    execute: bool,
) -> tuple[Location | None, bool]:
    """Return (location, created). On a dry run, never writes and returns
    (None, would_create)."""
    existing = await _find(session, name=name, category=category, parent_id=parent_id)
    if existing is not None:
        return existing, False
    if not execute:
        return None, True
    loc = Location(
        location_name=name,
        location_type=category,
        parent_location_id=parent_id,
        is_active=True,
    )
    session.add(loc)
    await session.flush()  # populate id for child shelves
    return loc, True


def _load() -> list[dict[str, Any]]:
    data = json.loads(_JSON_PATH.read_text(encoding="utf-8"))
    return list(data["categories"])


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed freezer locations.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the locations. Without this the script only prints the plan.",
    )
    args = parser.parse_args()

    settings = get_settings()
    categories = _load()

    # Fail fast on any category not yet in the enum (the migration must run first).
    bad = sorted({c["category"] for c in categories} - set(LOCATION_CATEGORIES))
    if bad:
        print(
            "REFUSING: these categories are not in app.location_category yet: "
            f"{', '.join(bad)}. Run the loccat01 migration first (alembic upgrade head)."
        )
        return 1

    print(f"Environment  : {settings.app_env.value}")
    print(f"Database     : {str(settings.database_url).rsplit('@', 1)[-1]}")
    print(f"Source JSON  : {_JSON_PATH.name}")
    total_freezers = sum(len(c["locations"]) for c in categories)
    total_shelves = sum(len(loc["sublocations"]) for c in categories for loc in c["locations"])
    print(
        f"Plan         : {len(categories)} categories · {total_freezers} freezers · "
        f"{total_shelves} sub-locations\n"
    )

    sessionmaker = get_sessionmaker()
    created_top = created_shelf = 0
    exit_code = 0
    try:
        async with sessionmaker() as session:
            for block in categories:
                category = block["category"]
                for loc in block["locations"]:
                    freezer = loc["location"]
                    top, top_created = await _get_or_create(
                        session,
                        name=freezer,
                        category=category,
                        parent_id=None,
                        execute=args.yes,
                    )
                    created_top += int(top_created)
                    top_tag = "create" if top_created else "exists"
                    print(f"  [{category}] {freezer:<14} {top_tag}")

                    # On a dry run the parent id is unknown; report shelves as planned.
                    parent_id = top.id if top is not None else None
                    for sub in loc["sublocations"]:
                        if args.yes and parent_id is not None:
                            _, shelf_created = await _get_or_create(
                                session,
                                name=sub,
                                category=category,
                                parent_id=parent_id,
                                execute=True,
                            )
                        else:
                            # dry run (or parent not yet created): would-create unless
                            # an identical shelf somehow already exists at top level.
                            shelf_created = True
                        created_shelf += int(shelf_created)
                        print(f"      └─ {sub:<10} {'create' if shelf_created else 'exists'}")

            if args.yes:
                await session.commit()

        if args.yes:
            print(f"\nDone. Created {created_top} freezers + {created_shelf} sub-locations.")
        else:
            print(
                f"\nDRY RUN — nothing created. Would create up to {created_top} freezers "
                f"+ {created_shelf} sub-locations. Re-run with --yes to execute."
            )
        return exit_code
    finally:
        await dispose_engine()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
