"""Shared plumbing for the per-area location seeds.

    scripts/seed_production.py   group → the manufacturing areas

That is the ONLY seeded area left, and the only caller of this module.

Nothing else is seeded, by design:
  * **Storage** — the server creates the ``STG`` room when the first location is
    added, so a missed deploy step cannot strand the screen. Prefer that pattern
    for any new area whose container the client never names.
  * **LN2** — tank numbers are the client's, so a tank is always created by a
    user on the LN2 page (07-22-LOC-004).
  * **Materials Management / Cold Storage / Analytical Lab** — RETIRED
    2026-08-19 (client-approved) in favour of Storage's generic template. Their
    three seed scripts and the ``seed_locations.py`` aggregator that ran them
    were deleted with the rooms; ``seed_tree`` (the nested room → location →
    sub-location builder) went with them, since a Production area is flat and
    only needs ``seed_flat``.

Location rows are NEVER created by a migration. ``created_by_user_id`` is NOT
NULL, and a fresh database has no users until Cognito seeding runs, so a
migration cannot honestly own a location row — it would either fail or
silently seed nothing. Migrations carry the *schema* (the node-type and
parentage CHECKs); this script carries the *rows*.

``seed_flat`` is idempotent: a node whose ``(parent, code)`` already exists is
skipped, so re-running never duplicates a node and never clobbers a client
rename.
"""

from __future__ import annotations

import argparse
import asyncio
import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from app.db.session import get_sessionmaker
from app.locations import repository as loc_repo
from app.models.identity import User
from sqlalchemy import select

# An area's plan: (session, owner_id, apply) → how many nodes it created.
Plan = Callable[[Any, uuid.UUID, bool], Awaitable[int]]


async def creator_id(session) -> uuid.UUID | None:
    """A user to own the seeded nodes — prefer a super_admin, else any user."""
    admin = (
        await session.execute(select(User).where(User.role == "super_admin").limit(1))
    ).scalars().first()
    if admin is not None:
        return admin.id
    any_user = (await session.execute(select(User).limit(1))).scalars().first()
    return any_user.id if any_user is not None else None


async def seed_flat(
    session,
    areas: Sequence[tuple[str, str]],
    owner_id: uuid.UUID,
    *,
    flat_category: str,
    apply: bool,
) -> int:
    """Create ``(code, name)`` areas as parent-less ``flat`` nodes.

    A ``flat`` node must be a root (``ck_location_nodes_root_parentage``), which
    is why an area group has no node of its own — the group IS the set of nodes
    sharing a ``flat_category``.
    """
    created = 0
    for code, name in areas:
        existing = await loc_repo.get_sibling_by_code(
            session, parent_id=None, code=code
        )
        if existing is not None:
            print(f"  = exists  {code:<18} {name}")
            continue
        if apply:
            await loc_repo.create_node(
                session,
                node_type="flat",
                code=code,
                name=name,
                created_by_user_id=owner_id,
                parent_id=None,
                flat_category=flat_category,
            )
            print(f"  + create  {code:<18} {name}")
        else:
            print(f"  + would   {code:<18} {name}")
        created += 1
    return created


async def run_area(
    label: str,
    plan: Plan,
    *,
    description: str,
    argv: Sequence[str] | None = None,
) -> int:
    """CLI wrapper: parse ``--yes``, resolve an owner, run ``plan``, commit.

    ``plan`` is an async callable taking ``(session, owner_id, apply)`` and
    returning how many nodes it created. Every area script is this plus its own
    data, which is the whole point of splitting them up.
    """
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the nodes. Without it the script prints the plan.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        owner_id = await creator_id(session)
        if owner_id is None:
            print(
                "REFUSING: no users exist yet to own the seeded nodes. "
                "Seed users first (scripts/seed_super_admins.py)."
            )
            return 1

        print(f"{label}:")
        created = await plan(session, owner_id, args.yes)

        if args.yes:
            await session.commit()
            print(f"\nDone — created {created} node(s).")
        else:
            print(
                f"\nDRY RUN — {created} node(s) would be created. "
                "Re-run with --yes to apply."
            )
    return 0


def cli(label: str, plan: Plan, *, description: str) -> None:
    """Entry point for an area script — runs the plan and exits with its status.

    Call it bare under ``if __name__ == "__main__":``; it raises ``SystemExit``
    itself rather than returning a code to wrap.
    """
    raise SystemExit(asyncio.run(run_area(label, plan, description=description)))
