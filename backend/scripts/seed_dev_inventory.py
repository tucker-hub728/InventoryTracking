"""Seed a WORKING dev inventory: storage, items, stock, and Kanban stations.

This is the seed the project has never had, and its absence is felt every time
the database is wiped. ``reset_db``'s own closing notes list what nothing
rebuilds — "Items, their BOM lines and supplier links. No item seed exists" and
"Storage locations. Nothing seeds them" — so after a wipe the app comes up
correct and completely unusable: no item to open, nowhere to put stock, no
Kanban to issue to, and every smoke test failing on the first lookup.

Scope, deliberately narrow: enough to exercise the flows end to end, not a
pretend production catalogue. Six suppliers' worth of realism buys nothing here.

    Storage › Materials Management › Shelf › Shelf A   ← the storable node
    CR-001 Nitrile Gloves      consumable, 500 on Shelf A, expires +180d
    CR-002 Pipette Tips        consumable, 300 on Shelf A, expires  +30d  ← warns
    CR-003 Cleanroom Wipes     consumable, 200 on Shelf A, no expiry
    AY-001 Buffer Sub-Assembly non-consumable, 50 on Shelf A
    Kanban 1 on each of the six clean rooms

**What it deliberately does NOT seed**, matching the rules those areas are
built on:

* the **LN2 tree** — tank numbers are the client's, so tanks are always created
  by a user on the LN2 page; a seeded tank would be a lie with a number on it;
* **Storage sub-types** (LOC-001) — a Storage location is created bare and its
  sub-types are added afterwards, by kind, through the app;
* **audit / e-signature evidence** — a seeded signature would be a forged
  attestation. Every row here is written by the named seed user with no
  ``reauth_evidence_id``, which is what a system seed honestly is.

The expiry dates are picked to make LOC-008 visible without any further setup:
CR-002 lands inside the default 30-day warning window, CR-001 well outside it,
CR-003 has no date at all (07-09: "expiration flags apply only where a date
exists" — a dateless consumable must never flag).

Safety: dry-run by default, refuses production, and idempotent — an existing
item / node / lot is left alone rather than duplicated, so re-running after a
partial failure is safe.

Usage (from ``backend/``):
    python -m scripts.seed_dev_inventory          # dry run — shows the plan
    python -m scripts.seed_dev_inventory --yes    # apply
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from app.core.config import Environment, get_settings
from app.db.session import dispose_engine, get_sessionmaker
from app.locations import repository as loc_repo
from app.models.inventory import Item, ItemPrefix, Lot
from app.models.locations import LocationNode
from sqlalchemy import select

#: The Storage tree, exactly as the app builds it:
#:
#:     STG (room, created on demand by the server — never named by anyone)
#:       └── Materials Management   storage_category — what the client calls a
#:             └── Shelf            room_location    — a sub-type, by KIND
#:                   └── Shelf A    sub_location     — the storable unit
#:
#: An earlier version of this script took a shortcut: ``room`` → ``warehouse``
#: → ``shelf``, the shortest path to a node in ``STORAGE_NODE_TYPES``. Every
#: backend rule allowed it — ``PARENT_OF``, the CHECK constraints, ``can_store``
#: — and it was still wrong, because it invented a room. The UI resolves rooms
#: BY CODE and knows exactly one storage room, ``STG``
#: (``ROOM_CODE_ORDER = ['STG']`` in the location tree picker). Seeding an "MM"
#: room produced stock sitting at a location with no page and no nav entry: real
#: in the ledger, unreachable on screen.
#:
#: The lesson is worth keeping: passing the database's constraints is not the
#: same as being reachable in the product. Build through the app's own helpers
#: (`get_or_create_storage_room`, `create_storage_category`) rather than
#: inserting nodes that merely satisfy the schema.
_LOCATION_NAME = "Materials Management"
_GROUP_KIND = "shelf"
_GROUP_NAME = "Shelf"
_UNIT_NAME = "Shelf A"

#: ``(prefix, suffix, description, uom, is_consumable, qty, expires_in_days)``.
#: ``expires_in_days=None`` means no expiration date at all.
_ITEMS: list[tuple[str, str, str, str, bool, int, int | None]] = [
    ("CR", "001", "Nitrile Gloves, size M", "Each", True, 500, 180),
    # Inside the default 30-day warn window on purpose — this is the row that
    # makes the expiring feed and the Kanban expiry check do something.
    ("CR", "002", "Pipette Tips, 1000uL", "Each", True, 300, 30),
    ("CR", "003", "Cleanroom Wipes", "Each", True, 200, None),
    ("AY", "001", "Buffer Sub-Assembly", "Each", False, 50, None),
]

_KANBAN_NAME = "Kanban 1"


async def _seed_user_id(session: Any) -> Any:
    """The account every seeded row is attributed to.

    Prefers the seed super admin, because these rows are exactly what that
    account exists to own. Refuses rather than inventing an author: a row with
    a made-up ``created_by_user_id`` is worse than no row.
    """
    from app.models.identity import User

    for clause in (User.is_seed.is_(True), User.role == "super_admin", User.id.isnot(None)):
        found = (await session.execute(select(User).where(clause).limit(1))).scalars().first()
        if found is not None:
            return found
    return None


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed a working dev inventory.")
    parser.add_argument("--yes", action="store_true", help="Actually write the rows.")
    args = parser.parse_args()

    settings = get_settings()
    if settings.app_env is Environment.production:
        print("REFUSING: this is dev/staging seed data and must never run against production.")
        return 1

    print(f"Environment : {settings.app_env.value}")
    print("Plan        :")
    print(f"  location   Storage › {_LOCATION_NAME} › {_GROUP_NAME} › {_UNIT_NAME}")
    for prefix, suffix, desc, _uom, consumable, qty, exp in _ITEMS:
        kind = "consumable" if consumable else "raw material"
        when = f"expires +{exp}d" if exp is not None else "no expiry"
        print(f"  item       {prefix}-{suffix:<5} {desc:<28} {kind:<12} {qty:>4} units, {when}")
    print(f"  kanban     '{_KANBAN_NAME}' on every production area")
    if not args.yes:
        print("\nDRY RUN — nothing changed. Re-run with --yes to apply.")
        return 0

    session_factory = get_sessionmaker()
    created = {"nodes": 0, "items": 0, "lots": 0, "kanbans": 0}
    try:
        async with session_factory() as session:
            user = await _seed_user_id(session)
            if user is None:
                print("\nREFUSING: no users exist to own the seeded rows.")
                print("Run scripts/seed_super_admins.py first.")
                return 1
            print(f"\nAttributing to: {user.email}")

            # ── Storage ────────────────────────────────────────────────
            # Through the app's own helpers, not raw inserts — see the note on
            # _LOCATION_NAME for what that bought last time.
            room = await loc_repo.get_or_create_storage_room(
                session, created_by_user_id=user.id
            )

            category = await loc_repo.get_child_by_name(
                session, parent_id=room.id, name=_LOCATION_NAME
            )
            if category is None:
                category = await loc_repo.create_storage_category(
                    session,
                    room_node_id=room.id,
                    name=_LOCATION_NAME,
                    created_by_user_id=user.id,
                )
                created["nodes"] += 1

            group = await loc_repo.get_child_by_name(
                session, parent_id=category.id, name=_GROUP_NAME
            )
            if group is None:
                group = await loc_repo.create_node(
                    session,
                    node_type="room_location",
                    # Derived from the KIND, so a second shelf becomes SHF-2
                    # rather than colliding — the same call the app makes.
                    code=await loc_repo.next_group_code(session, category.id, _GROUP_KIND),
                    name=_GROUP_NAME,
                    created_by_user_id=user.id,
                    parent_id=category.id,
                )
                created["nodes"] += 1

            shelf = await loc_repo.get_child_by_name(
                session, parent_id=group.id, name=_UNIT_NAME
            )
            if shelf is None:
                shelf = await loc_repo.create_node(
                    session,
                    node_type="sub_location",
                    code=f"{group.code}-A",
                    name=_UNIT_NAME,
                    created_by_user_id=user.id,
                    parent_id=group.id,
                )
                created["nodes"] += 1

            # ── Items, lots, stock ─────────────────────────────────────
            today = datetime.now(UTC).date()
            for prefix_code, suffix, desc, uom, consumable, qty, exp_days in _ITEMS:
                prefix = (
                    (
                        await session.execute(
                            select(ItemPrefix).where(ItemPrefix.code == prefix_code)
                        )
                    )
                    .scalars()
                    .first()
                )
                if prefix is None:
                    print(f"  SKIP {prefix_code}-{suffix}: prefix not found (seed_item_tiers)")
                    continue

                item = (
                    (
                        await session.execute(
                            select(Item).where(
                                Item.prefix_id == prefix.id, Item.sku_suffix == suffix
                            )
                        )
                    )
                    .scalars()
                    .first()
                )
                if item is None:
                    item = Item(
                        prefix_id=prefix.id,
                        sku_suffix=suffix,
                        description=desc,
                        uom=uom,
                        is_consumable=consumable,
                        # Zero, matching the workbook's own policy: a threshold
                        # is the admin's number and inventing one would put
                        # every seeded item on the reorder screen on day one.
                        reorder_threshold=Decimal("0"),
                        created_by_user_id=user.id,
                        updated_by_user_id=user.id,
                    )
                    session.add(item)
                    await session.flush()
                    created["items"] += 1

                lot_number = f"AUTO-{prefix_code}{suffix}"
                lot = (
                    (await session.execute(select(Lot).where(Lot.lot_number == lot_number)))
                    .scalars()
                    .first()
                )
                if lot is None:
                    lot = Lot(
                        item_id=item.id,
                        lot_number=lot_number,
                        expiration_date=(
                            today + timedelta(days=exp_days) if exp_days is not None else None
                        ),
                        created_by_user_id=user.id,
                        updated_by_user_id=user.id,
                    )
                    session.add(lot)
                    await session.flush()
                    # Allocation AND receipt movement together — the allocation
                    # view and the ledger view of on-hand must agree, and this
                    # is the pair every real receive writes.
                    await loc_repo.create_or_merge_allocation(
                        session,
                        lot_id=lot.id,
                        location_node_id=shelf.id,
                        qty=Decimal(qty),
                        created_by_user_id=user.id,
                    )
                    await loc_repo.create_node_receipt_movement(
                        session,
                        item_id=item.id,
                        lot_id=lot.id,
                        to_location_node_id=shelf.id,
                        qty=Decimal(qty),
                        performed_by_user_id=user.id,
                        notes="Dev seed",
                    )
                    created["lots"] += 1

            # ── Kanban stations ────────────────────────────────────────
            areas = (
                (
                    await session.execute(
                        select(LocationNode).where(
                            LocationNode.flat_category == "production",
                            LocationNode.is_active.is_(True),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for area in areas:
                existing = await loc_repo.list_kanbans(session, area.id)
                if existing:
                    continue
                await loc_repo.create_kanban(
                    session,
                    area_node_id=area.id,
                    name=_KANBAN_NAME,
                    created_by_user_id=user.id,
                )
                created["kanbans"] += 1

            await session.commit()

        print(
            f"\nDone — {created['nodes']} node(s), {created['items']} item(s), "
            f"{created['lots']} lot(s) with stock, {created['kanbans']} Kanban(s)."
        )
        print("\nNOT seeded (by design — build these in the app):")
        print("  * the LN2 tree — tank numbers are the client's")
        print("  * Storage sub-types (LOC-001) — added after creation, by kind")
        return 0
    finally:
        await dispose_engine()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
