"""``/v1/issues`` — issue material to a scrap location (debit-and-gone).

REQ-2026-08-04-TRX-001/002. The material leaves controlled inventory: each source
is drawn down and posts a ``material_issue`` ledger row naming the destination
location, and **nothing is created at that destination** — no allocation, no
register row, no balance.

The line this module holds, and the reason it is not part of the transfer route:

    Transfer → QC 1 › Freezer 1     still inventory, at a new node
    Issue    → QC 1                 gone from inventory

An issue therefore takes the LOCATION, and a transfer takes a storage node
underneath it. The two accept disjoint node types, so "issued AND stored in the
QC freezer" — the state the client explicitly rules out — cannot be expressed by
any request rather than merely being rejected by a check.
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
from app.models.locations import SCRAP_NODE_TYPE, is_scrap_location
from app.security.permissions import RequirePermission

from . import repository as issues_repo
from .schemas import (
    IssueCell,
    IssueDestinationRead,
    IssuedListResponse,
    IssuedRow,
    IssuedSummaryRow,
    IssueLine,
    IssueRead,
    IssueRequest,
    IssueSourceRead,
)

issues_router = APIRouter(prefix="/issues", tags=["issues"])

# The reauth action verb minted by the frontend before an issue. No registry —
# validated by shape and matched here (see app/auth/reauth.py), same as
# ``movement.customer_shipment`` and ``movement.consumable_issue``.
ISSUE_ACTION = "movement.material_issue"


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


async def _require_scrap_destination(db: DBSession, node_id: str):
    """The destination must be a LOCATION the client marked debit-and-gone.

    Two separate refusals, because they are two different operator mistakes and
    each deserves its own fix:

      * a shelf / freezer / box — they picked a place *inside* a location, which
        is what a TRANSFER takes. Sending material there would store it, which is
        the opposite of what this transaction records.
      * an ordinary location — nothing at that site is meant to leave inventory,
        so this is almost certainly the wrong destination rather than a missing
        setting.
    """
    node_uuid = _parse_uuid(node_id, field="destination_node_id")
    node = await loc_repo.get_node(db, node_uuid)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found", code="node_not_found")
    if not node.is_active:
        raise ValidationError("That location is inactive", code="node_inactive")
    if node.node_type != SCRAP_NODE_TYPE:
        raise ValidationError(
            f"'{node.name}' is not a location — an issue goes to the location itself "
            f"(for example QC 1), not to a shelf, refrigerator or freezer inside it. "
            f"To move material into one of those and keep tracking it, use Transfer.",
            code="issue_target_not_location",
        )
    if not is_scrap_location(node):
        raise ValidationError(
            f"'{node.name}' is not set up as a debit-and-gone location, so material "
            f"cannot be issued to it. Transfer stock there instead, or create the "
            f"location with that option ticked.",
            code="issue_target_not_scrap",
        )
    return node


@issues_router.get(
    "/destinations",
    response_model=list[IssueDestinationRead],
    summary="Locations material may be issued to (debit-and-gone)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_destinations(db: DBSession) -> list[IssueDestinationRead]:
    """The Issue destination picker.

    Empty when the client has not created a scrap location yet — the UI reads
    that as "no debit-and-gone location is set up" and points at Storage, rather
    than showing an empty select with no explanation.
    """
    rows = await loc_repo.list_scrap_locations(db)
    labels = await loc_repo.node_label_map(db) if rows else {}
    return [
        IssueDestinationRead(
            node_id=str(n.id),
            name=n.name,
            code=n.code,
            path=labels.get(n.id, (n.name, n.name))[1] or n.name,
        )
        for n in rows
    ]


@issues_router.get(
    "/summary",
    response_model=list[IssuedSummaryRow],
    summary="What each debit-and-gone location has consumed",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def issued_summary(db: DBSession) -> list[IssuedSummaryRow]:
    """Totals per destination, for the Storage overview cards.

    Declared ABOVE ``/at/{node_id}``: FastAPI matches in declaration order, and
    a literal segment registered after a parameterised one at the same depth is
    unreachable — "summary" would be read as a node id and 422 on the UUID.
    """
    totals = await issues_repo.issued_totals_by_node(db)
    return [
        IssuedSummaryRow(
            node_id=str(node_id),
            issue_count=count,
            total_qty=qty,
            last_issued_at=last_at,
        )
        for node_id, (count, qty, last_at) in totals.items()
    ]


@issues_router.get(
    "/at/{node_id}",
    response_model=IssuedListResponse,
    summary="The disposition log — what has been issued to a location",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_issued_at(
    db: DBSession,
    node_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> IssuedListResponse:
    """What was issued to this location, newest first.

    A HISTORY, never a holding. Nothing here is stock — every row records
    material that left inventory at the moment it was written, which is why the
    response carries no allocations and no balance. The location's own shelves
    and freezers are the separate, still-tracked story, and they are read through
    ``/location-nodes/{id}/allocations`` as they are anywhere else.

    Deliberately NOT restricted to scrap locations, even though only they can be
    issued to today: an ordinary location that was scrap-marked in some other
    environment, or one whose rows pre-date a change, should still be able to
    show its history rather than 404. An unmarked location simply has none.
    """
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found", code="node_not_found")

    total, total_qty = await issues_repo.issued_totals_at_node(db, node_id=node_id)
    rows = await issues_repo.list_issued_at_node(db, node_id=node_id, limit=limit, offset=offset)
    return IssuedListResponse(
        items=[
            IssuedRow(
                movement_id=str(m.id),
                item_id=str(m.item_id),
                item_number=m.item.item_number if m.item else "",
                item_description=getattr(m.item, "description", None),
                lot_id=str(m.lot_id) if m.lot_id else None,
                lot_number=m.lot.lot_number if m.lot else None,
                # The magnitude. The stored delta is negative (unit-OUT) and
                # "−12 units issued" reads as a correction, not a quantity.
                qty=int(m.qty_abs),
                # The path snapshot taken when the row was written, not a live
                # lookup: it must keep saying where the material came from even
                # after that shelf is renamed or removed.
                source_path=m.from_location_path,
                source_node_id=(
                    str(m.from_location_node_id) if m.from_location_node_id else None
                ),
                issued_at=m.performed_at,
                issued_by=getattr(m.performed_by, "full_name", None),
                notes=m.notes,
            )
            for m in rows
        ],
        total=total,
        total_qty=total_qty,
        limit=limit,
        offset=offset,
    )


@issues_router.get(
    "/sources/{item_id}",
    response_model=list[IssueSourceRead],
    summary="An item's issuable stock (lot × storage location)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def issue_sources(
    db: DBSession, item_id: Annotated[uuid.UUID, Path()]
) -> list[IssueSourceRead]:
    """Lot-level available stock for the issue dialog's source picker.

    Any item may be issued — TRX-002's "controlled items sent to it" describes
    what the client sends, not a validation rule, and PD/R&D receive raw material
    and finished goods alike. WIP on a production floor is excluded upstream by
    :func:`item_stock_by_node_lot`, so a half-built kit cannot be issued out from
    under the operator running it.
    """
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found", code="item_not_found")

    rows = (await kit_repo.item_stock_by_node_lot(db, {item_id})).get(item_id, [])
    node_labels = await loc_repo.node_label_map(db) if rows else {}

    # LN2 boxes: pull the occupied cells + grid geometry so the dialog can draw
    # the box and the operator taps the exact vials (same as kitting Issue and
    # the ship dialog). A consumable CAN sit in a box (client 2026-08-11), so
    # this is not an LN2-only concern.
    cells_by_node = (await kit_repo.item_cells_by_node(db, {item_id})).get(item_id, {})
    grid_meta = {
        n.id: (int(n.grid_rows), int(n.grid_cols))
        for n in (await kit_repo.grid_nodes(db, set(cells_by_node))).values()
        if n.grid_rows and n.grid_cols
    }

    def _label(node_id: uuid.UUID) -> str:
        name, path = node_labels.get(node_id, ("", ""))
        return path or name

    def _cells(node_id: uuid.UUID, lot_id: uuid.UUID, exp) -> list[IssueCell]:
        return [
            IssueCell(
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

    out: list[IssueSourceRead] = []
    for (lot_id, lot_number, exp, node_id, qty) in rows:
        dims = grid_meta.get(node_id)
        out.append(
            IssueSourceRead(
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


@issues_router.post(
    "",
    response_model=IssueRead,
    status_code=status.HTTP_201_CREATED,
    summary="Issue material to a scrap location (terminal, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def issue_material(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: IssueRequest,
) -> IssueRead:
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    destination = await _require_scrap_destination(db, payload.destination_node_id)

    # Resolve + validate every source up front: all must be the SAME item, so the
    # one signature covers one item's issue and the ledger rows agree.
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
            item = await inv_repo.get_item(db, item_id)
            if item is None:
                raise NotFoundError(f"Item {item_id} not found", code="item_not_found")
        elif lot.item_id != item_id:
            raise ValidationError("All sources must be for the same item", code="mixed_items")
        plans.append((i, lot_uuid, node_uuid, lot.lot_number, src.qty, src.cell_allocation_ids))

    assert item_id is not None and item is not None  # sources has min_length 1

    lines: list[IssueLine] = []
    first_movement = None
    for line_no, lot_uuid, node_uuid, lot_number, qty, cells in plans:
        await loc_repo.draw_lot_at_node(
            db,
            item_id=item_id,
            lot_id=lot_uuid,
            node_id=node_uuid,
            qty=qty,
            cell_allocation_ids=cells,
            line_no=line_no,
            exceeds_code="issue_exceeds_available",
        )
        # No destination allocation, deliberately — that absence IS the
        # transaction. Creating one here would put the material back into
        # inventory at the very place it was just recorded as leaving from.
        movement = await loc_repo.create_node_issue_movement(
            db,
            item_id=item_id,
            lot_id=lot_uuid,
            from_location_node_id=node_uuid,
            to_location_node_id=destination.id,
            qty=qty,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            notes=payload.notes,
        )
        if first_movement is None:
            first_movement = movement
        lines.append(IssueLine(lot_id=str(lot_uuid), lot_number=lot_number, qty=qty))

    assert first_movement is not None
    # Consumed LAST so a replayed signature rolls the whole issue back. One
    # signature authorises the whole issue; it targets its first ledger row.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=ISSUE_ACTION,
        target_table="app.stock_movements",
        target_id=first_movement.id,
        # The item being issued; movements are per-source results of one decision.
        record_table="app.items",
        record_id=item_id,
    )

    _, dest_path = await loc_repo.node_paths(
        db, from_node_id=destination.id, to_node_id=destination.id
    )
    response = IssueRead(
        item_id=str(item_id),
        item_number=item.item_number,
        total_qty=sum(ln.qty for ln in lines),
        destination_node_id=str(destination.id),
        destination_name=destination.name,
        destination_path=dest_path or destination.name,
        performed_at=first_movement.performed_at,
        lines=lines,
    )
    await db.commit()
    return response
