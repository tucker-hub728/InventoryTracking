"""kan01: Kanban restock requests (KAN-001)

    "Kanban locations shall hold area consumables in production/lab areas; on a
    restock request, the operator acknowledges consumption (marks the depleted
    quantity consumed) and reissues replenishment, keeping inventory accurate
    without per-unit tracking inside the Kanban."
    — CellReady SRS Consolidated Amendment 9+10, 2026-08-13

One table, and nothing else. That is the whole schema cost of KAN-001, and the
reason it is so small is worth writing down, because the obvious reading of that
requirement is considerably more expensive.

## What this does NOT do, deliberately

**A Kanban still holds no balance.** It is not in ``STORAGE_NODE_TYPES``, it
takes no ``lot_allocations``, and an issue to one remains a single unit-out row
that debits the stock immediately (07-09 ``TRX-001``, "kitting is terminal only
for consumables"). No movement types are added and ``app.v_item_stock`` is
untouched.

The alternative was built first and reversed the same day (client, 2026-08-27).
Reading "shall hold area consumables" as a live count means the issue becomes a
net-zero pair — a unit-out plus a matching unit-in at the bin — so that the
allocation view and the ledger view of on-hand keep agreeing. On the item's Unit
Ledger that renders as **"50 out, then 50 in"** for what the operator
experienced as one action, which is a confusing way to describe handing gloves
to a clean room. It also forces ``qty_on_hand`` and ``qty_available`` apart in
the stock view, because ``REQ-2026-08-18-PLN-002`` requires the reorder trigger
to fire at ISSUE and a net-zero issue moves nothing.

None of that is needed. "Without per-unit tracking inside the Kanban" is
satisfied — trivially — by not tracking anything inside the Kanban.

## What the loop actually is

    request restock  →  acknowledge what was used  →  issue the replenishment

Only the third step touches stock, and it is the ordinary e-signed issue that
already existed. The first two are records, which is exactly why they need a
table: neither is derivable from the ledger.

* "Clean Room 2 is low on gloves" is an **intent**. No stock moves when it is
  formed, so no movement records it.
* "we got through 40" is a **statement about material already debited**. The
  units left at issue, so the acknowledgment writes no movement either, and
  ``consumed_qty`` is the only place that number exists.

That second column is the one exception in this module to reading quantities
back off the ledger rather than copying them. It earns the exception by there
being nothing to read.

## Index notes

``uq_kanban_restock_open`` is PARTIAL. One open ask per (bin, item) — a second
"we're low on gloves" for the same station is the same request, not a queue of
two — while closed rows accumulate freely as history. A non-partial unique
index would block a bin that is restocked every week after its first request.

Revision ID: kan01
Revises: notif01
Create Date: 2026-08-27 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "kan01"
down_revision: str | None = "notif01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Mirrors ``REQUEST_STATES`` in ``app/models/consumables.py``. Duplicated
#: rather than imported: a migration has to keep describing the schema it built
#: even after the model moves on.
_REQUEST_STATES = ("open", "fulfilled", "cancelled")


def upgrade() -> None:
    op.create_table(
        "kanban_restock_requests",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("kanban_node_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Nullable on purpose: "we are low on gloves" is a legitimate request.
        # An operator who has not counted should not have to invent a number,
        # and the number that matters is captured at acknowledgment anyway.
        sa.Column("requested_qty", sa.Integer(), nullable=True),
        # What the operator confirmed was used. Set when the request is
        # fulfilled; null while open or cancelled.
        sa.Column("consumed_qty", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False, server_default=sa.text("'open'")),
        sa.Column("requested_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_kanban_restock_requests"),
        sa.ForeignKeyConstraint(
            ["kanban_node_id"],
            ["meta.location_nodes.id"],
            name="fk_kanban_restock_requests_node",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["app.items.id"],
            name="fk_kanban_restock_requests_item",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"],
            ["app.users.id"],
            name="fk_kanban_restock_requests_requested_by",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["closed_by_user_id"],
            ["app.users.id"],
            name="fk_kanban_restock_requests_closed_by",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "state IN (" + ", ".join(f"'{s}'" for s in _REQUEST_STATES) + ")",
            name="ck_kanban_restock_requests_state",
        ),
        # The two bounds differ on purpose. Zero is a real ANSWER — "we used
        # none of it, the line never ran" — and not a real REQUEST.
        sa.CheckConstraint(
            "(requested_qty IS NULL OR requested_qty > 0) "
            "AND (consumed_qty IS NULL OR consumed_qty >= 0)",
            name="ck_kanban_restock_requests_qty_positive",
        ),
        # Open means not closed, on every row. Without this, "open" could be
        # read two ways (state, or a null closed_at) and they could disagree.
        sa.CheckConstraint(
            "(state = 'open') = (closed_at IS NULL)",
            name="ck_kanban_restock_requests_closed_pairing",
        ),
        schema="app",
    )
    op.create_index(
        "uq_kanban_restock_open",
        "kanban_restock_requests",
        ["kanban_node_id", "item_id"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("state = 'open'"),
    )
    # The floor panel's hot query: the open requests for one Kanban.
    op.create_index(
        "ix_kanban_restock_open_by_node",
        "kanban_restock_requests",
        ["kanban_node_id"],
        schema="app",
        postgresql_where=sa.text("state = 'open'"),
    )


def downgrade() -> None:
    op.drop_index("ix_kanban_restock_open_by_node", "kanban_restock_requests", schema="app")
    op.drop_index("uq_kanban_restock_open", "kanban_restock_requests", schema="app")
    op.drop_table("kanban_restock_requests", schema="app")
