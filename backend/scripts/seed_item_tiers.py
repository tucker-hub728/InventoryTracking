"""Seed the three canonical item tiers and their default prefixes.

Restores what ``app.item_tiers`` + ``app.item_prefixes`` are supposed to contain:

    Raw Materials    CR   raw_material   neutral
    Sub-Assemblies   AY   sub_assembly   accent
    Finished Goods   FG   finished_good  success

Exactly three tiers exist (REQ-2026-07-15-ITM-001) and admin-added prefixes live
INSIDE one of them, never forming a fourth. Each tier gets one ``is_default``
prefix here — the value the item-create form pre-fills — and admins add more
through the Tier admin screen.

WHY THIS SCRIPT EXISTS
----------------------
These rows were originally planted by migration ``catprefix01`` and marked
``is_seeded`` (renameable, not deletable). But ``scripts/reset_db.py`` truncates
both tables in its default mode, and until now **no seed script owned them** —
they were listed in ``_REFERENCE_TABLES`` as "painful to recreate", which only
helps under ``--keep-reference``. A plain ``reset_db --yes`` therefore left a
database where /inventory/cr renders "The Raw Materials tier is missing from the
catalogue" and the Tier admin screen shows "No tiers yet", with nothing to run.
This closes that gap.

Rows are written with ``is_seeded = TRUE`` and no ``created_by_user_id``, exactly
as the migration wrote them — a system seed has no human author.

Idempotent: a tier whose (case-insensitive) name already exists is skipped, and
so is a prefix whose code already exists, so re-running is safe.

Usage (from ``backend/``):
    python -m scripts.seed_item_tiers          # dry run — show the plan
    python -m scripts.seed_item_tiers --yes    # create the rows

Exit codes: 0 = ok / dry-run, 1 = refused.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.db.session import dispose_engine, get_engine
from sqlalchemy import text

# (tier name, tier type, tone, prefix code, prefix label)
# Names/tones match migration ``catprefix01``; ``type`` uses the post-``tierrename01``
# vocabulary (purchased → raw_material, built → sub_assembly / finished_good).
_TIERS: tuple[tuple[str, str, str, str, str], ...] = (
    ("Raw Materials", "raw_material", "neutral", "CR", "Raw Material"),
    ("Sub-Assemblies", "sub_assembly", "accent", "AY", "Sub-Assembly"),
    ("Finished Goods", "finished_good", "success", "FG", "Finished Good"),
)


async def _seed(args: argparse.Namespace) -> int:
    engine = get_engine()
    try:
        async with engine.begin() as conn:
            planned: list[str] = []
            skipped: list[str] = []

            for name, type_, tone, code, _label in _TIERS:
                tier_exists = (
                    await conn.execute(
                        text(
                            "SELECT id FROM app.item_tiers "
                            "WHERE lower(name) = lower(:name) AND deleted_at IS NULL"
                        ),
                        {"name": name},
                    )
                ).scalar_one_or_none()
                prefix_exists = (
                    await conn.execute(
                        text(
                            "SELECT id FROM app.item_prefixes "
                            "WHERE lower(code) = lower(:code) AND deleted_at IS NULL"
                        ),
                        {"code": code},
                    )
                ).scalar_one_or_none()

                if tier_exists and prefix_exists:
                    skipped.append(f"{name} ({code})")
                    continue
                planned.append(f"{name:<16} {type_:<14} {tone:<8} {code}")

            print(f"Database : {engine.url.database}")
            print()
            if skipped:
                print("Already present (skipped)")
                for s in skipped:
                    print(f"  = {s}")
                print()
            if planned:
                print("Would create")
                for p in planned:
                    print(f"  + {p}")
            else:
                print("Nothing to do — all three tiers and prefixes exist.")
                return 0
            print()

            if not args.yes:
                print("Dry run — nothing written. Re-run with --yes to execute.")
                return 0

            created = 0
            for name, type_, tone, code, label in _TIERS:
                # ``is_seeded`` + NULL creator mirror how the migration wrote
                # these: a system seed has no human author, and seeded rows are
                # protected from deletion by the route.
                tier_id = (
                    await conn.execute(
                        text(
                            "INSERT INTO app.item_tiers (name, type, tone, is_seeded) "
                            "VALUES (:name, :type, :tone, TRUE) "
                            "ON CONFLICT DO NOTHING RETURNING id"
                        ),
                        {"name": name, "type": type_, "tone": tone},
                    )
                ).scalar_one_or_none()
                if tier_id is None:
                    tier_id = (
                        await conn.execute(
                            text(
                                "SELECT id FROM app.item_tiers "
                                "WHERE lower(name) = lower(:name) AND deleted_at IS NULL"
                            ),
                            {"name": name},
                        )
                    ).scalar_one()
                else:
                    created += 1

                inserted = (
                    await conn.execute(
                        text(
                            "INSERT INTO app.item_prefixes "
                            "  (tier_id, code, label, is_default, is_seeded) "
                            "SELECT :tier_id, :code, :label, TRUE, TRUE "
                            "WHERE NOT EXISTS ("
                            "  SELECT 1 FROM app.item_prefixes "
                            "  WHERE lower(code) = lower(:code) AND deleted_at IS NULL"
                            ") RETURNING id"
                        ),
                        {"tier_id": tier_id, "code": code, "label": label},
                    )
                ).scalar_one_or_none()
                if inserted is not None:
                    created += 1
                print(f"  OK  {name:<16} {code}")

            print(f"\nDone — created {created} row(s).")
    finally:
        await dispose_engine()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed the three canonical item tiers and their default prefixes.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually write the rows. Without this the script only prints the plan.",
    )
    return asyncio.run(_seed(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
