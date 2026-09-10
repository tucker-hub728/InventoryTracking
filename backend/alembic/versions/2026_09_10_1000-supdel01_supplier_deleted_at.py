"""supdel01: suppliers gain a second, deliberate delete step.

A supplier already had two states — active, and deactivated via
``DELETE /suppliers/{id}`` (a soft delete, ``is_active=false``). Deactivating
hides it from every item and lot picker but leaves it on the Deactivated tab,
which is where the client can still see it. They asked for a way to remove it
from view entirely without destroying the record.

So there are now THREE states, and the two flags do two different jobs:

    active        is_active=true   deleted_at NULL   in pickers, on the Active tab
    deactivated   is_active=false  deleted_at NULL   hidden from pickers, on the
                                                     Deactivated tab, name STILL taken
    deleted       is_active=false  deleted_at SET    gone from the whole UI,
                                                     name RELEASED

``is_active`` controls VISIBILITY; ``deleted_at`` controls IDENTITY. Nothing is
ever hard-deleted — ``app.lots``, ``meta.item_suppliers`` and
``app.receipt_transaction_lines`` all FK here with ON DELETE RESTRICT, and the
audit trail wants to keep resolving a supplier name on historic rows forever.

Why the unique index has to change
----------------------------------
``uq_suppliers_name`` was UNIQUE on ``lower(name)`` with NO predicate, so a name
was reserved for the life of the row — a deactivated "Invitrogen" blocked a new
one permanently. That is the wrong default for a client consolidating a supplier
list: they retire a mis-typed name and can never reuse it.

Making it partial on ``deleted_at IS NULL`` means deleting a supplier RELEASES
its name, while merely deactivating one does not. Deletion becomes the
deliberate act that gives the name up, which is exactly what distinguishes the
two steps.

Replacing a total unique index with a partial one is strictly WEAKER, so this
cannot fail on existing data — every row that satisfied the old index satisfies
the new one. The downgrade CAN fail, and says so.

Revision ID: supdel01
Revises: varyield01
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "supdel01"
down_revision: str | None = "varyield01"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "meta.suppliers"
_NAME_INDEX = "uq_suppliers_name"
_STATE_CHECK = "ck_suppliers_deleted_implies_inactive"


def upgrade() -> None:
    op.add_column(
        "suppliers",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema="meta",
    )

    # A deleted supplier is necessarily also deactivated — the route refuses to
    # delete an active one, and this stops any other path (a script, raw SQL)
    # producing the one combination the UI has no way to represent.
    op.create_check_constraint(
        _STATE_CHECK,
        "suppliers",
        "deleted_at IS NULL OR is_active = false",
        schema="meta",
    )

    # Names are released on delete, not on deactivate.
    op.execute(f"DROP INDEX IF EXISTS meta.{_NAME_INDEX}")
    op.execute(
        f"""
        CREATE UNIQUE INDEX {_NAME_INDEX}
        ON {_TABLE} (lower(name))
        WHERE deleted_at IS NULL
        """
    )


def downgrade() -> None:
    # ⚠ This FAILS if any deleted supplier shares a name with a live one — which
    # is the whole point of the upgrade, so it is expected once the feature has
    # been used. Resolve by renaming or restoring first; which row keeps the
    # name is a data decision and is deliberately NOT scripted here.
    op.execute(f"DROP INDEX IF EXISTS meta.{_NAME_INDEX}")
    op.execute(f"CREATE UNIQUE INDEX {_NAME_INDEX} ON {_TABLE} (lower(name))")
    op.drop_constraint(_STATE_CHECK, "suppliers", schema="meta", type_="check")
    op.drop_column("suppliers", "deleted_at", schema="meta")
