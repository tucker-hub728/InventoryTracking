"""Wire shapes for ``/v1/planning``."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.inventory.schemas import ItemSupplierRead


class ReorderRow(BaseModel):
    """One item that has reached its reorder threshold (PLN-001).

    Quantities are in the item's **consume** unit (Each), matching
    ``app.v_item_stock``. The client confirmed this reading on 2026-08-24: the
    threshold is compared against units on the shelf, not against the pack an
    order happens to be placed in. An item bought by the Box therefore shows a
    threshold like "50" meaning fifty units, and the buyer converts to boxes at
    the point of ordering, where the pack size is already recorded on the order
    line (REQ-001).
    """

    model_config = ConfigDict(from_attributes=True)

    item_id: str
    item_number: str
    description: str
    uom: str

    qty_available: Decimal
    reorder_threshold: Decimal
    #: ``reorder_threshold - qty_available``, floored at zero. How many units
    #: short of the threshold the item is right now — the "how bad is it"
    #: number. Zero means it has landed exactly on the threshold, which still
    #: warns: PLN-001 says warn when on-hand *reaches* the threshold.
    shortfall: Decimal
    status_code: Literal["low_stock", "out_of_stock"]

    suppliers: list[ItemSupplierRead]
    #: Longest lead time among the item's assigned suppliers (client decision,
    #: 2026-08-24). Worst case on purpose: an item stocked at 7 days by one
    #: supplier and 45 by another must be reordered as if it were the 45, or
    #: the warning arrives too late whenever the fast supplier is out.
    #:
    #: ``None`` when the item has no suppliers, or when none of them has a lead
    #: time recorded. Not defaulted to zero — see the model comment on
    #: ``Supplier.lead_time_days``.
    lead_time_days: int | None = None
    #: Which supplier ``lead_time_days`` came from, so the number is
    #: explainable on the row rather than an unattributed figure.
    lead_time_supplier_name: str | None = None

    #: Units already on site but not yet shelved (REQ-004). Present on rows in
    #: EVERY group: when it covers the shortfall the row belongs under "to
    #: receive", and when it only covers part of it the row still needs an
    #: order, but for the difference rather than the whole gap.
    qty_awaiting_release: Decimal = Decimal("0")
    #: Units on open purchase orders, in CONSUME units. Same reasoning: it
    #: decides the group when it covers the shortfall, and informs the order
    #: quantity when it only covers part.
    qty_on_order: Decimal = Decimal("0")


class ReorderListResponse(BaseModel):
    """One page of ONE group of reorder signals.

    An item below its threshold poses one of three different questions, which
    are the three stages of getting material onto a shelf:

    * **to order** — nothing is coming; raise a purchase order.
    * **on order** — a purchase order is already open; wait, or chase it.
    * **to receive** — it has arrived and is in quarantine; receive it to
      inventory.

    Merging them invites the one mistake this screen must not cause: raising a
    second purchase order for material already bought. That is not theoretical —
    when the groups were merged, every row the client saw under "order this"
    already had an open order covering it (reported 2026-08-24).

    Nothing is hidden by the split. An item stays on the screen until stock
    physically lands, per the client's rule that a late order must not go quiet;
    all the grouping changes is the heading it sits under.

    Each group is a separate page, because any of them can be long and one
    shared offset made turning page 2 of one silently turn the others.

    All three totals ride on every response so the tab strip can label the tabs
    you are *not* looking at without extra round trips — the same reason the
    supplier list carries ``active_total`` / ``inactive_total``.
    """

    #: Rows for the requested ``group`` only.
    items: list[ReorderRow]
    #: Unpaged size of the requested group — what the paginator divides.
    total: int
    limit: int
    offset: int
    #: Which group these rows are. Echoed back so a slow response landing after
    #: a tab switch can be discarded rather than rendered under the wrong tab.
    group: Literal["order", "on_order", "awaiting"] = "order"
    #: Unpaged size of each group, for the tab labels.
    order_total: int = 0
    on_order_total: int = 0
    awaiting_total: int = 0
    #: Live items whose ``reorder_threshold`` is still zero. They are *absent*
    #: from ``items`` by design (see :func:`repository.list_reorder_rows`), and
    #: this count is how the page says so out loud instead of quietly showing a
    #: short list. Unfiltered by paging.
    items_without_threshold: int
    #: Rows on this page whose lead time is unknown. A data gap, not a fast
    #: supplier — surfaced so "no lead time" cannot be mistaken for "no wait".
    rows_without_lead_time: int
