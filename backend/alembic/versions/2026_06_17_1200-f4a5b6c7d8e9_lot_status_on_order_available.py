"""lot_status_on_order_available

Replace the lot-status set with the client's two core statuses —
``on_order`` and ``available`` — and drop "quarantine" entirely
(explicitly rejected to avoid discrepancies between the system status
and the physical quarantine area).

The previous set was ``(quarantined, released, expired, recalled)``.
Per the agreed mapping:

  * every existing lot collapses to ``available`` (the dominant state was
    ``released`` = accepted & usable; quarantined/expired/recalled also
    fold in for now). Expiry is already date-driven (``expiration_date``),
    so it no longer needs a manual status. ``on_order`` is set manually
    going forward for stock placed on a PO but not yet received.

How "Released / QC Hold / Rejected" ultimately map into this model is
deferred to the team and intentionally NOT encoded here.

Touches three things, in order (data first so nothing violates the new
CHECK mid-migration):
  1. remap rows → available
  2. swap the ``status`` CHECK + column default
  3. rebuild the partial expiry index (its WHERE referenced the old
     "active" statuses)

Reversible. The downgrade restores the old CHECK / default / index and
collapses the new statuses back to ``released`` — lossy (the original
quarantined/expired/recalled distinctions are gone), but functional.

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "f4a5b6c7d8e9"
down_revision: str | None = "e3f4a5b6c7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Doubled-prefix name, matching the metadata naming convention already in
# force on app.lots (see ck_lots_ck_lots_status).
_CK = "ck_lots_ck_lots_status"
_IX = "ix_lots_expiration_date"


def upgrade() -> None:
    # 1) Drop the old CHECK FIRST — otherwise the remap below is rejected
    #    by it ('available' isn't in the old allowed set).
    op.execute(f"ALTER TABLE app.lots DROP CONSTRAINT IF EXISTS {_CK}")

    # 2) Collapse every existing status to the new 'available' state.
    op.execute("UPDATE app.lots SET status = 'available' WHERE status <> 'available'")

    # 3) Add the new CHECK + default.
    op.execute(
        f"ALTER TABLE app.lots ADD CONSTRAINT {_CK} "
        "CHECK (status IN ('on_order', 'available'))"
    )
    op.execute("ALTER TABLE app.lots ALTER COLUMN status SET DEFAULT 'available'")

    # 3) Rebuild the partial expiry index over the new 'active' statuses.
    op.execute(f"DROP INDEX IF EXISTS app.{_IX}")
    op.execute(
        f"CREATE INDEX {_IX} ON app.lots (expiration_date) "
        "WHERE status IN ('available', 'on_order')"
    )


def downgrade() -> None:
    # Drop the new CHECK first, then collapse statuses back to the old
    # default so the restored old CHECK passes.
    op.execute(f"ALTER TABLE app.lots DROP CONSTRAINT IF EXISTS {_CK}")
    op.execute(
        "UPDATE app.lots SET status = 'released' WHERE status IN ('on_order', 'available')"
    )
    op.execute(
        f"ALTER TABLE app.lots ADD CONSTRAINT {_CK} "
        "CHECK (status IN ('quarantined', 'released', 'expired', 'recalled'))"
    )
    op.execute("ALTER TABLE app.lots ALTER COLUMN status SET DEFAULT 'released'")

    op.execute(f"DROP INDEX IF EXISTS app.{_IX}")
    op.execute(
        f"CREATE INDEX {_IX} ON app.lots (expiration_date) "
        "WHERE status IN ('released', 'quarantined')"
    )
