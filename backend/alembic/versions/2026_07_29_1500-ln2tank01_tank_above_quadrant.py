"""ln2tank01: LN2 gains a Tank above the quadrants (REQ-2026-07-15-LOC-001)

LOC-001 models LN2 as tank (the top level, identified by its main tank number) →
four quadrants per tank → racks within each quadrant. The build had the QUADRANT
as the root, with no tank above it, so the tank number had nowhere to live.

This migration adjusts the two CHECKs that encode the shape:

  * ``node_type`` — admits the new ``tank``. ``cassette`` and ``cryo_box_rack``
    stay listed even though they are retired (the client dropped them on
    2026-07-29 so a Box hangs directly off a Rack), because retire-not-drop
    keeps any pre-existing row valid.
  * ``root_parentage`` — ``tank_quadrant`` is no longer a root; ``tank`` is.

The parentage rules themselves (tank → tank_quadrant → rack → box) live in
``app.models.locations.PARENT_OF`` and are enforced by the create route, as
every other level's already are. The four-per-tank cap is enforced there too:
it counts siblings, which a CHECK constraint cannot do.

No rows are touched. The LN2 tree is empty at the time of writing, so nothing
needs re-parenting; both CHECKs are added NOT VALID anyway, matching
``mmroom01``, so an environment that still holds legacy LN2 rows can migrate
first and clean up after. Validate once clean with:

    ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
        ck_location_nodes_ck_location_nodes_root_parentage;

Revision ID: ln2tank01
Revises: mmroom01
Create Date: 2026-07-29 15:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "ln2tank01"
down_revision: str | None = "mmroom01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "meta.location_nodes"
# SQLAlchemy's naming convention prepends "ck_<table>_" to the name spelled out
# in the model, so both live constraints are double-prefixed. Dropping the short
# spelling alone is a silent no-op that leaves the old rule enforcing.
_CK_ROOT = "ck_location_nodes_ck_location_nodes_root_parentage"
_CK_TYPE = "ck_location_nodes_ck_location_nodes_node_type"
_CK_ROOT_LEGACY = "ck_location_nodes_root_parentage"
_CK_TYPE_LEGACY = "ck_location_nodes_node_type"

# Keep in lock-step with ``app.models.locations``.
_TYPES_NEW = (
    # LN2 cascade
    "tank",
    "tank_quadrant",
    "rack",
    "box",
    # Materials Management
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
_TYPES_OLD = tuple(t for t in _TYPES_NEW if t != "tank")

_ROOTS_NEW = ("tank", "room", "flat")
_ROOTS_OLD = ("tank_quadrant", "room", "flat")


def _apply(node_types: tuple[str, ...], roots: tuple[str, ...]) -> None:
    listed = ", ".join(f"'{t}'" for t in node_types)
    rooted = ", ".join(f"'{t}'" for t in roots)
    for name in (_CK_TYPE, _CK_TYPE_LEGACY):
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CK_TYPE} "
        f"CHECK (node_type IN ({listed})) NOT VALID"
    )
    for name in (_CK_ROOT, _CK_ROOT_LEGACY):
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CK_ROOT} "
        f"CHECK ((node_type IN ({rooted})) = (parent_id IS NULL)) NOT VALID"
    )


def upgrade() -> None:
    _apply(_TYPES_NEW, _ROOTS_NEW)


def downgrade() -> None:
    # Reverting drops ``tank`` from the allowed types, so any tank row created
    # since would violate the restored CHECK — hence NOT VALID here too, rather
    # than failing the downgrade on real data.
    _apply(_TYPES_OLD, _ROOTS_OLD)
