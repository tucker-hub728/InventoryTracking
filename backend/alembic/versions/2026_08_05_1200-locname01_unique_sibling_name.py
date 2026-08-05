"""Unique sibling location names (REQ-2026-07-15-LOC-003).

Two active siblings sharing a name split one physical spot into two records
nobody can tell apart. ``code`` has been unique per parent since the location
system landed, but a code is generated and rarely seen — the NAME is what is
written on the freezer door and read off a picker, so it is the one that has to
be unambiguous. Dev had three collisions before this: two "Minus-80 Freezers"
under Cold Storage, two "T90019F" units inside one of them, and two "Box" nodes
under Rack 1.

Case-insensitive, and only over ACTIVE nodes: a retired freezer must not stop
its replacement taking the same equipment number. Roots (``parent_id IS NULL``)
are NOT covered — Postgres treats NULLs as distinct, so a partial index can't
see them; they are checked in the application exactly as the sibling-code rule
already is (see ``_require_unique_sibling_name``).

⚠ This migration FAILS if duplicates still exist. Clear them first:

    select parent_id, name, count(*), string_agg(id::text, ', ')
    from meta.location_nodes
    where is_active and parent_id is not null
    group by parent_id, lower(name) having count(*) > 1;

Renaming one of each pair is a data decision (which one is the real spot?), so
it is deliberately NOT scripted here.

Revision ID: locname01
Revises: esignbind01
"""

from __future__ import annotations

from alembic import op

revision = "locname01"
down_revision = "esignbind01"
branch_labels = None
depends_on = None

SIBLING_INDEX = "uq_location_nodes_parent_name_active"
UNIT_INDEX = "uq_location_nodes_unit_name_active"

# Types whose name is a physical identifier, not a label relative to a parent:
# a Cold Storage unit carries the client's equipment T-number (LOC-006), a
# Warehouse shelf its letter (LOC-005). Mirrors ``routes.UNIT_NODE_TYPES``.
UNIT_TYPES = "'sub_location', 'shelf'"


def upgrade() -> None:
    # Siblings: no two children of one parent share a name.
    op.execute(
        f"""
        CREATE UNIQUE INDEX {SIBLING_INDEX}
        ON meta.location_nodes (parent_id, lower(name))
        WHERE is_active AND parent_id IS NOT NULL
        """
    )
    # Units: no two anywhere share a name, because the name IS the equipment.
    # Structural names are excluded on purpose — every room legitimately has its
    # own "Minus-20 Freezers" and every rack its own "Box" (client 2026-08-05).
    op.execute(
        f"""
        CREATE UNIQUE INDEX {UNIT_INDEX}
        ON meta.location_nodes (node_type, lower(name))
        WHERE is_active AND node_type IN ({UNIT_TYPES})
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS meta.{UNIT_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS meta.{SIBLING_INDEX}")
