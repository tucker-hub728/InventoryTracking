"""issue01: the Issue transaction & scrap locations (REQ-2026-08-04-TRX-001/002)

Amendment 8 asks for **debit-and-gone destinations**: "transacting material to
them removes it from inventory entirely, in the same manner as a customer
shipment", naming PD/R&D and the QC labs.

The client's model, settled 2026-08-13, is that debit-and-gone is a TRANSACTION
TYPE, not a location type. One physical area supports both actions and the
operator picks which one happened:

    Transfer  → QC 1 › Freezer 1    stock stays tracked, at the new node
    Issue     → QC 1                stock leaves controlled inventory

So there is no scrap node type and no scrap sub-location. A scrap location is an
ordinary ``storage_category`` carrying a marker, and the marker's ONLY job is to
say which locations the Issue action may target. Two things land here:

  * ``meta.location_nodes.is_scrap`` — the marker, set at creation and immutable
    afterwards (the route enforces that; there is nothing to enforce here). It is
    a plain boolean rather than a node type precisely so a scrap location keeps
    its shelf / refrigerator / freezer groups and can still RECEIVE transfers
    into them — the client's rule 2, "the same physical area may support both
    Transfer and Issue".

    NOT NULL DEFAULT FALSE, so every existing location is a normal one and no
    behaviour changes until somebody ticks the box. No index: the destination
    list filters an already-tiny set (one row per location the client has).

  * a ``material_issue`` movement type — unit-OUT from a storage node INTO the
    scrap location. Terminal: the units are gone, no allocation is created at the
    destination, and nothing back-flushes it. It is the general-item sibling of
    ``consumable_issue`` (consum01) and is spelled ``material_issue`` rather than
    ``issue`` so the two can never be mistaken for one another at a glance.

    BOTH ends are set, like ``consumable_issue`` and unlike ``customer_shipment``
    (which has no destination at all). That is the whole point: the ledger has to
    say WHICH lab consumed the material, because "issued to QC 1" and "issued to
    PD" are different dispositions even though both leave inventory.

The "issued and stored" state the client explicitly rules out (their rule 5) is
unrepresentable rather than merely validated against: ``POST /issues`` accepts
only a ``storage_category`` destination and ``POST /allocations/transfer*``
accepts only ``box`` / ``sub_location`` / ``shelf``. The two sets are disjoint,
so no single request can express both.

Revision ID: issue01
Revises: loccode01
Create Date: 2026-08-13 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "issue01"
down_revision: str | None = "loccode01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NODES = "meta.location_nodes"

# SQLAlchemy's naming convention double-prefixes these; see ln2tank01 / consum01.
_TYPE_CK = "ck_stock_movements_ck_movements_type"
_SIGN_CK = "ck_stock_movements_ck_movements_type_sign"
_LOCATIONS_CK = "ck_stock_movements_ck_movements_locations"

# The full type set as of consum01, before this migration.
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
    "customer_shipment",
    "consumable_issue",
)
_NEW_TYPES = (*_OLD_TYPES, "material_issue")

# Unit-IN types (qty_delta > 0) — unchanged; material_issue is unit-OUT.
_IN = (
    "receipt",
    "transfer_in",
    "production_output",
    "backflush",
    "kit_return",
    "kit_cancel_return",
)
_OUT_OLD = (
    "dispense",
    "discard",
    "transfer_out",
    "kit_issue",
    "kit_additional_issue",
    "customer_shipment",
    "consumable_issue",
)
_OUT_NEW = (*_OUT_OLD, "material_issue")

# Types carrying BOTH ends. material_issue joins them for the reason
# consumable_issue did: it comes FROM a storage node and goes TO a named
# destination, and the ledger has to record which one.
_BOTH_OLD = ("backflush", "kit_return", "kit_cancel_return", "consumable_issue")
_BOTH_NEW = (*_BOTH_OLD, "material_issue")


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
        "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NOT NULL) "
        "OR (movement_type = 'customer_shipment' "
        "    AND from_location_node_id IS NOT NULL AND to_location_node_id IS NULL)"
    )


def _swap(name: str, expr: str, *, not_valid: bool) -> None:
    op.execute(f"ALTER TABLE app.stock_movements DROP CONSTRAINT {name}")
    suffix = " NOT VALID" if not_valid else ""
    op.execute(f"ALTER TABLE app.stock_movements ADD CONSTRAINT {name} CHECK ({expr}){suffix}")


def upgrade() -> None:
    # 1 ── the scrap marker. Server default as well as the NOT NULL: existing
    # rows need a value, and so does every INSERT that predates the ORM change.
    op.add_column(
        "location_nodes",
        sa.Column(
            "is_scrap",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="meta",
    )
    # Only a location (``storage_category``) can be a scrap destination. Marking
    # a shelf, a box or a room would let the Issue destination list offer a place
    # that is also a legal TRANSFER target, which is exactly the ambiguity the
    # disjoint-destination rule exists to prevent. Enforced here rather than only
    # in the route because it is an invariant of the row, not of one request.
    op.create_check_constraint(
        "ck_location_nodes_scrap_category_only",
        "location_nodes",
        "NOT is_scrap OR node_type = 'storage_category'",
        schema="meta",
    )

    # 2 ── the material_issue movement type.
    _swap(_TYPE_CK, _type_ck(_NEW_TYPES), not_valid=False)
    _swap(_SIGN_CK, _sign_ck(_OUT_NEW), not_valid=False)
    # Stays NOT VALID for the reason kitting03 / kitting05 / ship01 / consum01
    # set it so: the append-only ledger holds legacy rows that pre-date several
    # arms of this constraint.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_NEW), not_valid=True)


def downgrade() -> None:
    # Fails if any material_issue ledger row exists — the ledger is append-only,
    # so those must be drained / the branch rewound first. Same contract as
    # consum01's downgrade.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_OLD), not_valid=True)
    _swap(_SIGN_CK, _sign_ck(_OUT_OLD), not_valid=False)
    _swap(_TYPE_CK, _type_ck(_OLD_TYPES), not_valid=False)

    op.drop_constraint(
        "ck_location_nodes_scrap_category_only", "location_nodes", schema="meta", type_="check"
    )
    op.drop_column("location_nodes", "is_scrap", schema="meta")
