"""Reads for the per-customer shipment history.

One filter shape underneath everything here::

    movement_type = 'customer_shipment' AND customer_id = <the customer>

That is deliberately narrower than ``loc_repo.list_node_ledger``: a customer has
no location, so there is no "from OR to" to match on — a shipment row is the only
kind of ledger row that names a customer at all, and the partial index
``ix_movements_customer_id`` (``ship01``) exists for exactly this lookup.

**A HISTORY, NEVER A HOLDING.** Every unit counted here LEFT the system — a
``customer_shipment`` has ``to_location_node_id`` NULL by the ``ship01`` CHECK.
Nothing in this module may be read as a balance the customer holds on CellReady's
behalf, which is why there is no "on hand" anywhere in it and why the panel says
so in words.

Two grains, because the page asks two different questions:

* **by item** — "how much of what have we ever sent them?" A rollup, unpaged: a
  customer takes a handful of finished goods, not thousands.
* **by shipment** — "what left, and when?" One row per shipment EVENT rather than
  per ledger row. A multi-source ship writes one movement per source lot inside a
  single transaction, so those rows share ``performed_at`` to the microsecond
  (Postgres ``now()`` is the TRANSACTION timestamp — the same property
  ``issues_repo.list_issued_at_node`` leans on). Grouping on it turns "50 units
  drawn from 3 lots" back into the one operator action it was, which is how the
  ship dialog posted it and how ``ShipmentRead`` already models it.

``qty_abs`` throughout, never ``qty_delta``: a shipment is unit-OUT so the delta
is negative, and "-120 units shipped" reads as a correction rather than a
quantity (the same call the disposition log makes).

Read-only by construction — CUST-003 wants this ledger read-only, and there is
nothing here but SELECTs.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import Item, StockMovement

#: The one movement type that names a customer.
SHIPMENT_MOVEMENT_TYPE = "customer_shipment"


def _for_customer(customer_id: uuid.UUID):
    return (
        StockMovement.movement_type == SHIPMENT_MOVEMENT_TYPE,
        StockMovement.customer_id == customer_id,
    )


async def shipped_totals_by_customer(
    session: AsyncSession,
) -> dict[uuid.UUID, tuple[int, int, datetime | None]]:
    """``{customer_id: (shipment count, total units, last shipped at)}`` for every
    customer that has ever been shipped to.

    One grouped query rather than a call per row: the customers list renders every
    customer at once, and asking per row turns a page of 40 customers into 40
    round trips that mostly answer "nothing yet".

    Customers with no shipments are simply ABSENT — the caller renders the dash
    from the gap rather than from a row of zeroes, so "never shipped to" and
    "shipped, then it all came back" stay distinguishable.
    """
    stmt = (
        select(
            StockMovement.customer_id,
            func.count(distinct(StockMovement.performed_at)),
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
            func.max(StockMovement.performed_at),
        )
        .where(
            StockMovement.movement_type == SHIPMENT_MOVEMENT_TYPE,
            StockMovement.customer_id.is_not(None),
        )
        .group_by(StockMovement.customer_id)
    )
    out: dict[uuid.UUID, tuple[int, int, datetime | None]] = {}
    for customer_id, shipments, qty, last_at in (await session.execute(stmt)).all():
        if customer_id is not None:
            out[customer_id] = (int(shipments), int(qty), last_at)
    return out


async def shipped_totals_for_customer(
    session: AsyncSession, *, customer_id: uuid.UUID
) -> tuple[int, int, int, datetime | None]:
    """``(shipment count, total units, distinct items, last shipped at)`` across
    the WHOLE history, not the current page.

    The shipment count is ``count(distinct performed_at)`` — the number of times
    somebody signed and shipped, which is what an operator means by "shipments".
    Counting ledger rows instead would inflate every multi-lot ship.
    """
    stmt = select(
        func.count(distinct(StockMovement.performed_at)),
        func.coalesce(func.sum(StockMovement.qty_abs), 0),
        func.count(distinct(StockMovement.item_id)),
        func.max(StockMovement.performed_at),
    ).where(*_for_customer(customer_id))
    row = (await session.execute(stmt)).one()
    return int(row[0]), int(row[1]), int(row[2]), row[3]


async def shipped_by_item_for_customer(
    session: AsyncSession, *, customer_id: uuid.UUID
) -> list[tuple[Item | None, uuid.UUID, int, int, datetime | None]]:
    """``(item, item_id, total units, shipment count, last shipped at)`` per item,
    biggest total first.

    Unpaged on purpose: this is the answer to "what do we send them?", and a
    customer takes a handful of finished goods. Ordering by quantity rather than
    by name puts the substance of the relationship in the first row.

    The ``Item`` is loaded as an ORM object rather than selected column by column
    because ``item_number`` is a DERIVED property (prefix code + suffix — there is
    no such column); its ``prefix`` is ``lazy="joined"``, so this costs no extra
    round-trip. It is None only for an item hard-deleted out from under its own
    ledger rows, which the append-only design permits. The caller renders that as
    an unnamed item rather than dropping the row, because those units still left
    the building and the total must keep saying so.
    """
    stmt = (
        select(
            StockMovement.item_id,
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
            func.count(distinct(StockMovement.performed_at)),
            func.max(StockMovement.performed_at),
        )
        .where(*_for_customer(customer_id))
        .group_by(StockMovement.item_id)
        .order_by(func.sum(StockMovement.qty_abs).desc())
    )
    rows = (await session.execute(stmt)).all()
    if not rows:
        return []

    items = (
        (await session.execute(select(Item).where(Item.id.in_([r[0] for r in rows]))))
        .scalars()
        .unique()
        .all()
    )
    by_id = {i.id: i for i in items}
    return [
        (by_id.get(item_id), item_id, int(qty), int(n), last_at)
        for item_id, qty, n, last_at in rows
    ]


async def shipment_event_count(session: AsyncSession, *, customer_id: uuid.UUID) -> int:
    """How many shipment EVENTS this customer has — the pager's ``total``.

    ``count(distinct performed_at)``, not ``count(*)``: the list below is grouped
    into events, so a row count would promise pages that do not exist.
    """
    stmt = select(func.count(distinct(StockMovement.performed_at))).where(
        *_for_customer(customer_id)
    )
    return int((await session.execute(stmt)).scalar_one())


async def list_shipment_events_for_customer(
    session: AsyncSession,
    *,
    customer_id: uuid.UUID,
    limit: int = 25,
    offset: int = 0,
) -> list[tuple[datetime, list[StockMovement]]]:
    """One page of shipment events, newest first, each with its ledger rows.

    Two statements rather than one, because the page is a page of EVENTS while the
    detail is per LOT:

    1. group to find which ``performed_at`` instants fall on this page;
    2. fetch every ledger row at those instants, and bucket them.

    Step 2 filters on ``performed_at IN (...)`` — bounded by ``limit``, so at most
    a page's worth of timestamps — and re-applies the customer filter, so a
    shipment to a DIFFERENT customer sharing that instant could never be folded
    in. (It cannot happen today: one ship call names one customer. The predicate
    costs nothing and removes the need to know that.)

    The ledger's own eager loads (``item``, ``lot``, ``performed_by`` are all
    ``lazy="joined"``) mean step 2 is a single statement including its joins.
    """
    instants = (
        (
            await session.execute(
                select(StockMovement.performed_at)
                .where(*_for_customer(customer_id))
                .group_by(StockMovement.performed_at)
                .order_by(StockMovement.performed_at.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    if not instants:
        return []

    rows = (
        (
            await session.execute(
                select(StockMovement)
                .where(
                    *_for_customer(customer_id),
                    StockMovement.performed_at.in_(instants),
                )
                # Stable within an event: the ids are random UUIDs, so this is an
                # arbitrary but FIXED order. Fixed is the property that matters —
                # without a second key the lot lines of one shipment could
                # reshuffle between requests. Same reasoning, same shape as
                # ``issues_repo.list_issued_at_node``.
                .order_by(StockMovement.performed_at.desc(), StockMovement.id.desc())
            )
        )
        .scalars()
        .unique()
        .all()
    )

    grouped: dict[datetime, list[StockMovement]] = {}
    for m in rows:
        grouped.setdefault(m.performed_at, []).append(m)
    # Driven by ``instants``, not by ``grouped``: dict order would otherwise
    # depend on the fetch, and the page must stay newest-first.
    return [(at, grouped[at]) for at in instants if at in grouped]
