"""esignbind01: bind an e-signature to the record it signs

A reauth ticket recorded WHO signed and WHAT KIND of action they signed for
(``lot.update``), but not WHICH record. Nothing compared the record the
operator was looking at against the record the write actually touched, so
within the 120-second TTL one ticket authorised its action against any row of
that type. 21 CFR Part 11 §11.70 asks for the opposite: a signature linked to
the specific record.

**Subject, not target — these are different things.**

``audit.reauth_consumptions`` already carries ``target_table``/``target_id``,
and it is tempting to reuse them. That would be wrong. Those record the row
the write PRODUCED — for a stock movement, the ``stock_movements`` row created
during the transaction. It does not exist when the operator signs, so it can
never be bound at issuance.

What CAN be bound is the SUBJECT: the thing the operator had on screen and was
attesting about — the lot, the kit, the item, the user. Hence new columns here
rather than a reuse of the existing pair. Both are worth keeping: the subject
proves what was signed for, the target records what happened.

**Nullable on purpose.** Three flows genuinely have no subject — creating a
tier, a prefix, or a BOM line, where the record does not exist yet. Those stay
bound to the action alone, which is the honest answer rather than inventing an
id. Nullable also means every reauth row written before this migration stays
valid, so the rollout needs no flag day.

Revision ID: esignbind01
Revises: esignimg01
Create Date: 2026-08-03 14:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "esignbind01"
down_revision: str | None = "esignimg01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ALTER TABLE is DDL, so the append-only triggers on this table (which
    # block UPDATE/DELETE/TRUNCATE) do not intercept it.
    op.add_column(
        "reauth_events",
        sa.Column("record_table", sa.Text(), nullable=True),
        schema="audit",
    )
    op.add_column(
        "reauth_events",
        sa.Column("record_id", sa.UUID(), nullable=True),
        schema="audit",
    )
    # Both or neither. A half-specified subject would silently weaken the
    # check at consumption, where the comparison is skipped when the evidence
    # carries no subject at all.
    op.create_check_constraint(
        "ck_reauth_events_record_pair",
        "reauth_events",
        "(record_table IS NULL) = (record_id IS NULL)",
        schema="audit",
    )
    # Answers the auditor's question — "what did this person sign for?" —
    # without a full scan of the signature table.
    op.create_index(
        "ix_reauth_events_record",
        "reauth_events",
        ["record_table", "record_id"],
        schema="audit",
        postgresql_where=sa.text("record_table IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_reauth_events_record", "reauth_events", schema="audit")
    op.drop_constraint(
        "ck_reauth_events_record_pair", "reauth_events", schema="audit", type_="check"
    )
    op.drop_column("reauth_events", "record_id", schema="audit")
    op.drop_column("reauth_events", "record_table", schema="audit")
