"""locseed01: validate the location shape, and keep location ROWS out of migrations

Two jobs, both about the same boundary: a migration owns the *shape* of the
location tree, and a seed script owns its *rows*.

1. Validate the two location CHECKs that are still NOT VALID
------------------------------------------------------------
``mmroom01`` (Warehouse One moves inside a room) and ``ln2tank01`` (a Tank above
the quadrants) both added their CHECKs ``NOT VALID`` so an environment holding
pre-existing rows in the old shape could migrate first and clean up afterwards.
Both told the reader to validate once the tree had been reseeded:

    ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
        ck_location_nodes_ck_location_nodes_root_parentage;

That reseed has happened, so this migration does it — turning the two rules from
"checked on write only" into "checked, and proven for every existing row".
``VALIDATE`` takes only a SHARE UPDATE EXCLUSIVE lock, so it does not block
reads or writes on the table.

A deployed environment might still hold rows in the old shape (a top-level
``warehouse``, or a root ``tank_quadrant``), so the offenders are counted FIRST
and reported by code — a bare ``VALIDATE`` failure names the constraint but not
the rows, which is the one thing you need to fix it.

When there ARE offenders this **logs them and skips**, leaving that constraint
``NOT VALID``. It does not fail. Prod runs ``alembic upgrade head`` as a one-shot
service the backend waits on, so a migration that refuses takes the deployment
down with it — which is exactly what happened on 2026-07-30, over five legacy
root quadrants and one top-level warehouse. Skipping costs nothing real:
``NOT VALID`` still enforces the rule on every INSERT and UPDATE, and forfeits
only the re-check of rows that are legitimately legacy.

2. No migration creates, moves or deletes a location row
--------------------------------------------------------
Every ``meta.location_nodes`` row now comes from a script under
``backend/scripts/`` — one per area, so an area can be re-seeded on its own:

    seed_materials_management.py   Warehouse One (Shelf A–Z) + Minus-20 Freezers
    seed_cold_storage.py          Minus-20 / Minus-80 Freezers
    seed_analytical_lab.py        one Minus-20, one Minus-80
    seed_production.py            six clean rooms
    seed_locations.py             runs all four

Migrations cannot honestly own a location row: ``created_by_user_id`` is NOT
NULL and a fresh database has no users until Cognito seeding runs, so a seeding
migration either fails or silently creates nothing.

The audit behind this migration found no ``INSERT`` into ``meta.location_nodes``
in any of the 61 revisions, so there is nothing to delete here. What it did find
were two migration-side row *mutations*, both left in place deliberately:

  * ``kitting01.downgrade()`` — ``DELETE FROM meta.location_nodes WHERE
    node_type = 'flat' AND flat_category = 'production'``. Not seeding: it
    clears the rows that would violate the restored ``flat_category`` CHECK, and
    it only ever runs when reverting Kitting entirely. Removing it would make
    that downgrade fail on any database with a production area.
  * ``flatretire01.upgrade()`` — deactivates the legacy ``flat`` locations
    (kanban / lab / qc / engineering / materials). A one-way retire of rows that
    predate the area seeds, not a creation.

``kitting01``'s docstring claimed it seeded "the five advisory production floors"
— it never did, the script always owned them. That comment is corrected in the
same change as this migration (text only; the applied migration's behaviour is
untouched).

No table, column, index or default changes shape. Reversible: the downgrade puts
both CHECKs back to NOT VALID, which is a catalogue flag flip, not a data change.

Revision ID: locseed01
Revises: mvpath01
Create Date: 2026-07-30 10:00:00.000000+00:00
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from alembic import op

_LOG = logging.getLogger("alembic.runtime.migration")

revision: str = "locseed01"
down_revision: str | None = "mvpath01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "meta.location_nodes"

# SQLAlchemy's naming convention prepends "ck_<table>_" to the name spelled out
# in the model, so the live constraints are double-prefixed. Using the short
# spelling here is a silent no-op that validates nothing.
_CK_ROOT = "ck_location_nodes_ck_location_nodes_root_parentage"
_CK_TYPE = "ck_location_nodes_ck_location_nodes_node_type"

# Keep in lock-step with ``app.models.locations`` — these mirror what
# ``ln2tank01`` installed, and are re-stated only to rebuild the NOT VALID
# constraints on downgrade.
_NODE_TYPES = (
    "tank",
    "tank_quadrant",
    "rack",
    "box",
    "room",
    "room_location",
    "sub_location",
    "warehouse",
    "shelf",
    "flat",
    "cassette",
    "cryo_box_rack",
    "cassette_rack",
    "sub_slot",
)
_ROOT_TYPES = ("tank", "room", "flat")


def _listed(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _offenders(where: str) -> list[tuple[str, str, str]]:
    """Rows violating a rule, as (node_type, code, name). Empty = clean."""
    rows = op.get_bind().exec_driver_sql(
        f"SELECT node_type, code, name FROM {_TABLE} "  # noqa: S608 - fixed table
        f"WHERE NOT ({where}) ORDER BY node_type, code LIMIT 20"
    )
    return [(r[0], r[1], r[2]) for r in rows]


def _validate_if_clean(label: str, where: str, fix: str) -> bool:
    """VALIDATE the constraint when every row already satisfies it.

    When some rows do NOT, this logs them and SKIPS — it does not raise. That
    distinction matters more than it looks:

    Validating is a tidy-up, not a correctness fix. ``NOT VALID`` only means
    Postgres never re-checked the rows that existed when the constraint was
    added; it still enforces the rule on every INSERT and UPDATE. So skipping
    leaves the database exactly as safe for new data as validating would, and
    forfeits only the guarantee about historical rows — which are precisely the
    rows that are legitimately legacy.

    An earlier version raised instead, and that was wrong: prod runs
    ``alembic upgrade head`` as a one-shot service the backend waits on, so a
    migration that refuses takes the whole deployment down. A cleanup step must
    never be able to do that. Once the legacy rows are gone, validate by hand:

        ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
            ck_location_nodes_ck_location_nodes_root_parentage;
        ALTER TABLE meta.location_nodes VALIDATE CONSTRAINT
            ck_location_nodes_ck_location_nodes_node_type;
    """
    bad = _offenders(where)
    if not bad:
        op.execute(f"ALTER TABLE {_TABLE} VALIDATE CONSTRAINT {label}")
        return True

    listing = "\n".join(f"    {t:<14} {c:<20} {n}" for t, c, n in bad)
    _LOG.warning(
        "Leaving %s NOT VALID: %d row(s) in %s are in the old shape (first 20 "
        "shown). New and updated rows are still checked; only the historical "
        "re-check is skipped.\n%s\n\n%s",
        label,
        len(bad),
        _TABLE,
        listing,
        fix,
    )
    return False


def upgrade() -> None:
    root_rule = f"(node_type IN ({_listed(_ROOT_TYPES)})) = (parent_id IS NULL)"
    type_rule = f"node_type IN ({_listed(_NODE_TYPES)})"

    _validate_if_clean(
        _CK_TYPE,
        type_rule,
        "Each row above carries a node_type this build no longer knows. Decide "
        "per row whether to re-type it or delete it.",
    )
    _validate_if_clean(
        _CK_ROOT,
        root_rule,
        "A top-level 'warehouse' predates mmroom01 (LOC-005 puts Warehouse One "
        "inside the Materials Management room) or a root 'tank_quadrant' "
        "predates ln2tank01 (LOC-001 puts a Tank above it). Re-hang them with "
        "PATCH /location-nodes/{id}/parent, or reseed the tree "
        "(scripts/reset_db.py --keep-reference, then scripts/seed_locations.py "
        "--yes), then validate by hand — see _validate_if_clean.",
    )


def downgrade() -> None:
    # Postgres has no "invalidate"; the flag only clears by replacing the
    # constraint. Both are rebuilt with the same bodies, NOT VALID again, so a
    # database that was migrated down keeps accepting whatever it already holds.
    for name, rule in (
        (_CK_TYPE, f"node_type IN ({_listed(_NODE_TYPES)})"),
        (
            _CK_ROOT,
            f"(node_type IN ({_listed(_ROOT_TYPES)})) = (parent_id IS NULL)",
        ),
    ):
        op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {name}")
        op.execute(
            f"ALTER TABLE {_TABLE} ADD CONSTRAINT {name} CHECK ({rule}) NOT VALID"
        )
