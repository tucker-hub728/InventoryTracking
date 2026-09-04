"""storage01: Storage gains a CATEGORY level (REQ-2026-08-04-LOC-001/004)

Amendment 8 asks that a new location be provisioned from a standard template
that "automatically includes a configurable shelf, refrigerator, and freezer",
which the client may rename and may leave unused. The client's structure:

    Storage            room              the room (seeded, code STG)
    └ Materials Mgmt   storage_category  <- this migration
      ├ Shelf          room_location     a template group
      │ └ T123213B     sub_location      the equipment unit, stock lives here
      ├ Refrigerator   room_location
      └ Freezer        room_location

Compare Cold Storage today — ``CS -> Minus-20 Freezers -> T90020B``, i.e.
``room -> room_location -> sub_location``. Storage is that exact chain with ONE
level inserted above it, which is deliberate: from the group down it is the same
model, so it reuses the same create route, the same dialogs and the same
components. The client intends Storage to replace the Cold Storage structure
later, and two spellings of one idea would make that migration harder, not
easier.

The groups are real nodes rather than a UI facet because LOC-001 lets the client
rename them, and a renameable thing that owns children is a node. Which groups a
category uses is simply WHICH GROUP NODES EXIST — an unused sub-type is an absent
node. So there is no flag column, no JSON blob and no second source of truth.

This migration therefore does exactly ONE thing: admit ``storage_category`` to
the ``node_type`` CHECK. Everything else is code —

  * the parentage rules (``storage_category -> room``, and ``room_location``
    gaining ``storage_category`` as a second legal parent) live in
    ``app.models.locations.PARENT_OF`` and are enforced by the create route, as
    every other level's already are;
  * ``ck_location_nodes_root_parentage`` is untouched — a category is never a
    root, and the roots are unchanged;
  * no table, no column, no index.

Added NOT VALID, matching ``mmroom01`` and ``ln2tank01``: an environment still
holding legacy rows that fail the existing CHECK can migrate first and clean up
after. Validate once clean with:

    ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
        ck_location_nodes_ck_location_nodes_node_type;

Downgrade narrows the CHECK back. Any ``storage_category`` row created in the
meantime would violate the restored rule, so the downgrade is NOT VALID too
rather than failing on real data — again matching ``ln2tank01``.

Revision ID: storage01
Revises: consum01
Create Date: 2026-08-12 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "storage01"
down_revision: str | None = "consum01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "meta.location_nodes"
# SQLAlchemy's naming convention prepends "ck_<table>_" to the name spelled out
# in the model, so the live constraint is double-prefixed. Dropping the short
# spelling alone is a silent no-op that leaves the old rule enforcing.
_CK_TYPE = "ck_location_nodes_ck_location_nodes_node_type"
_CK_TYPE_LEGACY = "ck_location_nodes_node_type"

# Keep in lock-step with ``app.models.locations.NODE_TYPES``.
_TYPES_NEW = (
    # LN2 cascade
    "tank",
    "tank_quadrant",
    "rack",
    "box",
    # Rooms — Materials Management, Cold Storage, Analytical Lab, Storage
    "room",
    "room_location",
    "sub_location",
    # The Storage template's category level (LOC-001)
    "storage_category",
    "warehouse",
    "shelf",
    # Kanban station inside a production area (LOC-006)
    "kanban",
    # Retired, kept so pre-existing rows still validate
    "flat",
    "cassette",
    "cryo_box_rack",
    "cassette_rack",
    "sub_slot",
)
_TYPES_OLD = tuple(t for t in _TYPES_NEW if t != "storage_category")


def _apply(node_types: tuple[str, ...]) -> None:
    listed = ", ".join(f"'{t}'" for t in node_types)
    for name in (_CK_TYPE, _CK_TYPE_LEGACY):
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CK_TYPE} "
        f"CHECK (node_type IN ({listed})) NOT VALID"
    )


def upgrade() -> None:
    _apply(_TYPES_NEW)


def downgrade() -> None:
    _apply(_TYPES_OLD)
