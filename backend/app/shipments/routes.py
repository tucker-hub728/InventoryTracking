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

from fastapi import APIRouter, Depends, Path, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.kitting import repository as kit_repo
from app.locations import repository as loc_repo
from app.models.inventory import BUILT_TIER_TYPES
from app.products import repository as products_repo
from app.security.permissions import RequirePermission

from .schemas import (
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
    """The item must be built (a finished good, or a sub-assembly sold directly
    per INV-004) — raw materials and consumables never ship to a customer."""
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found", code="item_not_found")
    if item.tier is None or item.tier.type not in BUILT_TIER_TYPES:
        raise ValidationError(
            "Only a finished good or sub-assembly can be shipped to a customer",
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

    out: list[ShipSourceRead] = []
    for (lot_id, lot_number, exp, node_id, qty) in rows:
        dims = grid_meta.get(node_id)
        out.append(
            ShipSourceRead(
                lot_id=str(lot_id),
                lot_number=lot_number,
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
    """Draw ``qty`` of one lot at one node — exact vials for an LN2 box, else
    FIFO across the lot's allocations there. Reducing an allocation to zero
    deactivates it (incl. box cells)."""
    allocs = [
        a
        for a in await kit_repo.allocations_for_item_at_node(
            db, item_id, node_uuid, for_update=True
        )
        if a.lot_id == lot_uuid
    ]
    available = sum(int(a.qty) for a in allocs)
    if available == 0:
        raise NotFoundError(
            f"Source {line_no}: that lot is no longer stored at that location",
            code="no_stock_at_location",
        )

    if cell_allocation_ids:
        wanted = [_parse_uuid(c, field="cell_allocation_ids") for c in cell_allocation_ids]
        if qty != len(set(wanted)):
            raise ValidationError(
                f"Source {line_no}: {len(set(wanted))} vials selected but qty is {qty} — "
                f"for a box the quantity is the number of vials.",
                code="cell_count_mismatch",
            )
        chosen = await kit_repo.allocations_by_ids(db, wanted)
        found = {a.id for a in chosen}
        if [str(w) for w in wanted if w not in found] or any(
            a.lot_id != lot_uuid or a.location_node_id != node_uuid for a in chosen
        ):
            raise ValidationError(
                f"Source {line_no}: one or more selected vials are no longer available.",
                code="invalid_cell",
            )
        for alloc in chosen:
            await loc_repo.reduce_allocation(db, allocation=alloc, qty=int(alloc.qty))
        return

    if qty > available:
        raise ValidationError(
            f"Source {line_no}: requested {qty} exceeds the {available} available for this "
            f"lot here",
            code="ship_exceeds_available",
        )
    remaining = qty
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        remaining -= take


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
