"""Seed suppliers (vendors) from the master workbook.

Inserts the 73 distinct vendor names from ``Demo Inventory Control.xlsx`` into
``meta.suppliers`` — the same list the original ``seed_vendors_from_workbook``
migration used, kept verbatim (spelling variants / multi-vendor cells preserved;
cleaning them up is the admin's job once suppliers are editable). Only ``name``
is set; everything else is left to defaults for the admin to fill later.

Idempotent: a supplier whose (case-insensitive) name already exists is skipped,
so re-running is safe.

Usage (from backend/):
    uv run python -m scripts.seed_suppliers           # dry run — print the plan
    uv run python -m scripts.seed_suppliers --yes      # create the suppliers

On prod (Elastic Beanstalk single instance):
    sudo docker exec <backend-container> python -m scripts.seed_suppliers --yes
"""

from __future__ import annotations

import argparse
import asyncio

from app.db.session import get_sessionmaker
from app.inventory import repository as inv_repo

# 73 unique vendor names, verbatim from the workbook (see the original
# ``seed_vendors_from_workbook`` migration). Data-quality quirks preserved.
WORKBOOK_SUPPLIERS: list[str] = [
    "ATCC",
    "Accellix",
    "Applied Cells",
    "BD Biosciences",
    "Becton Dickinson (BD)",
    "Bio-Techne",
    "BioLegend, Inc",
    "BioMerieux Inc",
    "BioReliance",
    "BioTechne",
    "Biolegends",
    "Biolife Solutions",
    "Biomerieux",
    "Biomeriuex",
    "Biotechne",
    "Carbonics, INC",
    "Cell Staining Buffer",
    "CellReady",
    "Charles River",
    "Charter Medical",
    "CleanMark",
    "Coldstash",
    "Cytek",
    "Cytek Tonbo Reagents",
    "Decon Labs",
    "Eppendorf",
    "Fisher Scientific",
    "Fisher Scientific, VWR",
    "Foxx Life Sciences",
    "Frensenius Kabi",
    "Fresenius Kabi (Fenwal), Fisher Scientific",
    "Gibco (Thermo Fisher Scientific)",
    "Hardy Diagnostics",
    "Hardy Diagnostics, VWR",
    "Incell",
    "Indapta Therapeutics",
    "Initrogen (ThermoFisher)",
    "Invitrogen",
    "Irvine Scientific (fuji film)",
    "McKesson",
    "Microbiologics",
    "Millipore Sigma",
    "Miltenyi",
    "Miltenyi Biote",
    "Miltenyi-BioTec",
    "Minerva Biolabs",
    "New England Biolabs",
    "Nova Biologics",
    "Oakton",
    "OriGen Biomedical",
    "PMS",
    "QIAgen",
    "R&D Systems, Inc.",
    "Revvity",
    "Revvity, Fisher Scientific",
    "Revvity, Fisher Scientific, VWR",
    "Revvity, VWR",
    "SCIENTIFIC RESOURCES SW",
    "ScanTexas",
    "Sharpie",
    "Solventum",
    "Thermo Fisher",
    "Thermo Fisher Scientific",
    "Thermo Fisher Scientific, VWR",
    "ThermoFisher",
    "VWR",
    "VWR, Fisher Scientific",
    "VWR, Fisher Scientific\n2) Fisher Scientific",
    "VWR, Fresenius Kabi, Fisher Scientific",
    "Valley Biomedical",
    "Vector BioMed",
    "Wilson Wolf",
    "bioMerieux, Inc.",
]


async def main() -> int:
    parser = argparse.ArgumentParser(description="Seed suppliers from the workbook.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually create the suppliers. Without it the script prints the plan.",
    )
    args = parser.parse_args()

    sessionmaker = get_sessionmaker()
    created = 0
    skipped = 0
    async with sessionmaker() as session:
        for name in WORKBOOK_SUPPLIERS:
            existing = await inv_repo.get_supplier_by_name(session, name)
            display = name.replace("\n", "\\n")
            if existing is not None:
                skipped += 1
                print(f"  = exists  {display}")
            elif args.yes:
                await inv_repo.create_supplier(session, name=name)
                created += 1
                print(f"  + create  {display}")
            else:
                created += 1
                print(f"  + would   {display}")

        if args.yes:
            await session.commit()
            print(f"\nDone — created {created}, skipped {skipped} existing.")
        else:
            print(
                f"\nDRY RUN — {created} supplier(s) would be created, "
                f"{skipped} already exist. Re-run with --yes to apply."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
