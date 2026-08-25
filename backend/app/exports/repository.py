"""Bulk reads for the finance export (RPT-001).

Five statements for the whole file, all bulk — there is no per-item query in
here. An export is the one endpoint where an N+1 turns a page load into a
timeout, so every helper takes the full ``item_ids`` set.

Nothing here paginates. The 200-row ceiling on ``GET /v1/items`` is a
constraint on *that* route's signature, not a property of the data; a full
dump declares no limit at all. The backstop is ``MAX_EXPORT_ROWS``, enforced
in the route.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Row, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.inventory import repository as inv_repo
from app.kitting.repository import PRODUCTION_CATEGORY
from app.models.inventory import (
    Item,
    Lot,
    ReceiptTransaction,
    ReceiptTransactionLine,
    Supplier,
)
from app.models.locations import LocationNode, LotAllocation


async def filtered_items(
    session: AsyncSession,
    *,
    tier_id: uuid.UUID | None = None,
    prefix_id: uuid.UUID | None = None,
    supplier_id: uuid.UUID | None = None,
    q: str | None = None,
    is_consumable: bool | None = None,
) -> list[Item]:
    """The items in scope, hydrated (prefix → tier, and the stock view).

    Reuses ``_apply_filters`` — the *same* function ``GET /v1/items`` filters
    with — rather than restating the predicates. A finance export that
    disagreed with the screen it was launched from about which items are in
    the Raw Materials tier would be worse than no export, and the only durable
    way to guarantee they agree is to run one implementation.

    ``.unique()`` is required: ``Item.prefix`` and ``Item.stock`` are
    ``lazy="joined"``, so the driver returns duplicated parent rows.
    """
    stmt = inv_repo._apply_filters(
        select(Item),
        q=q,
        supplier_id=supplier_id,
        status=None,
        tier_id=tier_id,
        prefix_id=prefix_id,
        is_consumable=is_consumable,
    ).order_by(Item.sku_suffix)
    return list((await session.execute(stmt)).unique().scalars().all())


async def allocation_rows_by_item(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Row[Any]]]:
    """``{item_id: [row, …]}`` — active stock at (lot × location) grain.

    **The three highlighted predicates mirror ``kit_repo.item_stock_by_node_lot``
    exactly** (``is_active``, ``qty > 0``, production excluded). That is not
    incidental: it is what makes this export incapable of disagreeing with the
    item drill-down's "Stock by location" tab. Note it likewise does NOT filter
    ``Lot.deleted_at`` — matching the picker matters more than the extra
    predicate, and the two must stay in step.

    The ``GROUP BY`` is load-bearing for file size, not just tidiness. An LN2
    box holds one allocation row *per cell* (``uq_lot_allocations_cell``), so
    300 vials of one lot is 300 rows on disk. Collapsing them to one row of
    ``qty=300`` is what "one row per (lot × location)" means.
    """
    if not item_ids:
        return {}

    # Every non-aggregated column, listed once and reused as the GROUP BY.
    # Explicit rather than leaning on Postgres' functional-dependency rule:
    # that only applies to a grouped table's own primary key, and this select
    # reaches through five joins.
    grouped = [
        Lot.item_id.label("item_id"),
        Lot.id.label("lot_id"),
        Lot.lot_number.label("lot_number"),
        Lot.status.label("lot_status"),
        Lot.release_state.label("release_state"),
        Lot.manufacture_date.label("manufacture_date"),
        Lot.expiration_date.label("expiration_date"),
        Lot.parent_lot_id.label("parent_lot_id"),
        Lot.unit_price_amount.label("unit_price_amount"),
        Lot.po_reference.label("po_reference"),
        Lot.receipt_transaction_id.label("receipt_transaction_id"),
        Lot.supplier_id.label("supplier_id"),
        Supplier.name.label("supplier_name"),
        LotAllocation.location_node_id.label("location_node_id"),
        LocationNode.code.label("location_code"),
        LocationNode.node_type.label("location_node_type"),
        LocationNode.is_active.label("location_is_active"),
    ]
    stmt = (
        select(*grouped, func.coalesce(func.sum(LotAllocation.qty), 0).label("qty"))
        .select_from(LotAllocation)
        .join(Lot, Lot.id == LotAllocation.lot_id)
        .join(LocationNode, LocationNode.id == LotAllocation.location_node_id)
        .outerjoin(Supplier, Supplier.id == Lot.supplier_id)
        .where(
            Lot.item_id.in_(item_ids),
            LotAllocation.is_active.is_(True),
            LotAllocation.qty > 0,
            func.coalesce(LocationNode.flat_category, "") != PRODUCTION_CATEGORY,
        )
        .group_by(*grouped)
        # FIFO within an item, same ordering the pickers use, so a reader
        # comparing the two sees the rows in the same sequence.
        .order_by(
            Lot.expiration_date.asc().nullslast(),
            Lot.lot_number.asc(),
            LocationNode.code.asc(),
        )
    )
    out: dict[uuid.UUID, list[Row[Any]]] = {}
    for row in (await session.execute(stmt)).all():
        out.setdefault(row.item_id, []).append(row)
    return out


async def open_order_rows_by_item(
    session: AsyncSession, item_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Row[Any]]]:
    """``{item_id: [row, …]}`` — open order lines with quantity outstanding.

    Kept because the client's own rule says so: "Open POs shall be preserved
    and excluded from archiving so finance exports continue to show outstanding
    commitments regardless of age" (SRS update 2026-07-15).

    Built on the shared ``outstanding_order_units_expr`` so these per-line rows
    sum to the ``po_value`` on the item's ``item_valuation`` row **by
    construction** rather than by both sides happening to agree.
    """
    if not item_ids:
        return {}

    received_sub, outstanding = inv_repo.outstanding_order_units_expr()
    stmt = (
        select(
            ReceiptTransactionLine.item_id.label("item_id"),
            ReceiptTransactionLine.supplier_id.label("supplier_id"),
            Supplier.name.label("supplier_name"),
            ReceiptTransaction.id.label("order_id"),
            ReceiptTransaction.po_reference.label("po_reference"),
            ReceiptTransaction.status.label("order_status"),
            ReceiptTransaction.is_blanket.label("is_blanket"),
            ReceiptTransaction.archived_at.label("archived_at"),
            ReceiptTransactionLine.line_no.label("line_no"),
            ReceiptTransactionLine.pack_uom.label("pack_uom"),
            ReceiptTransactionLine.units_per_pack.label("units_per_pack"),
            ReceiptTransactionLine.unit_price_amount.label("unit_price_amount"),
            outstanding.label("outstanding_packs"),
        )
        .select_from(ReceiptTransactionLine)
        .join(
            ReceiptTransaction,
            ReceiptTransaction.id == ReceiptTransactionLine.receipt_transaction_id,
        )
        .outerjoin(Supplier, Supplier.id == ReceiptTransactionLine.supplier_id)
        .outerjoin(received_sub, received_sub.c.line_id == ReceiptTransactionLine.id)
        .where(
            ReceiptTransactionLine.item_id.in_(item_ids),
            ReceiptTransaction.deleted_at.is_(None),
            ReceiptTransaction.status != "cancelled",
            outstanding > 0,
        )
        .order_by(ReceiptTransaction.po_reference.asc(), ReceiptTransactionLine.line_no)
    )
    out: dict[uuid.UUID, list[Row[Any]]] = {}
    for row in (await session.execute(stmt)).all():
        out.setdefault(row.item_id, []).append(row)
    return out


async def count_active_allocations(session: AsyncSession) -> int:
    """Rough upper bound on detail rows, for the size guard before we build.

    Counts allocation rows rather than the grouped result — cheap, and an
    over-estimate is the safe direction for a backstop.
    """
    stmt = select(func.count()).select_from(LotAllocation).where(
        LotAllocation.is_active.is_(True), LotAllocation.qty > 0
    )
    return int((await session.execute(stmt)).scalar_one())


# Re-exported so the route reads as one module's worth of vocabulary even
# though these two live in the inventory repository.
lots_awaiting_put_away = inv_repo.lots_awaiting_put_away
compute_item_valuations = inv_repo.compute_item_valuations

__all__ = [
    "allocation_rows_by_item",
    "compute_item_valuations",
    "count_active_allocations",
    "filtered_items",
    "lots_awaiting_put_away",
    "open_order_rows_by_item",
]
