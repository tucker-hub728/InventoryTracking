"""relstate02: label the manufactured stock that predates release tracking

REQ-2026-07-31-STS-001. A data-only migration — no schema change.

``relstate01`` added ``lots.release_state`` nullable, with no server default and
no backfill, and justified it like this: "a DEFAULT here would have quarantined
every consumable ever received." That much was right. The conclusion drawn from
it was not — the fix for a consumable problem is to SCOPE the backfill by tier,
not to skip it. As shipped, every sub-assembly and finished-good lot created
before 2026-08-17 carries no label at all, and the only way to give it one is to
open each lot and sign a decision by hand.

New lots are unaffected either way: kit close-out sets ``quarantine`` at the
moment of manufacture (``app/kitting/routes.py``). This migration is purely
about the history that predates that code.

Four things are deliberate here:

  * **``quarantine``, because it is the only honest value.** It does not mean
    "somebody decided to hold this"; it means NO RELEASE DECISION HAS BEEN
    RECORDED — which is exactly, literally true of every lot this touches.
    Backfilling ``released`` would invent a QC decision that no one ever made
    and no signature stands behind. That is the one thing a regulated record
    must never do, so it is not offered as an option.

  * **Scoped to the built tiers.** Only ``sub_assembly`` and ``finished_good``
    have a release workflow. Raw materials and consumables stay NULL, which
    renders as no badge — the state relstate01 was protecting, and it is
    preserved exactly.

    The ``NOT is_consumable`` guard is not redundant with the tier filter. The
    "consumable is a CR-only flag" rule lives in the new-item dialog, not in the
    database and not in the API, so nothing today stops a built item from
    carrying it. A lot whose item is flagged consumable has a terminal
    transaction defined elsewhere and no release workflow, whatever tier it sits
    in.

  * **Idempotent, by ``release_state IS NULL``.** Re-running it is a no-op, and
    it can never overwrite a real decision — including a ``rejected`` one, which
    is the failure that would matter most.

  * **Soft-deleted lots included.** The label belongs to the lot, not to its
    visibility. Filtering on ``deleted_at`` would leave a hole that reappears
    the moment a lot is restored, and a restored lot arriving unlabelled is a
    worse surprise than a label on a hidden row nobody reads.

**One consequence to know about.** Some of these lots have already been shipped
or fully consumed, and they get the label too, so the record will show a
``quarantine`` lot that left the building. The state is a CURRENT attribute of
the lot, not a claim about what was true on the shipping date, and nothing reads
it to gate anything (STS-003) — but if the client would rather leave the
already-gone history unlabelled, one predicate does it, and re-running is safe
because of the guard above::

    AND EXISTS (SELECT 1 FROM app.lot_allocations a
                 WHERE a.lot_id = l.id AND a.is_active AND a.qty > 0)

**No audit events are written.** STS-002 wants an actor and a timestamp on every
release change, and a migration can supply neither — it runs unattended, with no
session, no user and no e-signature. Writing a row per lot would dress a system
act up as a human QC decision, which is worse than recording nothing: it would
be the only entry in ``audit.audit_events`` (every row of which is ``actor_kind
= 'user'``) that names a decision nobody made. What actually happened here is a
one-off system act, and the thing that records it is this migration.

Revision ID: relstate02
Revises: relstate01
Create Date: 2026-08-19 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "relstate02"
down_revision: str | None = "relstate01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Raw SQL rather than the ORM: a migration must read the schema as it stood at
# this revision, and `app/models/inventory.py` moves on. The join walks
# lot → item → prefix → tier because prefixes02 made the tier reachable only
# through the prefix (`items.tier_id` was dropped).
_BACKFILL = sa.text(
    """
    UPDATE app.lots AS l
       SET release_state = 'quarantine'
      FROM app.items AS i
      JOIN app.item_prefixes AS p ON p.id = i.prefix_id
      JOIN app.item_tiers AS t ON t.id = p.tier_id
     WHERE i.id = l.item_id
       AND l.release_state IS NULL
       AND NOT i.is_consumable
       AND t.type IN ('sub_assembly', 'finished_good')
    """
)


def upgrade() -> None:
    result = op.get_bind().execute(_BACKFILL)
    # Printed so the deploy log carries the blast radius. A backfill that
    # silently reports nothing is one nobody can confirm ran against the
    # environment they think it did — and this one is invisible in the schema.
    print(f"relstate02: quarantined {result.rowcount} previously unlabelled built-tier lot(s)")


def downgrade() -> None:
    """Intentionally a no-op.

    Nothing distinguishes a lot this migration labelled from one that kit
    close-out labelled a minute earlier: both read ``quarantine`` with no audit
    trail behind them. Setting every ``quarantine`` lot back to NULL would strip
    the label off legitimately manufactured stock, and no smaller rule is
    correct either.

    The real undo is ``relstate01``'s downgrade, which drops the column and
    takes this data with it.
    """
