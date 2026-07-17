"""Rename bom_lines.qty_per_run → qty_per_unit.

A BOM line's quantity is now defined as "how many of the child ONE parent
consumes", not "how many per production run".

Per-run was unusable: no run-size/batch-size column exists anywhere in the
schema, and none of the four requirement documents mention one. Without a run
size, a per-run quantity cannot answer REQ-2026-07-09-PLN-002 ("explode the
bill of materials backward and produce a to-order report ... required to
execute the plan") — you cannot scale "24 per run" to a plan of 50 units
without knowing how many units a run yields.

Per-unit needs no extra field: required = qty_per_unit × plan_qty, and the
kit quantity needed (Transaction Spec §2, Table 1 "Quantity Needed [from BOM]")
= qty_per_unit × build_qty. It also matches Transaction Spec §3.1, where the
quantity produced is a variable rather than a fixed batch.

This is a pure rename: existing values are carried across untouched. At the
time of writing the table holds a single throwaway test row, so no value
re-interpretation is required. Constraint names are spelled out literally —
the metadata naming convention is ``ck_%(table_name)s_%(constraint_name)s``
and the model passes an already-``ck_``-prefixed name, so the real name is
double-prefixed.

Revision ID: bomqty01
Revises: tierrename01
"""

from __future__ import annotations

from alembic import op

revision: str = "bomqty01"
down_revision: str | None = "tierrename01"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.alter_column("bom_lines", "qty_per_run", new_column_name="qty_per_unit", schema="app")
    op.execute(
        "ALTER TABLE app.bom_lines RENAME CONSTRAINT "
        "ck_bom_lines_ck_bom_lines_qty_per_run_positive TO "
        "ck_bom_lines_ck_bom_lines_qty_per_unit_positive"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE app.bom_lines RENAME CONSTRAINT "
        "ck_bom_lines_ck_bom_lines_qty_per_unit_positive TO "
        "ck_bom_lines_ck_bom_lines_qty_per_run_positive"
    )
    op.alter_column("bom_lines", "qty_per_unit", new_column_name="qty_per_run", schema="app")
