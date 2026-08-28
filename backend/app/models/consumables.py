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

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, text
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


#: Lifecycle of a restock request. ``fulfilled`` is set by the acknowledgment
#: that closes it; ``cancelled`` is the operator withdrawing the ask (the bin
#: was restocked by hand, the line stopped running, the item was swapped).
REQUEST_STATES: tuple[str, ...] = ("open", "fulfilled", "cancelled")


class KanbanRestockRequest(Base):
    """An open ask for more of one consumable in one Kanban (KAN-001).

    Neither end of this row is derivable from the ledger, and that is the whole
    reason it exists:

    * "Clean Room 2 is low on gloves" is an *intent*. No stock moves when it is
      formed, so no movement records it;
    * "we got through 40 of them" is a *statement about material already
      debited*. The units left inventory at issue (07-09 TRX-001), so the
      acknowledgment writes no movement either — ``consumed_qty`` below is the
      only place that number exists.

    The one thing that IS an ordinary ledger write is the replenishment that
    follows: a normal e-signed issue, which this row does not model.

    Deliberately NOT a balance. A Kanban holds no ``lot_allocations`` — asking
    for more, and saying how much went, neither of them changes a stock figure.
    """

    __tablename__ = "kanban_restock_requests"
    __table_args__ = (
        CheckConstraint(
            "state IN (" + ", ".join(f"'{s}'" for s in REQUEST_STATES) + ")",
            name="ck_kanban_restock_requests_state",
        ),
        CheckConstraint(
            "(requested_qty IS NULL OR requested_qty > 0) "
            # Zero is legal here and not for a request: "we used none of it"
            # is a real answer at restock time (the line never ran), whereas
            # asking for zero more is not a request.
            "AND (consumed_qty IS NULL OR consumed_qty >= 0)",
            name="ck_kanban_restock_requests_qty_positive",
        ),
        # Open means not closed, on every row. Without this, "open" could be
        # read two ways (state, or a null closed_at) and they could disagree.
        CheckConstraint(
            "(state = 'open') = (closed_at IS NULL)",
            name="ck_kanban_restock_requests_closed_pairing",
        ),
        # A second "we're low on gloves" for the same bin is the SAME request,
        # not a queue of two. Partial, so closed rows accumulate freely as
        # history.
        Index(
            "uq_kanban_restock_open",
            "kanban_node_id",
            "item_id",
            unique=True,
            postgresql_where=text("state = 'open'"),
        ),
        Index(
            "ix_kanban_restock_open_by_node",
            "kanban_node_id",
            postgresql_where=text("state = 'open'"),
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    kanban_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("meta.location_nodes.id", ondelete="RESTRICT"),
        nullable=False,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    #: Optional: "we are low on gloves" is a legitimate request. The number that
    #: matters — what was actually consumed — is captured at acknowledgment, on
    #: the ledger row, not guessed here.
    requested_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'open'"))

    requested_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    #: What the operator confirmed was used, set when the request is fulfilled.
    #: Nullable: an open or cancelled request has no figure.
    #:
    #: **Stored, not derived** — the one place in this module that copies rather
    #: than reads through. Everywhere else a quantity lives on a ledger row and
    #: is read back from it; this acknowledgment writes no ledger row, because
    #: the stock was already debited at issue. There is nothing to derive from,
    #: so the column IS the record.
    consumed_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)

    kanban = relationship("LocationNode", lazy="joined")
    item = relationship("Item", lazy="joined")
    requested_by = relationship("User", lazy="joined", foreign_keys=[requested_by_user_id])
    closed_by = relationship("User", lazy="joined", foreign_keys=[closed_by_user_id])
