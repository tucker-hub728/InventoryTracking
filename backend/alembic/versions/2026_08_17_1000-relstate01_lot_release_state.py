"""relstate01: release state on a lot (REQ-2026-07-31-STS-001/002/003)

Manufactured product needs a release label — is this batch cleared for use or not —
and until now nothing carried one. A batch became ordinary stock the moment it
was placed.

Four values, fixed (client 2026-08-17): ``quarantine``, ``qc_hold``,
``released``, ``rejected``. A native enum rather than TEXT + CHECK, matching
``user_role`` / ``item_tier`` / ``location_category`` from rolesenum01.

Three decisions are baked into the shape of this migration:

  * **A new column, not a reuse of ``lots.status``.** That column already means
    something else entirely — a PROCUREMENT state, ``on_order`` or
    ``available``. The two would be read for one another forever. Called
    ``release_state`` rather than ``release_status`` for the same reason: one
    letter of difference between two live columns on one table is a bug waiting
    to be written.

  * **Nullable, with no default and no backfill.** Every lot in the database
    gets this column, including consumables and raw materials that have no
    release workflow at all. Rather than invent a fifth value meaning "not
    applicable", an untracked lot is simply NULL: no state, no badge, nothing
    shown. Only lots produced by a kit start life with a value, set in
    application code at the point of manufacture. A DEFAULT here would have
    quarantined every consumable ever received.

  * **No history table.** STS-002 wants who and when recorded on each change;
    ``audit.audit_events`` already carries actor, timestamp, before/after JSONB
    and the e-signature id, is indexed on ``(subject_table, subject_id,
    occurred_at DESC)``, is already whitelisted for ``app.lots`` in the audit
    API, and — the part a new table would not have inherited — is append-only,
    enforced by trigger. Same call ROL-009 made for role grants.

Nothing existing is altered. Per STS-003 the feature layers on top of LN2 and
leaves every prior behaviour intact; there is nothing here for it to break.

Revision ID: relstate01
Revises: issue01
Create Date: 2026-08-17 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "relstate01"
down_revision: str | None = "issue01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUM = "app.lot_release_state"

# Mirrors ``LOT_RELEASE_STATES`` in app/models/inventory.py. Declaration order
# is the workflow's reading order (held → under review → decided), which is what
# ``ORDER BY release_state`` gives you for free on a native enum.
_STATES: tuple[str, ...] = ("quarantine", "qc_hold", "released", "rejected")


def _enum_values(values: Sequence[str]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    op.execute(f"CREATE TYPE {_ENUM} AS ENUM ({_enum_values(_STATES)})")
    op.add_column(
        "lots",
        sa.Column(
            "release_state",
            sa.Enum(*_STATES, name="lot_release_state", schema="app", create_type=False),
            nullable=True,
        ),
        schema="app",
    )
    # Partial: the overwhelming majority of lots are consumables and raw
    # materials that will never hold a state, and they are dead weight in an
    # index whose only query is "show me what is on hold".
    op.create_index(
        "ix_lots_release_state",
        "lots",
        ["release_state"],
        unique=False,
        schema="app",
        postgresql_where=sa.text("release_state IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_lots_release_state", table_name="lots", schema="app")
    op.drop_column("lots", "release_state", schema="app")
    op.execute(f"DROP TYPE {_ENUM}")
