"""``/v1/shipments`` — ship a finished good out to a customer.

The terminal transaction of the finished-goods lifecycle (REQ-2026-07-22-CUST-001
/ 07-01 TRX-005/006). A shipment may draw from SEVERAL sources (lot × location)
when the finished good is spread across locations — mirroring the kitting
multi-source Issue. Each source is consumed and posts a ``customer_shipment``
ledger row that leaves the system (``to`` NULL). The customer is **required**
(every shipment names a customer). Only the shipped item's stock changes; there
is no cascade to component inventory (TRX-006).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.kitting import repository as kit_repo
from app.locations import repository as loc_repo
from app.products import repository as products_repo
from app.security.permissions import RequirePermission

from . import repository as shipments_repo
from .schemas import (
    CustomerShipmentEvent,
    CustomerShipmentLine,
    CustomerShipmentsResponse,
    CustomerShippedItemRow,
    CustomerShippedItemsResponse,
    CustomerShippedTotals,
    ShipCell,
    ShipmentLine,
    ShipmentRead,
    ShipOutRequest,
    ShipSourceRead,
)

shipments_router = APIRouter(prefix="/shipments", tags=["shipments"])

# The reauth action verb minted by the frontend before a shipment. No registry —
# it is validated only by shape + matched here (see app/auth/reauth.py).
SHIP_ACTION = "movement.customer_shipment"


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


async def _require_shippable_item(db: DBSession, item_id: uuid.UUID):
    """Any tracked tier may be issued to a customer (REQ-2026-07-31-TRX-001).

    **This deliberately reverses the earlier rule.** Until now only a built item
    could go to a customer — a finished good, or a sub-assembly sold directly
    per INV-004 — and a raw material was refused outright. TRX-001 puts the
    Issue control on all three tiers with "customer" among its destinations, and
    the client confirmed on 2026-08-18 that a raw material may indeed be sent to
    one (a customer supplying their own starting material gets it back the same
    way it arrived). Flagged for the beta cover page, since it overturns a rule
    an earlier requirement set.

    Consumables remain out. They are not a tier — they are a flag on a raw
    material — and their terminal transaction is already defined elsewhere:
    issued to a Kanban and consumed on arrival, never quantity-adjusted again
    (Transaction Spec §4.3, REQ-2026-07-09-TRX-004). There is no per-lot balance
    left to ship.
    """
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found", code="item_not_found")
    if item.is_consumable:
        raise ValidationError(
            "A consumable is consumed when it is issued, so it cannot be sent "
            "to a customer. Issue it to a Kanban instead.",
            code="item_not_shippable",
        )
    return item


@shipments_router.get(
    "/sources/{item_id}",
    response_model=list[ShipSourceRead],
    summary="A finished good's shippable stock (lot × storage location)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def ship_sources(
    db: DBSession, item_id: Annotated[uuid.UUID, Path()]
) -> list[ShipSourceRead]:
    """Lot-level available stock for the ship dialog's source picker. WIP on a
    production floor is excluded (:func:`item_stock_by_node_lot`), so only real
    finished-goods inventory can be shipped."""
    await _require_shippable_item(db, item_id)
    rows = (await kit_repo.item_stock_by_node_lot(db, {item_id})).get(item_id, [])
    node_labels = await loc_repo.node_label_map(db) if rows else {}

    # LN2 boxes: pull the occupied cells + grid geometry so the dialog can draw
    # the box and the operator taps the exact vials (same as kitting Issue).
    cells_by_node = (await kit_repo.item_cells_by_node(db, {item_id})).get(item_id, {})
    grid_meta = {
        n.id: (int(n.grid_rows), int(n.grid_cols))
        for n in (await kit_repo.grid_nodes(db, set(cells_by_node))).values()
        if n.grid_rows and n.grid_cols
    }

    def _label(node_id: uuid.UUID) -> str:
        name, path = node_labels.get(node_id, ("", ""))
        return path or name

    def _cells(node_id: uuid.UUID, lot_id: uuid.UUID, exp) -> list[ShipCell]:
        return [
            ShipCell(
                allocation_id=str(a.id),
                grid_row=int(a.grid_row),
                grid_col=int(a.grid_col),
                lot_id=str(a.lot_id),
                lot_number=getattr(getattr(a, "lot", None), "lot_number", None),
                expiration_date=exp,
            )
            for a in cells_by_node.get(node_id, [])
            if a.lot_id == lot_id
        ]

    # One query for the lots on show rather than widening the shared source
    # tuple, which also feeds kitting's Issue picker.
    release_states = await inv_repo.lot_release_states(db, {r[0] for r in rows})

    out: list[ShipSourceRead] = []
    for (lot_id, lot_number, exp, node_id, qty) in rows:
        dims = grid_meta.get(node_id)
        out.append(
            ShipSourceRead(
                lot_id=str(lot_id),
                lot_number=lot_number,
                release_state=release_states.get(lot_id),
                expiration_date=exp,
                node_id=str(node_id),
                location=_label(node_id),
                qty=qty,
                is_grid=dims is not None,
                grid_rows=dims[0] if dims else None,
                grid_cols=dims[1] if dims else None,
                cells=_cells(node_id, lot_id, exp) if dims else [],
            )
        )
    return out


async def _consume_source(
    db: DBSession,
    *,
    item_id: uuid.UUID,
    lot_uuid: uuid.UUID,
    node_uuid: uuid.UUID,
    qty: int,
    cell_allocation_ids: list[str] | None,
    line_no: int,
) -> None:
    """Draw ``qty`` of one lot at one node for a shipment.

    The drain is shared with the transfer and material-issue paths
    (:func:`loc_repo.draw_lot_at_node`); only the over-draw error code names a
    shipment."""
    await loc_repo.draw_lot_at_node(
        db,
        item_id=item_id,
        lot_id=lot_uuid,
        node_id=node_uuid,
        qty=qty,
        cell_allocation_ids=cell_allocation_ids,
        line_no=line_no,
        exceeds_code="ship_exceeds_available",
    )


@shipments_router.post(
    "",
    response_model=ShipmentRead,
    status_code=status.HTTP_201_CREATED,
    summary="Ship a finished good out to a customer (terminal, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def ship_out(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ShipOutRequest,
) -> ShipmentRead:
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")

    # Customer is REQUIRED — every shipment names a customer.
    customer_uuid = _parse_uuid(payload.customer_id, field="customer_id")
    customer = await products_repo.get_customer(db, customer_uuid)
    if customer is None:
        raise NotFoundError(
            f"Customer {payload.customer_id} not found", code="customer_not_found"
        )

    # Resolve + validate every source up front: all must be the SAME built item.
    item_id: uuid.UUID | None = None
    item = None
    plans: list[tuple[int, uuid.UUID, uuid.UUID, str | None, int, list[str] | None]] = []
    for i, src in enumerate(payload.sources, start=1):
        lot_uuid = _parse_uuid(src.lot_id, field="lot_id")
        node_uuid = _parse_uuid(src.node_id, field="node_id")
        lot = await inv_repo.get_lot(db, lot_uuid)
        if lot is None:
            raise NotFoundError(f"Lot {src.lot_id} not found", code="lot_not_found")
        if item_id is None:
            item_id = lot.item_id
            item = await _require_shippable_item(db, item_id)
        elif lot.item_id != item_id:
            raise ValidationError(
                "All sources must be for the same finished good", code="mixed_items"
            )
        plans.append(
            (i, lot_uuid, node_uuid, lot.lot_number, src.qty, src.cell_allocation_ids)
        )

    assert item_id is not None and item is not None  # sources has min_length 1

    reference = (payload.reference_number or "").strip() or None
    lines: list[ShipmentLine] = []
    first_movement = None
    for line_no, lot_uuid, node_uuid, lot_number, qty, cells in plans:
        await _consume_source(
            db,
            item_id=item_id,
            lot_uuid=lot_uuid,
            node_uuid=node_uuid,
            qty=qty,
            cell_allocation_ids=cells,
            line_no=line_no,
        )
        movement = await loc_repo.create_node_shipment_movement(
            db,
            item_id=item_id,
            lot_id=lot_uuid,
            from_location_node_id=node_uuid,
            qty=qty,
            performed_by_user_id=current.id,
            customer_id=customer_uuid,
            reference_number=reference,
            reauth_evidence_id=evidence_uuid,
            notes=payload.notes,
        )
        if first_movement is None:
            first_movement = movement
        lines.append(ShipmentLine(lot_id=str(lot_uuid), lot_number=lot_number, qty=qty))

    assert first_movement is not None
    # Consumed LAST so a replayed signature rolls the whole shipment back. One
    # signature authorises the whole shipment; it targets its first ledger row.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=SHIP_ACTION,
        target_table="app.stock_movements",
        target_id=first_movement.id,
        # The item being shipped; movements are per-source results of this one decision.
        record_table="app.items",
        record_id=item_id,
    )

    response = ShipmentRead(
        item_id=str(item_id),
        item_number=item.item_number,
        total_qty=sum(ln.qty for ln in lines),
        customer_id=str(customer_uuid),
        customer_name=customer.name,
        reference_number=reference,
        performed_at=first_movement.performed_at,
        lines=lines,
    )
    await db.commit()
    return response


# ── Per-customer shipment history (read-only — CUST-003) ───────────────
#
# Declared AFTER the writes above but with LITERAL first segments
# ("summary", "by-customer") that cannot collide with "/sources/{item_id}" or
# with POST "" — so no ordering trap here, unlike ``/allocations/search`` vs
# ``/allocations/by-lot/{id}``.
#
# These hang off the shipments router rather than the customers one because what
# they read is the SHIPMENT ledger; the customer is only the filter. Permission
# is ``inventory:view``, the same gate the ledger and the disposition log use —
# finance and other read-only roles can see where finished goods went without
# being able to send any.


@shipments_router.get(
    "/summary/by-customer",
    response_model=list[CustomerShippedTotals],
    summary="Lifetime shipped totals for every customer",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def shipped_summary_by_customer(db: DBSession) -> list[CustomerShippedTotals]:
    """One row per customer that has EVER been shipped to, so the customers list
    can show the relationship at a glance without a request per row.

    Customers with no shipments are absent rather than zeroed — see
    :func:`shipments_repo.shipped_totals_by_customer` for why that distinction is
    worth keeping.
    """
    totals = await shipments_repo.shipped_totals_by_customer(db)
    return [
        CustomerShippedTotals(
            customer_id=str(customer_id),
            shipment_count=count,
            total_qty=qty,
            last_shipped_at=last_at,
        )
        for customer_id, (count, qty, last_at) in totals.items()
    ]


@shipments_router.get(
    "/by-customer/{customer_id}/items",
    response_model=CustomerShippedItemsResponse,
    summary="What a customer has been sent, rolled up by item",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def shipped_items_for_customer(
    db: DBSession, customer_id: Annotated[uuid.UUID, Path()]
) -> CustomerShippedItemsResponse:
    """"How much of what have we sent them?" — the customer page's first answer.

    A HISTORY, never a holding: these are units that left the system, not stock
    the customer is holding for CellReady. Unpaged, biggest total first.
    """
    customer = await products_repo.get_customer(db, customer_id)
    if customer is None:
        raise NotFoundError(f"Customer {customer_id} not found", code="customer_not_found")

    rows = await shipments_repo.shipped_by_item_for_customer(db, customer_id=customer_id)
    shipment_count, total_qty, _items, _last = await shipments_repo.shipped_totals_for_customer(
        db, customer_id=customer_id
    )
    return CustomerShippedItemsResponse(
        items=[
            CustomerShippedItemRow(
                item_id=str(item_id),
                # Empty, not a 500, when the item is gone from under its ledger
                # rows — the units still left, so the row and the total stay.
                item_number=item.item_number if item else "",
                item_description=getattr(item, "description", None),
                total_qty=qty,
                shipment_count=count,
                last_shipped_at=last_at,
            )
            for item, item_id, qty, count, last_at in rows
        ],
        total_qty=total_qty,
        shipment_count=shipment_count,
    )


@shipments_router.get(
    "/by-customer/{customer_id}",
    response_model=CustomerShipmentsResponse,
    summary="A customer's shipment history, newest first",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def shipments_for_customer(
    db: DBSession,
    customer_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CustomerShipmentsResponse:
    """Every shipment this customer has received, one row per signed SHIPMENT —
    not one per ledger row.

    A multi-source ship writes a movement per source lot; they are folded back
    into the single operator action they were, with the lots in ``lines``. That
    is the grain the ship dialog posts in and the grain ``ShipmentRead`` already
    returns, so the history reads the same way the action did.

    Read-only (CUST-003). There is no counterpart write route: a wrong shipment is
    corrected by a new ledger row, never by editing this one.
    """
    customer = await products_repo.get_customer(db, customer_id)
    if customer is None:
        raise NotFoundError(f"Customer {customer_id} not found", code="customer_not_found")

    total = await shipments_repo.shipment_event_count(db, customer_id=customer_id)
    _count, total_qty, _items, _last = await shipments_repo.shipped_totals_for_customer(
        db, customer_id=customer_id
    )
    events = await shipments_repo.list_shipment_events_for_customer(
        db, customer_id=customer_id, limit=limit, offset=offset
    )

    items: list[CustomerShipmentEvent] = []
    for shipped_at, movements in events:
        first = movements[0]
        items.append(
            CustomerShipmentEvent(
                shipped_at=shipped_at,
                item_id=str(first.item_id),
                item_number=first.item.item_number if first.item else "",
                item_description=getattr(first.item, "description", None),
                # The magnitude. The stored delta is negative (unit-OUT) and
                # "-50 units shipped" reads as a correction, not a quantity.
                total_qty=sum(int(m.qty_abs) for m in movements),
                # Carried on every row of the event, so the first one speaks for
                # all of them.
                reference_number=first.reference_number,
                shipped_by=getattr(first.performed_by, "full_name", None),
                notes=first.notes,
                lines=[
                    CustomerShipmentLine(
                        movement_id=str(m.id),
                        lot_id=str(m.lot_id) if m.lot_id else None,
                        lot_number=m.lot.lot_number if m.lot else None,
                        qty=int(m.qty_abs),
                        source_path=m.from_location_path,
                        source_node_id=(
                            str(m.from_location_node_id) if m.from_location_node_id else None
                        ),
                    )
                    for m in movements
                ],
            )
        )

    return CustomerShipmentsResponse(
        items=items,
        total=total,
        total_qty=total_qty,
        limit=limit,
        offset=offset,
    )
