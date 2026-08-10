"""consum01: consumables, Kanban locations & expiration tracking

The Consumables / Kanban / Expiration module (REQ-2026-07-01-TRX-003,
REQ-2026-07-01-LOC-006/008, Transaction Spec 2026-07-01 §4, and the July 9
amendment's TRX-001/004/006). Four things land here:

  * a ``kanban`` node type — a NAMED location inside a production area
    (LOC-006, "a Kanban shall be representable as a named location"). Client
    decision 2026-08-10: a Kanban is a child of a production area, not the area
    itself, so one clean room can hold "Kanban 1" and "Kanban 2" separately.

    Note the pre-existing ``flat_category = 'kanban'`` value is NOT what we use
    and must stay unused: ``ck_location_nodes_root_parentage`` forces every
    ``flat`` node to be a root, so a flat/kanban node could never hang under a
    clean room. It is a leftover from the original July-1 reading of LOC-006 and
    is kept only so pre-existing rows validate.

    ``kanban`` is deliberately absent from ``STORAGE_NODE_TYPES``: under the
    client's Option A (consume-at-issue) a Kanban holds no lot allocations. It
    is an ADDRESS that a movement and an expiration record point at, not a
    balance. Adding it to that set is the whole of the Option B switch, should
    the client later want live Kanban on-hand.

  * a ``consumable_issue`` movement type — unit-OUT from a storage node INTO a
    Kanban. Terminal for quantity purposes (07-09 TRX-001, "kitting is terminal
    only for consumables"); never back-flushed (07-09 TRX-004, "consumables are
    never quantity-adjusted after issue").

  * ``app.consumable_issues`` — the issued-consumable register, holding the
    expiration FLAG STATE and nothing else. It cannot live on the movement (the
    ledger is append-only and the flag is mutable), on a stock row (the quantity
    was consumed at issue, so there is no balance) or on the lot (one lot issued
    to three Kanbans needs three independent checks). Every fact about the issue
    — item, lot, qty, Kanban, who, when — is read through ``movement_id``, and
    the expiration date through that movement's lot, so nothing is duplicated
    and nothing can drift.

  * one seeded "Kanban 1" per existing production area, so consumable issue
    works on day one without a Super Admin having to visit nine clean rooms.

Expiration is NOT swept by a job — it is a date comparison computed on read
(``app/consumables/repository.py``), the same reasoning
``app/inventory/archive_job.py`` records for its own sweep. The partial index
below is what makes that read cheap.

Revision ID: consum01
Revises: poarch01
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "consum01"
down_revision: str | None = "poarch01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ── Movement-type constraints ───────────────────────────────────────────
# SQLAlchemy's naming convention double-prefixes these; see ln2tank01.
_TYPE_CK = "ck_stock_movements_ck_movements_type"
_SIGN_CK = "ck_stock_movements_ck_movements_type_sign"
_LOCATIONS_CK = "ck_stock_movements_ck_movements_locations"

# The full type set as of ship01, before this migration.
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
)
_NEW_TYPES = (*_OLD_TYPES, "consumable_issue")

# Unit-IN types (qty_delta > 0) — unchanged, consumable_issue is unit-OUT.
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
)
_OUT_NEW = (*_OUT_OLD, "consumable_issue")

# Types carrying BOTH ends. consumable_issue joins them: it comes FROM a storage
# node and goes TO a Kanban, so the ledger says which room the gloves went to.
_BOTH_OLD = ("backflush", "kit_return", "kit_cancel_return")
_BOTH_NEW = (*_BOTH_OLD, "consumable_issue")

# ── Location-node constraints ───────────────────────────────────────────
_NODES = "meta.location_nodes"
_CK_TYPE = "ck_location_nodes_ck_location_nodes_node_type"
_CK_TYPE_LEGACY = "ck_location_nodes_node_type"

# Keep in lock-step with ``app.models.locations.NODE_TYPES``.
_NODE_TYPES_OLD = (
    "tank",
    "tank_quadrant",
    "rack",
    "box",
    "room",
    "room_location",
    "sub_location",
    "warehouse",
    "shelf",
    # Retired, kept so pre-existing rows still validate
    "flat",
    "cassette",
    "cryo_box_rack",
    "cassette_rack",
    "sub_slot",
)
_NODE_TYPES_NEW = (*_NODE_TYPES_OLD, "kanban")


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
    op.execute(
        f"ALTER TABLE app.stock_movements ADD CONSTRAINT {name} CHECK ({expr}){suffix}"
    )


def _apply_node_types(node_types: tuple[str, ...]) -> None:
    listed = _lst(node_types)
    for name in (_CK_TYPE, _CK_TYPE_LEGACY):
        op.execute(f"ALTER TABLE {_NODES} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {_NODES} ADD CONSTRAINT {_CK_TYPE} "
        f"CHECK (node_type IN ({listed})) NOT VALID"
    )


def upgrade() -> None:
    # 1 ── the Kanban node type. The root-parentage CHECK is untouched on
    # purpose: ``kanban`` is absent from its list, which is exactly what forces
    # every Kanban to have a parent (the production area).
    _apply_node_types(_NODE_TYPES_NEW)

    # 2 ── the consumable_issue movement type.
    _swap(_TYPE_CK, _type_ck(_NEW_TYPES), not_valid=False)
    _swap(_SIGN_CK, _sign_ck(_OUT_NEW), not_valid=False)
    # Stays NOT VALID for the reason kitting03 / kitting05 / ship01 set it so:
    # the append-only ledger holds legacy rows that pre-date several arms.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_NEW), not_valid=True)

    # 3 ── the issued-consumable register.
    #
    # Six columns, and only four of them carry information: this table holds the
    # FLAG STATE and nothing else. Item, lot, quantity, destination Kanban, who
    # and when are all read through ``movement_id``. ``app.stock_movements`` is
    # append-only, so a copy here could never legitimately differ from it — it
    # could only drift.
    op.create_table(
        "consumable_issues",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # UNIQUE: exactly one register row per ``consumable_issue`` movement.
        # A multi-lot issue posts one movement per source lot, so it gets one
        # flag per lot — which is what lets two lots with different expiries be
        # checked and cleared independently.
        sa.Column("movement_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        # Flag state. cleared_at NULL = still awaiting a physical check.
        sa.Column("cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cleared_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        # Transaction Spec §4.2's two clearing conditions, split into the four
        # dispositions it names: consumed before expiry, or removed and
        # dispositioned (reworked / retested / discarded).
        sa.Column("disposition", sa.Text(), nullable=True),
        sa.Column("clear_note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "disposition IS NULL OR disposition IN "
            "('consumed', 'reworked', 'retested', 'discarded')",
            name="ck_consumable_issues_disposition",
        ),
        # Cleared is all-or-nothing: a cleared row names who cleared it, when,
        # and why. An uncleared row carries none of the three.
        sa.CheckConstraint(
            "(cleared_at IS NULL) = (cleared_by_user_id IS NULL) "
            "AND (cleared_at IS NULL) = (disposition IS NULL)",
            name="ck_consumable_issues_cleared_complete",
        ),
        schema="app",
    )
    op.create_foreign_key(
        "fk_consumable_issues_movement_id",
        "consumable_issues",
        "stock_movements",
        ["movement_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_consumable_issues_cleared_by_user_id",
        "consumable_issues",
        "users",
        ["cleared_by_user_id"],
        ["id"],
        source_schema="app",
        referent_schema="app",
        ondelete="RESTRICT",
    )
    # The alert query's working set: rows still awaiting a physical check.
    # Item / Kanban / expiry filters all run on the movement and the lot, which
    # already carry their own indexes (ix_movements_item_id,
    # ix_movements_to_location_node_id, ix_lots_expiration_date).
    op.create_index(
        "ix_consumable_issues_open",
        "consumable_issues",
        ["cleared_at"],
        unique=False,
        schema="app",
        postgresql_where=sa.text("cleared_at IS NULL"),
    )

    # 4 ── seed one Kanban per existing production area.
    #
    # Consumable issue REQUIRES a Kanban destination (client decision: never the
    # room itself), and only a Super Admin may create one — so without this an
    # upgraded environment cannot issue a single glove until someone visits
    # every clean room. Named "Kanban 1" to match the client's own phrasing;
    # free-text rename via PATCH /location-nodes/{id}.
    #
    # created_by_user_id is NOT NULL on location_nodes and no migration has ever
    # inserted a location row for that reason. Here the column is filled from
    # the area's own creator, so the seed inherits a real, existing user and
    # invents nothing. Areas whose creator is somehow absent are skipped.
    op.execute(
        """
        INSERT INTO meta.location_nodes
            (id, parent_id, node_type, code, name, is_active, created_by_user_id)
        SELECT
            gen_random_uuid(),
            area.id,
            'kanban',
            'KAN-1',
            'Kanban 1',
            true,
            area.created_by_user_id
        FROM meta.location_nodes AS area
        WHERE area.node_type = 'flat'
          AND area.flat_category = 'production'
          AND area.is_active
          AND NOT EXISTS (
              SELECT 1 FROM meta.location_nodes AS k
              WHERE k.parent_id = area.id AND k.node_type = 'kanban'
          )
        """
    )


def downgrade() -> None:
    op.drop_table("consumable_issues", schema="app")

    # Remove only the Kanbans nothing points at — the seeded ones and any the
    # client added but never issued to.
    #
    # A Kanban that HAS been issued to is referenced by
    # ``stock_movements.to_location_node_id`` (FK, ON DELETE RESTRICT), and the
    # ledger is append-only, so those rows cannot go. Deleting unconditionally
    # would fail the whole downgrade on that FK. They are left in place instead,
    # which the restored CHECK tolerates because it is added NOT VALID —
    # the same retire-not-drop treatment ``LEGACY_NODE_TYPES`` gets.
    op.execute(
        """
        DELETE FROM meta.location_nodes AS k
        WHERE k.node_type = 'kanban'
          AND NOT EXISTS (
              SELECT 1 FROM app.stock_movements AS m
              WHERE m.to_location_node_id = k.id OR m.from_location_node_id = k.id
          )
        """
    )
    _apply_node_types(_NODE_TYPES_OLD)

    # Fails if any consumable_issue ledger row exists — the ledger is
    # append-only, so those must be drained / the branch rewound first.
    _swap(_LOCATIONS_CK, _locations_ck(_BOTH_OLD), not_valid=True)
    _swap(_SIGN_CK, _sign_ck(_OUT_OLD), not_valid=False)
    _swap(_TYPE_CK, _type_ck(_OLD_TYPES), not_valid=False)
