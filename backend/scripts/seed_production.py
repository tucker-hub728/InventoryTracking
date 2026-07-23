"""Seed the Production areas.

Production is a location group whose sub-locations are the client's manufacturing
/ lab areas. The system ships with a set covering the existing spaces (SRS
2026-07-22); the client renames them to their real area names on input, and an
admin adds more later on the Production page. These are ``flat`` location nodes
(``flat_category = 'production'``), parent-less roots — the same shape a kit is
issued to.

Nodes need a creating user (``created_by_user_id`` is NOT NULL), so this runs as
a script after users exist — NOT in a migration (the migration only adds the
``production`` flat-category to the CHECK enum). Idempotent: an area whose code
already exists is skipped, so re-running is safe and never clobbers a rename.

Usage (from backend/):
    uv run python -m scripts.seed_production            # dry run — print the plan
    uv run python -m scripts.seed_production --yes      # create the areas
"""

from __future__ import annotations

import argparse
import asyncio

from app.db.session import get_sessionmaker
from app.locations import repository as loc_repo
from app.models.identity import User
from sqlalchemy import select

# (code, name) — the initial set covering existing spaces (SRS 2026-07-22).
# Names are placeholders the client renames to their actual areas on input.
PRODUCTION_AREAS: list[tuple[str, str]] = [
    ("PROD-CR1", "Clean Room One"),
    ("PROD-CR2", "Clean Room Two"),
    ("PROD-MFG", "Manufacturing Floor"),
    ("PROD-PD1", "PD Lab One"),
    ("PROD-PD2", "PD Lab Two"),
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


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Production areas.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the areas. Without it the script prints the plan.",
    )
    args = parser.parse_args()

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        creator_id = await _creator_id(session)
        if creator_id is None:
            print(
                "REFUSING: no users exist yet to own the seeded areas. "
                "Seed users first (scripts/seed_super_admins.py)."
            )
            return 1

        print("Production areas:")
        created = 0
        for code, name in PRODUCTION_AREAS:
            existing = await loc_repo.get_sibling_by_code(
                session, parent_id=None, code=code
            )
            if existing is not None:
                print(f"  = exists  {code:<10} {name}")
            elif args.yes:
                # Seed with a fixed code (idempotent, human-readable). The
                # admin "Add area" path generates codes from the name instead.
                await loc_repo.create_node(
                    session,
                    node_type="flat",
                    code=code,
                    name=name,
                    created_by_user_id=creator_id,
                    parent_id=None,
                    flat_category="production",
                )
                created += 1
                print(f"  + create  {code:<10} {name}")
            else:
                created += 1
                print(f"  + would   {code:<10} {name}")

        if args.yes:
            await session.commit()
            print(f"\nDone — created {created} area(s).")
        else:
            print(
                f"\nDRY RUN — {created} area(s) would be created. "
                "Re-run with --yes to apply."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
