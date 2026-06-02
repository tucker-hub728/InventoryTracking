"""seed_vendors_from_workbook

Data-only migration: inserts the 73 distinct vendor names from the
``Demo Inventory Control.xlsx`` workbook into ``meta.vendors``. The
master tracker only carries the vendor *name*; every other column
(``contact_email``, ``phone``, ``avg_lead_days``, ``address``) is left
NULL / default for the admin to fill in later.

Faithful to the workbook — known data-quality quirks are preserved
rather than silently corrected:

* Spelling variants (``Biomerieux`` / ``Biomeriuex`` / ``BioMerieux Inc``
  / ``bioMerieux, Inc.``; ``Miltenyi`` / ``Miltenyi Biote`` /
  ``Miltenyi-BioTec``; ``Thermo Fisher`` / ``Thermo Fisher Scientific``
  / ``ThermoFisher``)
* Multi-vendor cells (``VWR, Fisher Scientific``)
* One row with a literal newline inside the cell
  (``VWR, Fisher Scientific\\n2) Fisher Scientific``)
* Two rows that look like data entered into the wrong column
  (``Cell Staining Buffer``, ``PMS``)

Cleaning these up is the admin's job once vendor-edit ships
(deferred to the audit module — see the v1 MVP doc §3).

Idempotent: ``ON CONFLICT DO NOTHING`` on the partial-unique
``lower(name)`` index so re-running the migration on a non-empty table
is safe (e.g. for a partial backfill or running in a shared dev env).

Revision ID: e052b2ffa00b
Revises: b7c6522aca73
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import insert as pg_insert


revision: str = "e052b2ffa00b"
down_revision: str | None = "b7c6522aca73"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# 73 unique vendor names extracted from frontend/src/lib/data/seed.ts —
# which itself is the auto-converted form of the workbook (see
# ``project_xlsx_sync_script`` memory). Kept verbatim from the workbook.
WORKBOOK_VENDORS: list[str] = [
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


def upgrade() -> None:
    # Reference table inline so the migration stays decoupled from the
    # ORM model definition. ``index_elements`` matches the partial-unique
    # ``uq_vendors_name`` on ``lower(name)``.
    vendors = sa.table(
        "vendors",
        sa.column("name", sa.Text()),
        schema="meta",
    )
    stmt = pg_insert(vendors).values(
        [{"name": n} for n in WORKBOOK_VENDORS]
    )
    stmt = stmt.on_conflict_do_nothing(
        index_elements=[sa.text("lower(name)")],
    )
    op.get_bind().execute(stmt)


def downgrade() -> None:
    # Remove only the rows this migration inserted — match by name so we
    # don't blow away any vendors the admin created after the seed ran.
    conn = op.get_bind()
    conn.execute(
        sa.text("DELETE FROM meta.vendors WHERE lower(name) = ANY(:names)"),
        {"names": [n.lower() for n in WORKBOOK_VENDORS]},
    )
