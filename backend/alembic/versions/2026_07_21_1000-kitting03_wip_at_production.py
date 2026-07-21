"""kitting03: WIP at the production node + returns (TRX-008)

Corrects a spec violation in the shipped build — see docs/modules/kitting.md
§0.3a and the delivery plan docs/modules/kitting-wip-build.md.

`CellReady_Transaction_Spec_2026-07-01` §2 requires the material's location to
be updated to the production/manufacturing location when it is kitted. The
shipped build wrote `kit_issue` with `to_location_node_id = NULL`, so issued
material left inventory and existed only as numbers on the kit.

Two changes:

1. `ck_movements_locations` — `kit_issue` / `kit_additional_issue` now carry
   BOTH ends (source → production node) and `backflush` carries BOTH ends
   (production node → return node). Signs are NOT touched, so `v_item_stock`
   arithmetic (and REQ-2026-07-09-TRX-001's "50 on hand, 25 kitted, report 25")
   is unchanged.
2. `kit_lines.early_returned_qty` — material handed back BEFORE close-out, per
   REQ-2026-07-01-TRX-008 ("return excess items back into inventory ... without
   assigning them to a lot number, so returned stock is never stranded").

Forward-only, matching kitting02: kitting01/02 are applied on the shared dev DB
and `app.stock_movements` is append-only.

Revision ID: kitting03
Revises: kitting02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "kitting03"
down_revision: str | None = "kitting02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# NOTE: CHECK names double-prefix through the naming convention
# ("ck_movements_locations" -> "ck_stock_movements_ck_movements_locations"),
# so the SHORT name goes into op.* calls. The locations constraint is managed
# with raw SQL (to pass NOT VALID), so it needs the FULL doubled name.
_LOCATIONS_CK = "ck_stock_movements_ck_movements_locations"

# Both issue types and backflush now set from AND to; production_output stays
# to-only; every non-kit case is carried over verbatim from kitting01.
_LOCATIONS_NEW = (
    "(movement_type = 'receipt' AND from_location_node_id IS NULL) "
    "OR (movement_type IN ('dispense', 'discard')) "
    "OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL) "
    "OR (movement_type = 'transfer_in' AND from_location_node_id IS NULL) "
    "OR (movement_type = 'adjustment') "
    "OR (movement_type IN ('kit_issue', 'kit_additional_issue') "
    "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL) "
    "OR (movement_type = 'production_output' "
    "    AND from_location_node_id IS NULL AND to_location_node_id IS NOT NULL) "
    "OR (movement_type = 'backflush' "
    "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL)"
)

_LOCATIONS_OLD = (
    "(movement_type = 'receipt' AND from_location_node_id IS NULL) "
    "OR (movement_type IN ('dispense', 'discard')) "
    "OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL) "
    "OR (movement_type = 'transfer_in' AND from_location_node_id IS NULL) "
    "OR (movement_type = 'adjustment') "
    "OR (movement_type IN ('kit_issue', 'kit_additional_issue') "
    "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NULL) "
    "OR (movement_type IN ('production_output', 'backflush') "
    "    AND from_location_node_id IS NULL AND to_location_node_id IS NOT NULL)"
)

# used <= issued + additional - early_returned  (§0.7 over-use guard, now net of
# anything already handed back).
_NO_OVERUSE_NEW = (
    "used_qty IS NULL " "OR used_qty <= issued_qty + additional_issued_qty - early_returned_qty"
)
_NO_OVERUSE_OLD = "used_qty IS NULL OR used_qty <= issued_qty + additional_issued_qty"


def upgrade() -> None:
    # 1. Movement locations — kit moves now record both ends.
    #
    #    Added NOT VALID on purpose. Every kit_issue/kit_additional_issue row
    #    already in the ledger was written under the old rule with
    #    to_location_node_id IS NULL, so a validating ADD CONSTRAINT would fail
    #    — and app.stock_movements is append-only (immutability triggers), so
    #    those rows cannot be rewritten. NOT VALID enforces the corrected rule
    #    on all NEW rows while grandfathering the historical ones, which is the
    #    honest record: they really were written under the wrong model.
    op.execute(f"ALTER TABLE app.stock_movements DROP CONSTRAINT {_LOCATIONS_CK}")
    op.execute(
        f"ALTER TABLE app.stock_movements ADD CONSTRAINT {_LOCATIONS_CK} "
        f"CHECK ({_LOCATIONS_NEW}) NOT VALID"
    )

    # 2. Early (pre-close-out) returns — REQ-2026-07-01-TRX-008.
    op.add_column(
        "kit_lines",
        sa.Column(
            "early_returned_qty",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Material returned to inventory before close-out (TRX-008)",
        ),
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_early_returned_qty_nonneg",
        "kit_lines",
        "early_returned_qty >= 0",
        schema="app",
    )
    op.create_check_constraint(
        "ck_kit_lines_return_le_issued",
        "kit_lines",
        "early_returned_qty <= issued_qty + additional_issued_qty",
        schema="app",
    )

    # 3. Over-use guard is now net of early returns.
    op.drop_constraint("ck_kit_lines_no_overuse", "kit_lines", schema="app", type_="check")
    op.create_check_constraint(
        "ck_kit_lines_no_overuse", "kit_lines", _NO_OVERUSE_NEW, schema="app"
    )


def downgrade() -> None:
    # NOTE: fails if any kit_issue/kit_additional_issue/backflush row already
    # carries both ends (i.e. was written under kitting03). The ledger is
    # append-only, so such rows cannot be rewritten — drain/soft-delete those
    # kits first, exactly as kitting02 documented.
    op.drop_constraint("ck_kit_lines_no_overuse", "kit_lines", schema="app", type_="check")
    op.create_check_constraint(
        "ck_kit_lines_no_overuse", "kit_lines", _NO_OVERUSE_OLD, schema="app"
    )
    op.drop_constraint("ck_kit_lines_return_le_issued", "kit_lines", schema="app", type_="check")
    op.drop_constraint(
        "ck_kit_lines_early_returned_qty_nonneg", "kit_lines", schema="app", type_="check"
    )
    op.drop_column("kit_lines", "early_returned_qty", schema="app")

    op.execute(f"ALTER TABLE app.stock_movements DROP CONSTRAINT {_LOCATIONS_CK}")
    op.execute(
        f"ALTER TABLE app.stock_movements ADD CONSTRAINT {_LOCATIONS_CK} "
        f"CHECK ({_LOCATIONS_OLD}) NOT VALID"
    )
