"""uom01: tiered unit of measure — order in Box, consume in Each (REQ-001)

An item may now be bought in one unit and used in another: order 3 Box, receive
3 Box, place 300 Each. Until now an item carried a single free-text
``items.uom`` and nothing anywhere recorded that a box holds a hundred of
something.

Two columns and one widening. The shape is deliberately small, and the reasons
are worth writing down because three obvious-looking alternatives are all
wrong:

  * **``ordered_qty`` and ``qty_received`` are NOT touched, and both stay in
    ORDER units.** The buyer orders 3 Box and the receiver confirms 3 Box, so
    ``ordered_qty - Σ qty_received`` is boxes minus boxes and keeps meaning
    exactly what it always meant. Every consumer of that subtraction —
    ``derive_order_status``, ``_order_to_read``'s outstanding, the on-order
    valuation — therefore needs no change at all. Storing the order line in
    consume units instead would have been the other defensible design, but it
    rewrites the meaning of a live column on a table that already has rows.

  * **The multiplication happens once, at receive**, when the lot is created:
    ``lots.ordered_qty = qty_received × units_per_pack``. That column is in
    CONSUME units and always has been — it caps how many units may be placed
    into locations, and placement has always been unit-by-unit. So the boundary
    between "boxes" and "each" is exactly one line of application code, not a
    conversion scattered through the ledger.

  * **The pack lives on the order line and nowhere else — in particular, not
    on the item.** A pack is a property of a purchase, not of a material: the
    same glove is bought by the Box from one supplier and by the Case from
    another, and either supplier may re-pack next year. An item-level default
    was built first and then taken out. It looked like a second home for the
    answer while being only a pre-fill — resolved once, when a PO line was
    created, and never consulted again — so the moment a supplier changed pack
    the item said one thing, every line said another, and the item's copy was
    the one that looked authoritative. ``docs/modules/inventory.md`` records
    the same conclusion being reached once before: the master workbook's
    "Units Per package configuration" column was dropped in v2 §8 precisely
    because package sizes vary. The line's copy is also the load-bearing one
    for GxP: it is frozen when the PO is raised, so a supplier moving from
    Box/100 to Case/500 cannot rewrite what a historical order says it bought.

Both columns are nullable, with no backfill and no default. A line with both
NULL is ordered in the unit the item is used in, which is every line that
exists today; they keep behaving exactly as they did. The CHECK stops the
halfway state — a factor with no unit — from reaching the database, while
deliberately permitting the other half: ``pack_uom`` set with
``units_per_pack`` NULL is a PO for "3 Box" whose count is confirmed at
receive, which is the only point anyone is actually holding the boxes.

The widening of ``lots.unit_price_amount`` to six decimal places is not
cosmetic. The lot's price is now derived by division: $95.00 for a box of three
is $31.666… each, and at two decimal places that is $31.67, which multiplied
back is $95.01. Money invented by rounding. The order line's price is never
divided, so it stays at 2dp.

Revision ID: uom01
Revises: relstate02
Create Date: 2026-08-21 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "uom01"
down_revision: str | None = "relstate02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── The order line: the pack as it was on the day the PO was raised ──
    op.add_column(
        "receipt_transaction_lines",
        sa.Column("pack_uom", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "receipt_transaction_lines",
        sa.Column("units_per_pack", sa.Integer(), nullable=True),
        schema="app",
    )
    # A unit may stand alone; a factor may not. The buyer may order "3 Box"
    # without yet knowing how many are in a box, and the receiver supplies the
    # count at receive. But a bare 100 with nothing to be 100 *of* is
    # meaningless, and would silently multiply a plain per-unit order.
    op.create_check_constraint(
        "ck_receipt_transaction_lines_pack_pair",
        "receipt_transaction_lines",
        "(pack_uom IS NULL AND units_per_pack IS NULL) "
        "OR (pack_uom IS NOT NULL AND char_length(trim(pack_uom)) > 0 "
        "AND (units_per_pack IS NULL OR units_per_pack > 0))",
        schema="app",
    )

    # ── Room for a divided price ──
    # 14,2 → 14,6. Widening only: every existing value survives untouched, and
    # nothing that reads this column cares about the extra scale.
    op.alter_column(
        "lots",
        "unit_price_amount",
        existing_type=sa.Numeric(14, 2),
        type_=sa.Numeric(14, 6),
        existing_nullable=True,
        schema="app",
    )


def downgrade() -> None:
    # Narrowing back to 2dp ROUNDS any derived per-unit price that used the
    # extra scale. Nothing is lost that was not itself derived, but the values
    # will not multiply back to their pack price exactly.
    op.alter_column(
        "lots",
        "unit_price_amount",
        existing_type=sa.Numeric(14, 6),
        type_=sa.Numeric(14, 2),
        existing_nullable=True,
        schema="app",
    )
    op.drop_constraint(
        "ck_receipt_transaction_lines_pack_pair",
        "receipt_transaction_lines",
        type_="check",
        schema="app",
    )
    op.drop_column("receipt_transaction_lines", "units_per_pack", schema="app")
    op.drop_column("receipt_transaction_lines", "pack_uom", schema="app")
