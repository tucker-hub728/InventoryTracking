"""pln01: supplier lead time (PLN-001)

Adds ``meta.suppliers.lead_time_days`` — how many days this supplier takes to
deliver, counted from order to receipt.

**This deliberately restores a column that was deleted.** Revision
``d0e1f2a3b4c5`` dropped ``meta.vendors.avg_lead_days`` on 2026-06-02 as
"redundant … lead time is tracked per inventory item". PLN-001 reverses that
judgement, and the client confirmed the reading on 2026-08-24: a lead time is a
property of *who you buy from*, not of the material. The same buffer that was
right when the item had one implicit vendor is wrong now that
``meta.item_suppliers`` is a many-to-many — a reagent stocked by a local
distributor at 5 days and an overseas manufacturer at 60 has no single
item-level answer, and the old column had to pick one.

``app.items.avg_lead_days`` is **left exactly as it is** — not dropped, not
backfilled from here, not read by planning. The client asked for it to stay
put (2026-08-24). It keeps whatever an operator typed into it; it simply is not
what the reorder screen reads. Removing it is a separate decision on a column
that already has data, and folding it into this migration would mean guessing
which supplier each item's number was meant to describe.

Nullable with no default and no backfill, because "we have not asked this
supplier yet" is a real and common state, and zero is not it — zero would read
as "delivers same day" and suppress exactly the early warning PLN-001 exists to
give. Planning therefore treats NULL as unknown and says so on the row, rather
than inventing a number.

The CHECK mirrors ``ck_items_reorder_threshold_nonneg``: a negative delivery
time is not a slow supplier, it is bad data.

Revision ID: pln01
Revises: uom01
Create Date: 2026-08-24 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "pln01"
down_revision: str | None = "uom01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "suppliers",
        sa.Column("lead_time_days", sa.Integer(), nullable=True),
        schema="meta",
    )
    # Upper bound matches the item-level field's schema validation (0..3650):
    # ten years is not a lead time, it is a typo in the year column.
    op.create_check_constraint(
        "ck_suppliers_lead_time_days_range",
        "suppliers",
        "lead_time_days IS NULL OR (lead_time_days >= 0 AND lead_time_days <= 3650)",
        schema="meta",
    )


def downgrade() -> None:
    # Values are lost. They live nowhere else — ``app.items.avg_lead_days`` is
    # a different, independently-edited number and is never written from here,
    # so it cannot be used to reconstruct them.
    op.drop_constraint(
        "ck_suppliers_lead_time_days_range",
        "suppliers",
        schema="meta",
        type_="check",
    )
    op.drop_column("suppliers", "lead_time_days", schema="meta")
