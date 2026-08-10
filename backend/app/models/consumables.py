"""Issued-consumable register — the Kanban side of the consumables module.

One row per ``consumable_issue`` ledger movement, holding **only** the flag
state. Everything factual about the issue — item, lot, quantity, destination
Kanban, who, when — is read through ``movement``, never copied here:
``app.stock_movements`` is append-only, so a copy could never legitimately
differ from it, and two versions of one fact only ever drift.

The table exists for one reason. The expiration flag is *mutable* (Transaction
Spec §4.2: the operator clears it after a physical check) and the ledger cannot
be updated. The other two homes were considered and rejected:

* a **stock row** — under consume-at-issue (07-09 TRX-001) the quantity left
  inventory at issue, so there is no balance to hang it on;
* a **second movement** — clearing a flag is not a stock change; a zero-qty row
  breaks the sign CHECK, and every read would have to pair rows to recover the
  state;
* the **lot** — wrong grain. One lot issued to three Kanbans needs three
  independent checks; clearing one room would clear all three.

So the ledger records that the units left, and this table records whether their
expiration is still somebody's problem — which is what §4.3 asks for: "once
issued to a location, the quantity is considered consumed, but the expiration
date must continue to be tracked."

Nothing is swept or scheduled: the flag is derived on read from the lot's
expiry, today, and the configured lead time
(:mod:`app.consumables.repository`) — the same reasoning
``app/inventory/archive_job.py`` records for its own sweep.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

#: Transaction Spec §4.2's clearing conditions. The first is "the product was
#: consumed before its expiration date"; the other three are the dispositions
#: it names for product that is still in the room — "reworked, retested, or
#: discarded". Kept as a closed set so the register can be counted by outcome.
DISPOSITIONS: tuple[str, ...] = ("consumed", "reworked", "retested", "discarded")


class ConsumableIssue(Base):
    """The expiration-flag state of one issued consumable quantity."""

    __tablename__ = "consumable_issues"
    __table_args__ = (
        CheckConstraint(
            "disposition IS NULL OR disposition IN ("
            + ", ".join(f"'{d}'" for d in DISPOSITIONS)
            + ")",
            name="ck_consumable_issues_disposition",
        ),
        # Cleared is all-or-nothing: a cleared row names who, when and why.
        # There is no half-acknowledged state to reason about.
        CheckConstraint(
            "(cleared_at IS NULL) = (cleared_by_user_id IS NULL) "
            "AND (cleared_at IS NULL) = (disposition IS NULL)",
            name="ck_consumable_issues_cleared_complete",
        ),
        # The alert query's working set: rows still awaiting a physical check.
        # The date itself is on the lot, reached through the movement, so this
        # narrows the register and ``ix_lots_expiration_date`` does the rest.
        Index(
            "ix_consumable_issues_open",
            "cleared_at",
            postgresql_where=text("cleared_at IS NULL"),
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    #: The ledger row this flag belongs to, and the source of every fact about
    #: the issue. UNIQUE: the issue endpoint writes exactly one register row per
    #: ``consumable_issue`` movement, and the constraint keeps a retry or a
    #: future code path from quietly creating a second flag for one issue.
    movement_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.stock_movements.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )

    cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cleared_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    disposition: Mapped[str | None] = mapped_column(Text, nullable=True)
    clear_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: ``StockMovement`` already eager-loads its own ``item``, ``lot`` and
    #: ``performed_by``, so this one relationship carries the whole register row:
    #: item · lot (and its live expiry) · qty_abs · to_location_node_id ·
    #: performed_at · performed_by.
    movement = relationship("StockMovement", lazy="joined")
    cleared_by = relationship("User", lazy="joined", foreign_keys=[cleared_by_user_id])
