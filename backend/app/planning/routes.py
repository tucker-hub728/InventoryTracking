"""``/v1/planning`` — reorder signals (PLN-001).

    "Each item shall carry a reorder threshold and a supplier lead time; the
    planning module shall warn when on-hand reaches the threshold so long-lead
    items can be reordered in time."
    — CellReady SRS Consolidated Amendment 9+10, v2 rev. 2026-08-18

Read-only, and deliberately so. This module warns; it does not raise orders.
Ordering already has a home (``/v1/receiving``) with its own e-signature, and a
screen that both alerts and acts would need a second one here for no gain.

Not to be confused with ``/v1/forecasts``. The sidebar has labelled the
forecast screen "Planning" since it shipped and continues to — that screen
projects demand, this one reports a threshold breach that has already happened.
The client kept them separate on 2026-08-24.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from app.api.deps import DBSession
from app.inventory import repository as inv_repo
from app.inventory.repository import NextOpenOrder
from app.inventory.schemas import ItemSupplierRead
from app.planning import repository as plan_repo
from app.security.permissions import RequirePermission

from .schemas import ReorderListResponse, ReorderRow

planning_router = APIRouter(prefix="/planning", tags=["planning"])


@planning_router.get(
    "/reorder",
    response_model=ReorderListResponse,
    summary="Items at or below their reorder threshold (PLN-001)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_reorder(
    db: DBSession,
    group: Annotated[
        Literal["order", "on_order", "awaiting"],
        Query(
            description="Which stage to page: 'order' has nothing coming, "
            "'on_order' already has an open purchase order, 'awaiting' has "
            "arrived and needs receiving to inventory."
        ),
    ] = "order",
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReorderListResponse:
    """One page of one group — "order this" by default, longest-lead item first.

    Paged in SQL for the same reason the expiry feed is: the catalogue only
    grows, and a badly-tuned set of thresholds can put a large fraction of it
    on this list at once.

    ``limit`` and ``offset`` apply to the requested group ALONE. Serving both
    groups from one offset (the first shape of this endpoint) meant page 2 of
    the tab you were reading also turned the tab you were not, and the shorter
    group rendered blank as soon as its rows ran out.

    ``items_without_threshold`` rides along on every page because a short list
    here is ambiguous — it means either "nothing needs ordering" or "nothing
    has a threshold set yet", and those call for opposite responses.
    """
    rows = await plan_repo.list_reorder_rows(db, limit=limit, offset=offset, group=group)
    # All three totals every time: the tab strip labels the tabs you are not on.
    totals = {
        g: await plan_repo.count_reorder_rows(db, group=g)
        for g in ("order", "on_order", "awaiting")
    }
    unplanned = await plan_repo.count_items_without_threshold(db)
    # One bulk lookup for the page, so the purchase order on a row and the
    # arrival date beside it always describe the same order.
    next_orders = await inv_repo.next_open_orders(db, [item.id for item, *_ in rows])

    items = [_to_row(*r, next_orders.get(r[0].id)) for r in rows]
    return ReorderListResponse(
        items=items,
        total=totals[group],
        limit=limit,
        offset=offset,
        group=group,
        order_total=totals["order"],
        on_order_total=totals["on_order"],
        awaiting_total=totals["awaiting"],
        items_without_threshold=unplanned,
        # Counted over the to-order group only. A row in either other group has
        # no supplier decision to make today, so a missing lead time there is
        # not the data gap this number is warning about.
        rows_without_lead_time=(
            sum(1 for r in items if r.lead_time_days is None) if group == "order" else 0
        ),
    )


def _to_row(
    item,
    lead: int | None,
    awaiting_units: int,
    on_order_units: int,
    next_order: NextOpenOrder | None,
) -> ReorderRow:
    """Serialise one at-or-below item. Shared by all three groups so a row means
    the same thing wherever it is shown."""
    return ReorderRow(
        item_id=str(item.id),
        item_number=item.item_number,
        description=item.description,
        uom=item.uom or "",
        qty_available=item.stock.qty_available if item.stock else 0,
        reorder_threshold=item.reorder_threshold,
        shortfall=plan_repo.shortfall(item),
        # The view already classified it; re-deriving here would be a second
        # definition of "out of stock" to keep in step. Note this stays a
        # statement about what is on the shelf — an item with a warehouse full
        # of unreleased stock is still genuinely out of stock to a picker, and
        # the group it lands in is what says "release, don't order".
        status_code=(
            "out_of_stock"
            if item.stock and item.stock.status_code == "out_of_stock"
            else "low_stock"
        ),
        suppliers=[
            ItemSupplierRead(
                supplier_id=str(link.supplier_id),
                supplier_name=link.supplier.name if link.supplier else "",
            )
            for link in item.suppliers
        ],
        lead_time_days=lead,
        lead_time_supplier_name=plan_repo.longest_lead_supplier_name(item, lead),
        qty_awaiting_release=Decimal(awaiting_units),
        qty_on_order=Decimal(on_order_units),
        expected_arrival=next_order.expected_arrival if next_order else None,
        next_order_id=str(next_order.order_id) if next_order else None,
        next_po_reference=next_order.po_reference if next_order else None,
        open_order_count=next_order.open_order_count if next_order else 0,
    )
