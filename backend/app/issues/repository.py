"""Reads for the material-issue disposition log.

One query shape: "everything issued to this location". It is deliberately NOT
``loc_repo.list_node_ledger``, which matches ``from_node OR to_node`` across
every movement type — at a scrap location that would mix the disposition log
together with the transfers that moved stock INTO its shelves, and those two are
opposite facts about the same place. Here the filter is exact:

    movement_type = 'material_issue' AND to_location_node_id = <the location>

There is no register table behind this. Everything the log shows lives on the
append-only ledger row, and the ledger's own eager loads (``item``, ``lot``,
``performed_by`` are all ``lazy="joined"``) mean one statement fetches it all.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import StockMovement

ISSUE_MOVEMENT_TYPE = "material_issue"


def _at_node(node_id: uuid.UUID):
    return (
        StockMovement.movement_type == ISSUE_MOVEMENT_TYPE,
        StockMovement.to_location_node_id == node_id,
    )


async def list_issued_at_node(
    session: AsyncSession,
    *,
    node_id: uuid.UUID,
    limit: int = 50,
    offset: int = 0,
) -> list[StockMovement]:
    """One page of the disposition log, newest issue first.

    ``performed_at`` defaults to ``now()``, which in Postgres is the TRANSACTION
    timestamp — so the rows of one multi-source issue (one per source lot, all
    written in a single transaction) share it exactly, to the microsecond. They
    tie, and ``id`` breaks the tie.

    That tie-break is for STABILITY, not chronology: the ids are random UUIDs, so
    the rows within a single issue come back in an arbitrary but *fixed* order.
    Fixed is the property that matters — without a second key their order is
    undefined per query, and a row can appear on two pages or on none. Across
    separate issues the timestamps differ and the ordering is genuinely newest
    first. Same reasoning, same shape as ``loc_repo.list_node_ledger``.
    """
    stmt = (
        select(StockMovement)
        .where(*_at_node(node_id))
        .order_by(StockMovement.performed_at.desc(), StockMovement.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list((await session.execute(stmt)).scalars().unique().all())


async def issued_totals_by_node(
    session: AsyncSession,
) -> dict[uuid.UUID, tuple[int, int, object]]:
    """``{node_id: (row count, total units, last issued at)}`` for every
    location that has ever been issued to.

    One grouped query rather than a call per location: the Storage overview
    renders every debit-and-gone card at once, and asking per card turns a page
    with six labs into six round trips that all say almost nothing.

    Locations with no issues are simply absent — the caller renders "nothing
    issued yet" from the gap rather than from a row of zeroes.
    """
    stmt = (
        select(
            StockMovement.to_location_node_id,
            func.count(StockMovement.id),
            func.coalesce(func.sum(StockMovement.qty_abs), 0),
            func.max(StockMovement.performed_at),
        )
        .where(
            StockMovement.movement_type == ISSUE_MOVEMENT_TYPE,
            StockMovement.to_location_node_id.is_not(None),
        )
        .group_by(StockMovement.to_location_node_id)
    )
    out: dict[uuid.UUID, tuple[int, int, object]] = {}
    for node_id, count, qty, last_at in (await session.execute(stmt)).all():
        if node_id is not None:
            out[node_id] = (int(count), int(qty), last_at)
    return out


async def issued_totals_at_node(
    session: AsyncSession, *, node_id: uuid.UUID
) -> tuple[int, int]:
    """``(row count, total units)`` for the WHOLE log, not the current page.

    ``qty_abs`` rather than ``qty_delta``: an issue is unit-OUT, so the delta is
    negative, and "−120 units issued" reads as a correction rather than a
    quantity. One query for both, since they are always rendered together.
    """
    stmt = select(
        func.count(StockMovement.id),
        func.coalesce(func.sum(StockMovement.qty_abs), 0),
    ).where(*_at_node(node_id))
    row = (await session.execute(stmt)).one()
    return int(row[0]), int(row[1])
