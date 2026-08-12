"""loccode01: deleting a location frees its code, as it already frees its name

A unit deleted and then re-added under the same equipment number was refused:

    POST /location-nodes {name: "T90020213Z", code: "T90020213Z"}
    409 node_code_conflict — "A sibling with code 'T90020213Z' already exists here"

…even though nothing active carried that name or code. The two uniqueness rules
disagreed about what deletion means. Both NAME indexes from ``locname01`` are
partial on ``is_active``:

    uq_location_nodes_parent_name_active  WHERE (is_active AND parent_id IS NOT NULL)
    uq_location_nodes_unit_name_active    WHERE (is_active AND node_type IN (…))

…while the CODE index, which predates them, is not:

    uq_location_nodes_parent_code         (parent_id, code)

So a delete freed the name and kept the code. Freeing the name is the deliberate
behaviour — ``get_sibling_by_name`` states it outright: "a retired freezer
shouldn't block its replacement from taking the same equipment number." The code
index silently defeated that, and for a ``sub_location`` it defeats it every
time, because the add dialog sends the name AS the code (LOC-006 keeps a unit's
identifier one free-text field the system never parses or decomposes). The user
therefore hit a rule about a field that is not shown anywhere in the interface.

This migration makes the code rule agree with the name rules. Deletion is soft,
so "already exists here" now means "is actually there", for both fields.

Only the index changes; no row is touched. It strictly LOOSENS the constraint —
every row that satisfied the old index satisfies the new one — so it cannot fail
on existing data.

Downgrade re-tightens it. That CAN fail, on exactly the data this fix makes
possible: two rows sharing a code under one parent, at most one of them active.
It is written to report which rows collide rather than dying inside Postgres, so
the operator knows what to reconcile.

Revision ID: loccode01
Revises: storage01
Create Date: 2026-08-12 14:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "loccode01"
down_revision: str | None = "storage01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "meta.location_nodes"
_INDEX = "uq_location_nodes_parent_code"


def upgrade() -> None:
    # Created as a table-level UniqueConstraint originally, so it may exist as a
    # CONSTRAINT rather than a bare index depending on how the DB was built
    # (the restore01 dump and the SQLAlchemy metadata differ). Drop whichever is
    # there — dropping the constraint takes its backing index with it.
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS meta.{_INDEX}")
    op.execute(
        f"CREATE UNIQUE INDEX {_INDEX} ON {_TABLE} (parent_id, code) WHERE is_active"
    )


def downgrade() -> None:
    # Re-tightening can only fail because of rows this fix allowed. Name them,
    # rather than letting Postgres raise on an index build with no context.
    conn = op.get_bind()
    dupes = conn.execute(
        sa.text(
            f"""
            SELECT parent_id, code, count(*) AS n
            FROM {_TABLE}
            WHERE parent_id IS NOT NULL
            GROUP BY parent_id, code
            HAVING count(*) > 1
            ORDER BY n DESC
            LIMIT 20
            """
        )
    ).fetchall()
    if dupes:
        listed = ", ".join(f"{r.code!r} x{r.n} under {r.parent_id}" for r in dupes)
        raise RuntimeError(
            "Cannot restore the unconditional code index: these (parent, code) "
            f"pairs are now duplicated, one row per pair being inactive — {listed}. "
            "Re-code or hard-delete the inactive rows first."
        )
    op.execute(f"DROP INDEX IF EXISTS meta.{_INDEX}")
    op.execute(f"CREATE UNIQUE INDEX {_INDEX} ON {_TABLE} (parent_id, code)")
