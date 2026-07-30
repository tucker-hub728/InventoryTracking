"""mmroom01: Warehouse One moves inside a room (REQ-2026-07-15-LOC-005)

LOC-005 makes the Materials Management room a location category containing two
peer locations — Warehouse One (ambient shelving) and Minus-20 Freezers (cold
storage). Until now ``warehouse`` was a ROOT node type, so Warehouse One floated
at the top level beside the rooms instead of sitting inside one.

This migration only relaxes the root-parentage CHECK so a ``warehouse`` may
carry a ``parent_id``. It moves no rows: the parentage rule itself
(``warehouse`` may only hang under a ``room``) lives in
``app.models.locations.PARENT_OF`` and is enforced by the repository on create,
which is where every other level's rule already lives.

The new constraint is added NOT VALID, matching ``ck_movements_locations``: any
pre-existing top-level warehouse row stays legal, while every new or updated row
is checked. Once the location tree has been reseeded (``scripts/reset_db.py
--keep-reference`` then ``scripts/seed_locations.py``), the constraint can be
validated with:

    ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
        ck_location_nodes_root_parentage;

No data is destroyed and no column changes shape.

Revision ID: mmroom01
Revises: ship02
Create Date: 2026-07-29 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "mmroom01"
down_revision: str | None = "ship02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "meta.location_nodes"
# The live constraint is DOUBLE-PREFIXED: SQLAlchemy's naming convention
# prepends "ck_<table>_" to the name already spelled out in the model's
# ``CheckConstraint(..., name="ck_location_nodes_root_parentage")``. Dropping the
# short name alone is a silent no-op that leaves the old rule enforcing.
_CONSTRAINT = "ck_location_nodes_ck_location_nodes_root_parentage"
# ...and the short name, in case an environment was built before the convention
# took effect. Both are dropped IF EXISTS so either history converges here.
_CONSTRAINT_LEGACY = "ck_location_nodes_root_parentage"

# Root node types AFTER this migration — keep in lock-step with
# ``app.models.locations.ROOT_NODE_TYPES``. ``flat`` is retired but kept so
# legacy production-area rows still validate.
_ROOTS_NEW = ("tank_quadrant", "room", "flat")
# ...and before it, for the downgrade.
_ROOTS_OLD = ("tank_quadrant", "room", "warehouse", "flat")


def _root_check(node_types: tuple[str, ...]) -> str:
    """The parentage CHECK body: root types have no parent, others must."""
    listed = ", ".join(f"'{t}'" for t in node_types)
    return f"(node_type IN ({listed})) = (parent_id IS NULL)"


def _replace(node_types: tuple[str, ...]) -> None:
    """Drop both spellings of the parentage CHECK, then add it back."""
    for name in (_CONSTRAINT, _CONSTRAINT_LEGACY):
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} "
        f"CHECK ({_root_check(node_types)}) NOT VALID"
    )


def upgrade() -> None:
    _replace(_ROOTS_NEW)


def downgrade() -> None:
    # Reverting re-admits ``warehouse`` as a root. Any warehouse that has since
    # been given a parent would violate the old rule, so this is added NOT VALID
    # too rather than failing the downgrade on real data.
    _replace(_ROOTS_OLD)
