"""freezer_warehouse_node_types

Add the Freezer and Warehouse areas to the location tree (SRS 2026-07-09 §6).

New node types:
  * Freezer:   room → room_location → sub_location   (sub_location = free leaf)
  * Warehouse: warehouse → shelf                      (shelf        = free leaf)

This migration only widens the two enum-style CHECK constraints on
``meta.location_nodes`` so the new types (and the new roots ``room`` /
``warehouse``) are accepted. The actual freezer/warehouse *rows* are seeded by
``scripts/seed_locations.py`` (nodes need a creating user, which a fresh DB does
not have until Cognito seeding runs — same pattern as the super-admin seed).

Constraint names in the DB carry the doubled ``ck_location_nodes_`` prefix
(the naming convention), so we ALTER them by their exact names via raw SQL.

Revision ID: freezerwh01
Revises: flatretire01
Create Date: 2026-07-14 14:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "freezerwh01"
down_revision: str | None = "flatretire01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Keep in lock-step with app.models.locations.NODE_TYPES / ROOT_NODE_TYPES.
_NODE_TYPES = (
    "tank_quadrant",
    "rack",
    "cassette",
    "cryo_box_rack",
    "box",
    "room",
    "room_location",
    "sub_location",
    "warehouse",
    "shelf",
    "flat",
    "cassette_rack",
    "sub_slot",
)
_ROOT_TYPES = ("tank_quadrant", "room", "warehouse", "flat")

_NODE_TYPE_CK = "ck_location_nodes_ck_location_nodes_node_type"
_ROOT_CK = "ck_location_nodes_ck_location_nodes_root_parentage"


def _in_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    op.execute(f"ALTER TABLE meta.location_nodes DROP CONSTRAINT {_NODE_TYPE_CK}")
    op.execute(
        f"ALTER TABLE meta.location_nodes ADD CONSTRAINT {_NODE_TYPE_CK} "
        f"CHECK (node_type = ANY (ARRAY[{_in_list(_NODE_TYPES)}]::text[]))"
    )

    op.execute(f"ALTER TABLE meta.location_nodes DROP CONSTRAINT {_ROOT_CK}")
    op.execute(
        f"ALTER TABLE meta.location_nodes ADD CONSTRAINT {_ROOT_CK} "
        f"CHECK ((node_type = ANY (ARRAY[{_in_list(_ROOT_TYPES)}]::text[])) "
        f"= (parent_id IS NULL))"
    )


def downgrade() -> None:
    # Restore the pre-freezer/warehouse constraint definitions.
    old_types = (
        "tank_quadrant",
        "rack",
        "cassette",
        "cryo_box_rack",
        "box",
        "flat",
        "cassette_rack",
        "sub_slot",
    )
    op.execute(f"ALTER TABLE meta.location_nodes DROP CONSTRAINT {_NODE_TYPE_CK}")
    op.execute(
        f"ALTER TABLE meta.location_nodes ADD CONSTRAINT {_NODE_TYPE_CK} "
        f"CHECK (node_type = ANY (ARRAY[{_in_list(old_types)}]::text[]))"
    )
    op.execute(f"ALTER TABLE meta.location_nodes DROP CONSTRAINT {_ROOT_CK}")
    op.execute(
        f"ALTER TABLE meta.location_nodes ADD CONSTRAINT {_ROOT_CK} "
        "CHECK ((node_type = ANY (ARRAY['tank_quadrant'::text, 'flat'::text])) "
        "= (parent_id IS NULL))"
    )
