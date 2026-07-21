"""kitting05: split the manual return / cancel return from the close-out back-flush

Three genuinely different business events were all writing
``movement_type = 'backflush'``, so only the free-text ``notes`` told them
apart — and the ledger's Transaction column shows the type, not the notes:

  * an operator hands excess back mid-production   (REQ-2026-07-01-TRX-008)
  * the kit is cancelled and everything comes back
  * the signed close-out reconciliation             (REQ-2026-07-09-TRX-003)

TRX-003 mandates ``backflushed`` for *"returned leftover material"* at
reconciliation; it does not ask the manual return to borrow that type. This
mirrors the split the module already makes between ``kit_issue`` and
``kit_additional_issue`` — physically identical movements kept apart because
they are different business events.

Both new types share the back-flush shape: unit-IN (qty_delta > 0), moving from
the production node to a storage node, so they slot into the same CHECK arms.

Revision ID: kitting05
Revises: kitting03
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "kitting05"
down_revision: str | None = "kitting03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TYPE_CK = "ck_stock_movements_ck_movements_type"
_SIGN_CK = "ck_stock_movements_ck_movements_type_sign"
_LOCATIONS_CK = "ck_stock_movements_ck_movements_locations"

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
)
_NEW_TYPES = (*_OLD_TYPES, "kit_return", "kit_cancel_return")

# Unit-IN types (qty_delta > 0) — the two new return types join this arm.
_IN_OLD = ("receipt", "transfer_in", "production_output", "backflush")
_IN_NEW = (*_IN_OLD, "kit_return", "kit_cancel_return")
_OUT = ("dispense", "discard", "transfer_out", "kit_issue", "kit_additional_issue")

# Types that carry BOTH ends (source → production, production → storage).
_BOTH_OLD = ("backflush",)
_BOTH_NEW = ("backflush", "kit_return", "kit_cancel_return")


def _lst(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _type_ck(types: tuple[str, ...]) -> str:
    return f"movement_type IN ({_lst(types)})"


def _sign_ck(ins: tuple[str, ...]) -> str:
    return (
        f"(movement_type IN ({_lst(ins)}) AND qty_delta > 0) "
        f"OR (movement_type IN ({_lst(_OUT)}) AND qty_delta < 0) "
        f"OR (movement_type = 'adjustment')"
    )


def _locations_ck(both: tuple[str, ...]) -> str:
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
        f"OR (movement_type IN ({_lst(both)}) "
        "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL)"
    )


def _swap(name: str, expr: str, *, not_valid: bool) -> None:
    op.execute(f"ALTER TABLE app.stock_movements DROP CONSTRAINT {name}")
    suffix = " NOT VALID" if not_valid else ""
    op.execute(f"ALTER TABLE app.stock_movements ADD CONSTRAINT {name} CHECK ({expr}){suffix}")


def upgrade() -> None:
    _swap(_TYPE_CK, _type_ck(_NEW_TYPES), not_valid=False)
    _swap(_SIGN_CK, _sign_ck(_IN_NEW), not_valid=False)
    # Stays NOT VALID for the same reason kitting03 set it so: pre-kitting03
    # kit_issue rows have a NULL destination and the ledger is append-only.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_NEW), not_valid=True)


def downgrade() -> None:
    # Fails if any kit_return / kit_cancel_return row exists — the ledger is
    # append-only, so drain or soft-delete those kits first.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_OLD), not_valid=True)
    _swap(_SIGN_CK, _sign_ck(_IN_OLD), not_valid=False)
    _swap(_TYPE_CK, _type_ck(_OLD_TYPES), not_valid=False)
