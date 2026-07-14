"""retire_flat_locations

Retire the ``flat`` operational locations (kanban / lab / qc / engineering /
materials). The LN2 area keeps only its storage hierarchy
(tank_quadrant → rack → cassette/cryo_box_rack → box); free-placement moves to
the Freezer / Warehouse areas (built separately).

This is a *retire-not-drop*:

* ``flat`` stays in the ``node_type`` CHECK enum so any pre-existing flat rows
  still read/serialise — the model just moves it out of the creatable set and
  out of the placement targets (handled in code, no DDL needed).
* Any existing flat nodes are **deactivated** (``is_active = FALSE``) so they
  drop out of the active listings / placement pickers. Their rows and any
  historical allocations survive for read/audit.

The consume / transfer-to-flat operation code is intentionally left in place but
dormant (no flat targets exist) until the free-placement areas land.

Revision ID: flatretire01
Revises: invtoken01
Create Date: 2026-07-14 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "flatretire01"
down_revision: str | None = "invtoken01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Deactivate any existing flat locations so they leave the active flow.
    # No-op on a DB that already has none.
    op.execute(
        "UPDATE meta.location_nodes "
        "SET is_active = FALSE "
        "WHERE node_type = 'flat' AND is_active = TRUE"
    )


def downgrade() -> None:
    # We can't know which flat nodes were active before the retire, so this is a
    # one-way data change. Re-enabling them (if ever needed) is a manual step.
    pass
