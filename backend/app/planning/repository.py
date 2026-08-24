"""Queries behind the reorder screen (PLN-001).

Read-only. Planning observes inventory; it never moves it.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import ScalarSelect, Select, and_, asc, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.inventory.repository import (
    awaiting_release_units_subquery,
    on_order_units_subquery,
)
from app.models.inventory import Item, ItemStock, ItemSupplier, Supplier

#: The three answers an at-or-below item can have. Ordered by how close the
#: material is to being usable, which is also the precedence used to classify:
#: nothing has been done → it is bought but not here → it is here but not
#: shelved.
ReorderGroup = Literal["order", "on_order", "awaiting"]


def _lead_time_subquery() -> ScalarSelect[int | None]:
    """Longest recorded lead time among an item's assigned suppliers.

    Correlated rather than joined-and-grouped because the outer query selects
    whole ``Item`` entities with eager relationships; a ``GROUP BY`` would have
    to name every eagerly-joined column and would break the moment a
    relationship is added to the model.

    ``max`` ignores NULLs, so an item with a 30-day supplier and one whose lead
    time was never recorded yields 30 — the best answer available — while an
    item where *no* supplier has a lead time yields NULL. That distinction is
    what ``rows_without_lead_time`` reports on.
    """
    return (
        select(func.max(Supplier.lead_time_days))
        .select_from(ItemSupplier)
        .join(Supplier, Supplier.id == ItemSupplier.supplier_id)
        .where(ItemSupplier.item_id == Item.id)
        .correlate(Item)
        .scalar_subquery()
    )


def _at_or_below(stmt: Select[Any]) -> Select[Any]:
    """Restrict to live items that have reached their reorder threshold.

    Two conditions, and the second is the one worth explaining:

    * ``qty_available <= reorder_threshold`` — PLN-001 verbatim, "warn when
      on-hand reaches the threshold". Reached counts, hence ``<=``. This is the
      same test ``app.v_item_stock`` uses for ``status_code = 'low_stock'``,
      deliberately reused so the screen and the badge can never disagree.

      Quantity on order is **not** subtracted (client decision, 2026-08-24). An
      item stays on this list until stock physically arrives, so a placed order
      that is late keeps warning instead of going quiet.

    * ``reorder_threshold > 0`` — an item whose threshold is still the default
      zero has not had one set. Without this, every item that has never moved
      would qualify (``0 <= 0``) and the screen would open on a list of
      unconfigured rows, burying the handful that genuinely need ordering.
      Those items are counted by :func:`count_items_without_threshold` and
      reported alongside the page rather than silently dropped.
    """
    return stmt.where(
        Item.deleted_at.is_(None),
        Item.reorder_threshold > 0,
        ItemStock.qty_available <= Item.reorder_threshold,
    )


def _covered_by_arrivals():
    """True when material already on site would clear the shortfall.

    Splits the reorder list in two, and the split is the whole point: an item
    whose gap is covered by stock sitting in quarantine does not need an order,
    it needs somebody to put it away. Telling a planner to buy more of what is
    already in the building is the most expensive mistake this screen can make.

    This is not a reversal of "on-order is not subtracted" (client,
    2026-08-24). That rule turns on *arrival* — an ordered-but-late delivery
    keeps warning precisely because it might not come. This material HAS come.
    The client's own test puts it on the other side of the line.

    ``>=`` because covering the shortfall exactly is enough: releasing it lands
    the item back on its threshold, which is where it is meant to sit.

    The ``> 0`` guard is load-bearing, not belt-and-braces. An item sitting
    *exactly* on its threshold has a shortfall of zero, and ``0 >= 0`` is true —
    so without it, every item that had merely touched its threshold with nothing
    in the receiving bay would be filed under "arrived, needs release" and
    rendered as "0 units to receive to inventory". The group would fill with items that have
    nothing to release, and the genuine order-this signal PLN-001 exists to give
    would be the one that went missing.
    """
    shortfall = Item.reorder_threshold - ItemStock.qty_available
    arrived = awaiting_release_units_subquery()
    return and_(arrived > 0, arrived >= shortfall)


def _covered_by_open_orders():
    """True when an open purchase order already covers the shortfall.

    The middle rung. Same ``> 0`` guard and the same ``>=`` as
    :func:`_covered_by_arrivals`, for the same reasons — an item exactly on its
    threshold has a zero shortfall, and ``0 >= 0`` would sweep every such item
    into this group with nothing actually on order.

    Deliberately does NOT subtract the quantity from the shortfall (client rule,
    2026-08-24): an order can be late or never arrive, so the item stays on the
    screen until stock physically lands. All this decides is which of the three
    headings it sits under — "raise an order" or "one is already placed".
    """
    shortfall = Item.reorder_threshold - ItemStock.qty_available
    ordered = on_order_units_subquery()
    return and_(ordered > 0, ordered >= shortfall)


def _group_filter(group: ReorderGroup):
    """The predicate selecting exactly one of the three groups.

    Precedence — arrived beats on-order beats neither — so the groups are
    disjoint and every at-or-below item lands in exactly one. An item can be
    both part-delivered and still on order; it belongs under the heading whose
    action is closest to done, because receiving what is already on site is
    faster and cheaper than chasing what is not.
    """
    arrived = _covered_by_arrivals()
    ordered = _covered_by_open_orders()
    if group == "awaiting":
        return arrived
    if group == "on_order":
        return and_(~arrived, ordered)
    return and_(~arrived, ~ordered)


async def count_reorder_rows(
    session: AsyncSession, *, group: ReorderGroup = "order"
) -> int:
    """Rows in one group. The three are disjoint and together cover every
    at-or-below item, so three calls account for the whole screen."""
    stmt = _at_or_below(
        select(func.count()).select_from(Item).join(ItemStock, ItemStock.item_id == Item.id)
    )
    return int((await session.execute(stmt.where(_group_filter(group)))).scalar_one())


async def count_items_without_threshold(session: AsyncSession) -> int:
    """Live items still on a zero reorder threshold — i.e. not yet planned."""
    stmt = (
        select(func.count())
        .select_from(Item)
        .where(
            Item.deleted_at.is_(None),
            Item.reorder_threshold <= 0,
        )
    )
    return int((await session.execute(stmt)).scalar_one())


async def list_reorder_rows(
    session: AsyncSession,
    *,
    limit: int = 50,
    offset: int = 0,
    group: ReorderGroup = "order",
) -> list[tuple[Item, int | None, int, int]]:
    """Return ``(item, longest_supplier_lead_days, units_awaiting_release,
    units_on_order)`` for one group, most urgent first.

    Every group is paged, because any of them can be long — a bulk delivery day
    fills the third, and a big purchasing round fills the second.

    Both quantities ride along on ALL groups, not only the group they define.
    An item can be short by more than has arrived or been ordered: it still
    needs a purchase, and the buyer needs to see what is already covered so the
    order is raised for the difference rather than the whole gap.

    Ordering, in priority order, and each rung is there for a reason:

    1. **Out of stock before merely low.** Nothing on the shelf outranks a
       buffer being thin, whatever the lead times say.
    2. **Longest lead time first.** This is PLN-001's own stated purpose — "so
       long-lead items can be reordered in time". A 90-day item that has just
       touched its threshold is more urgent than a 2-day item that has been
       under it for a week, because only one of them can still be fixed
       quickly. Unknown lead times sort last: they are a data gap, and putting
       them first would push real signals off the first page.
    3. **Biggest shortfall.** Tie-break within a lead-time band.
    4. **Item number.** Stable paging — without a total order, two rows equal
       on every rung above could swap between pages.
    """
    lead = _lead_time_subquery()
    arrived = awaiting_release_units_subquery()
    ordered = on_order_units_subquery()
    stmt = _at_or_below(
        select(
            Item,
            lead.label("lead_time_days"),
            arrived.label("awaiting_release"),
            ordered.label("on_order"),
        ).join(ItemStock, ItemStock.item_id == Item.id)
    ).where(_group_filter(group))

    if group == "order":
        stmt = stmt.order_by(
            # ``qty_available <= 0`` is exactly the view's out_of_stock test.
            desc(ItemStock.qty_available <= 0),
            desc(lead).nullslast(),
            desc(Item.reorder_threshold - ItemStock.qty_available),
            asc(Item.sku_suffix),
        )
    else:
        # A different question deserves a different order. Nothing in these two
        # groups needs buying, so lead time is irrelevant; what matters is
        # clearing the backlog, and the item nobody can pick at all comes first.
        stmt = stmt.order_by(
            desc(ItemStock.qty_available <= 0),
            desc(Item.reorder_threshold - ItemStock.qty_available),
            asc(Item.sku_suffix),
        )
    stmt = stmt.limit(limit).offset(offset)
    rows = (await session.execute(stmt)).unique().all()
    return [(r[0], r[1], int(r[2] or 0), int(r[3] or 0)) for r in rows]


def shortfall(item: Item) -> Decimal:
    """Units below the threshold, floored at zero.

    Floored because an item sitting exactly *on* its threshold is a warning
    with a shortfall of nothing, and a negative number there would read as a
    surplus on a screen that only ever lists items in trouble.
    """
    available = item.stock.qty_available if item.stock else Decimal("0")
    gap = item.reorder_threshold - available
    return gap if gap > 0 else Decimal("0")


def longest_lead_supplier_name(item: Item, lead_time_days: int | None) -> str | None:
    """Name the supplier whose lead time became the item's.

    The number itself comes from SQL (it has to — the ordering depends on it);
    this resolves it back to a name from the already-loaded supplier list, so
    the row can say "45 days (Acme Bio)" rather than an unattributed 45. No
    extra query: ``Item.suppliers`` and its ``supplier`` are both eager.

    Ties go to the first assigned supplier, which is the order the item's
    supplier list is displayed in everywhere else.
    """
    if lead_time_days is None:
        return None
    for link in item.suppliers:
        supplier = link.supplier
        if supplier is not None and supplier.lead_time_days == lead_time_days:
            return str(supplier.name)
    return None
