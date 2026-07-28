"""ship01: customer shipment — terminal ship-finished-good-out transaction

Adds the customer-shipment leg of the ledger (REQ-2026-07-22-CUST-001,
REQ-2026-07-01-TRX-005/006, resolved Q-2026-07-01-009):

  * a new ``customer_shipment`` movement type — a unit-OUT that leaves the
    system (``from`` set, ``to`` NULL), decrementing finished-goods stock only
    (no cascade to components, TRX-006);
  * ``stock_movements.customer_id`` — the named customer the good shipped to.
    NULLABLE by design: a named customer honours CUST-001, a NULL customer is
    the catalog / arbitrary-recipient shipment (TRX-007);
  * ``stock_movements.reference_number`` — the free-text tracking / sales-order
    number (TRX-005), which may differ from the drug-product identifier.

The three sibling CHECK constraints are re-created to admit the new type, the
same drop-and-recreate swap kitting05 used. The locations constraint stays
``NOT VALID`` (the ledger is append-only and pre-dates several arms), matching
kitting03 / kitting05.

Revision ID: ship01
Revises: kitting05
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "ship01"
down_revision: str | None = "kitting05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TYPE_CK = "ck_stock_movements_ck_movements_type"
_SIGN_CK = "ck_stock_movements_ck_movements_type_sign"
_LOCATIONS_CK = "ck_stock_movements_ck_movements_locations"

# The full type set as of kitting05, before this migration.
_OLD_TYPES = (
    "receipt",
    "dispense",
    "adjustment",
    "discard",
    "transfer_out",
    "transfer_in",
    "kit_issue",
    "kit_additional_issue",
    "production_output",
    "backflush",
    "kit_return",
    "kit_cancel_return",
)
_NEW_TYPES = (*_OLD_TYPES, "customer_shipment")

# Unit-IN types (qty_delta > 0). customer_shipment is unit-OUT, so IN is unchanged.
_IN = ("receipt", "transfer_in", "production_output", "backflush", "kit_return", "kit_cancel_return")
# Unit-OUT types (qty_delta < 0) — customer_shipment joins here.
_OUT_OLD = ("dispense", "discard", "transfer_out", "kit_issue", "kit_additional_issue")
_OUT_NEW = (*_OUT_OLD, "customer_shipment")

# Types carrying BOTH ends (source → production, production → storage).
_BOTH = ("backflush", "kit_return", "kit_cancel_return")


def _lst(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _type_ck(types: tuple[str, ...]) -> str:
    return f"movement_type IN ({_lst(types)})"


def _sign_ck(outs: tuple[str, ...]) -> str:
    return (
        f"(movement_type IN ({_lst(_IN)}) AND qty_delta > 0) "
        f"OR (movement_type IN ({_lst(outs)}) AND qty_delta < 0) "
        f"OR (movement_type = 'adjustment')"
    )


def _locations_ck(*, with_shipment: bool) -> str:
    shipment_arm = (
        " OR (movement_type = 'customer_shipment' "
        "AND from_location_node_id IS NOT NULL AND to_location_node_id IS NULL)"
        if with_shipment
        else ""
    )
    return (
        "(movement_type = 'receipt' AND from_location_node_id IS NULL) "
        "OR (movement_type IN ('dispense', 'discard')) "
        "OR (movement_type = 'transfer_out' AND to_location_node_id IS NULL) "
        "OR (movement_type = 'transfer_in' AND from_location_node_id IS NULL) "
        "OR (movement_type = 'adjustment') "
        "OR (movement_type IN ('kit_issue', 'kit_additional_issue') "
        "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL) "
        "OR (movement_type = 'production_output' "
        "    AND from_location_node_id IS NULL AND to_location_node_id IS NOT NULL) "
        f"OR (movement_type IN ({_lst(_BOTH)}) "
        "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL)"
        f"{shipment_arm}"
    )


def _swap(name: str, expr: str, *, not_valid: bool) -> None:
    op.execute(f"ALTER TABLE app.stock_movements DROP CONSTRAINT {name}")
    suffix = " NOT VALID" if not_valid else ""
    op.execute(f"ALTER TABLE app.stock_movements ADD CONSTRAINT {name} CHECK ({expr}){suffix}")


def upgrade() -> None:
    op.add_column(
        "stock_movements",
        sa.Column("customer_id", postgresql.UUID(as_uuid=True), nullable=True),
        schema="app",
    )
    op.add_column(
        "stock_movements",
        sa.Column("reference_number", sa.Text(), nullable=True),
        schema="app",
    )
    op.create_foreign_key(
        "fk_stock_movements_customer_id",
        "stock_movements",
        "customers",
        ["customer_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_movements_customer_id",
        "stock_movements",
        ["customer_id"],
        unique=False,
        schema="app",
        postgresql_where=sa.text("customer_id IS NOT NULL"),
    )

    _swap(_TYPE_CK, _type_ck(_NEW_TYPES), not_valid=False)
    _swap(_SIGN_CK, _sign_ck(_OUT_NEW), not_valid=False)
    # Stays NOT VALID for the same reason kitting03 / kitting05 set it so: the
    # append-only ledger holds legacy rows that predate several arms.
    _swap(_LOCATIONS_CK, _locations_ck(with_shipment=True), not_valid=True)


def downgrade() -> None:
    # Fails if any customer_shipment row exists — the ledger is append-only, so
    # those shipments must be drained / the branch rewound first.
    _swap(_LOCATIONS_CK, _locations_ck(with_shipment=False), not_valid=True)
    _swap(_SIGN_CK, _sign_ck(_OUT_OLD), not_valid=False)
    _swap(_TYPE_CK, _type_ck(_OLD_TYPES), not_valid=False)

    op.drop_index("ix_movements_customer_id", table_name="stock_movements", schema="app")
    op.drop_constraint(
        "fk_stock_movements_customer_id", "stock_movements", schema="app", type_="foreignkey"
    )
    op.drop_column("stock_movements", "reference_number", schema="app")
    op.drop_column("stock_movements", "customer_id", schema="app")
