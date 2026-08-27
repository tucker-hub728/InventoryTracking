"""``/v1/consumables`` — issue consumables to a Kanban and track their expiry.

The consumables leg of the inventory model (REQ-2026-07-01-TRX-003, LOC-006/008,
Transaction Spec 2026-07-01 §4, as amended 2026-07-09).

Three rules shape everything here, and they are the ones the documents argue
about, so they are stated once:

* **Issue is terminal for quantity.** 07-09 TRX-001 — "kitting is terminal only
  for consumables". The units leave inventory at issue; nothing later returns
  them. There is deliberately no de-issue endpoint.
* **Never back-flushed.** 07-09 TRX-004 — "consumables are never
  quantity-adjusted after issue".
* **Expiration outlives the quantity.** §4.3 — "once issued to a location, the
  quantity is considered consumed, but the expiration date must continue to be
  tracked". That is what ``app.consumable_issues`` is for.

**KAN-001's restock loop sits on top of those, without contradicting them**
(client 2026-08-27):

    request restock  →  acknowledge the request  →  issue the replenishment

Only the third step touches stock, and it is an ordinary e-signed issue. The
first two are RECORDS: an intent, and a statement about material already
expensed. That is what lets "on a restock request, the operator acknowledges
consumption (marks the depleted quantity consumed) and reissues replenishment"
be satisfied while an issue stays a single unit-out row.

``kan01`` briefly read it the other way — the Kanban held a live balance, the
issue became a net-zero pair, and the acknowledgment wrote the units off. The
client reversed it the same day: on the item's Unit Ledger a plain issue read as
"50 out, then 50 in", which is a confusing way to describe handing gloves to a
clean room. The rejected design is documented in the kan01 migration; the loop
above is what the requirement actually asked for.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.consumables import repository as cons_repo
from app.core.exceptions import NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.kitting import repository as kit_repo
from app.kitting.schemas import CellOption
from app.locations import repository as loc_repo
from app.models.consumables import ConsumableIssue
from app.models.locations import is_kanban_node
from app.security.permissions import RequirePermission

from .schemas import (
    AcknowledgeConsumptionRequest,
    AcknowledgeRequest,
    ConsumableIssueRead,
    ConsumableIssueRequest,
    ConsumableSourceRead,
    ExpiryPolicyRead,
    ExpiryPolicyUpdate,
    IssuedConsumableListResponse,
    IssuedConsumableRead,
    IssueResultLine,
    RequestState,
    RestockRequestCreate,
    RestockRequestListResponse,
    RestockRequestRead,
)

consumables_router = APIRouter(prefix="/consumables", tags=["consumables"])

#: The reauth action verb minted by the frontend before an issue. Matched here
#: by shape only, like every other action (see app/auth/reauth.py).
ISSUE_ACTION = "movement.consumable_issue"

#: The verb for closing out an expiry flag. Deliberately NOT the issue verb: a
#: signature minted to move stock into a Kanban must not be spendable on the
#: statement that the same stock was later discarded.
ACK_ACTION = "consumable.expiry_check"

#: The verb for acknowledging a depletion (KAN-001). A THIRD verb, for the same
#: reason there is a second: this signature authorises writing stock off the
#: books, and a ticket minted to move gloves into a bin — or to close an expiry
#: check on them — must not be spendable on the claim that they were used up.
CONSUMPTION_ACTION = "consumable.consumption"


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


async def _require_consumable_item(db: DBSession, item_id: uuid.UUID):
    """Only an item flagged ``is_consumable`` goes through this door.

    A non-consumable raw material bound for production is a KIT ISSUE — it is
    one-for-one and back-flushable (TRX-004 of 07-01), which is the opposite of
    everything this module does.
    """
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found", code="item_not_found")
    if not item.is_consumable:
        raise ValidationError(
            "Only a consumable can be issued to a Kanban — a non-consumable "
            "goes to production on a kit.",
            code="item_not_consumable",
        )
    return item


async def _require_kanban_node(db: DBSession, node_id: str):
    """The destination is always a Kanban, never the production area itself
    (client 2026-08-10). Two accounting homes in one room is the failure this
    prevents."""
    node_uuid = _parse_uuid(node_id, field="kanban_node_id")
    node = await loc_repo.get_node(db, node_uuid)
    if node is None:
        raise NotFoundError(f"Location node {node_id} not found", code="node_not_found")
    if not node.is_active:
        raise ValidationError("That Kanban is inactive", code="node_inactive")
    if not is_kanban_node(node.node_type):
        raise ValidationError(
            "A consumable is issued to a Kanban inside a production area, not "
            "to the area itself.",
            code="destination_not_kanban",
        )
    return node


# ── Reads ───────────────────────────────────────────────────────────────
#
# NOTE ordering: every literal path below is declared BEFORE ``/{issue_id}/…``.
# FastAPI matches in declaration order, so a later literal would be shadowed by
# the parameterised route and 422 on "expiring" not being a UUID. This module
# has no such bug; keep it that way when adding routes.


@consumables_router.get(
    "/sources/{item_id}",
    response_model=list[ConsumableSourceRead],
    summary="A consumable's issuable stock (lot × storage location)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def issue_sources(
    db: DBSession, item_id: Annotated[uuid.UUID, Path()]
) -> list[ConsumableSourceRead]:
    """Lot-level available stock for the issue dialog's source picker.

    Reuses the kitting stock query, which already excludes production floors —
    WIP on a floor is not issuable stock.

    Grid-bearing (LN2 box) sources carry their dimensions and this lot's occupied
    vials, exactly as the kitting Issue step does. The dialog used to flatten
    every source to a plain quantity on the assumption that a consumable lives on
    a shelf; CR-004 stored in Tank 1 (client 2026-08-11) is the counter-example,
    and a box source has to be picked by position or the emptied cells won't be
    the ones the operator physically pulled.
    """
    await _require_consumable_item(db, item_id)
    rows = (await kit_repo.item_stock_by_node_lot(db, {item_id})).get(item_id, [])
    node_labels = await loc_repo.node_label_map(db) if rows else {}
    grids = await kit_repo.grid_nodes(db, {node_id for *_, node_id, _ in rows})
    cells_by_node = (await kit_repo.item_cells_by_node(db, {item_id})).get(item_id, {})

    out: list[ConsumableSourceRead] = []
    for lot_id, lot_number, exp, node_id, qty in rows:
        name, path = node_labels.get(node_id, ("", ""))
        grid = grids.get(node_id)
        out.append(
            ConsumableSourceRead(
                lot_id=str(lot_id),
                lot_number=lot_number,
                expiration_date=exp,
                node_id=str(node_id),
                location=path or name,
                qty=qty,
                is_grid=grid is not None,
                grid_rows=int(grid.grid_rows) if grid and grid.grid_rows else None,
                grid_cols=int(grid.grid_cols) if grid and grid.grid_cols else None,
                # This lot's vials only — a box holding two lots offers each row
                # just its own positions.
                cells=[
                    CellOption(
                        allocation_id=str(a.id),
                        grid_row=int(a.grid_row),
                        grid_col=int(a.grid_col),
                        lot_id=str(a.lot_id),
                        lot_number=lot_number,
                        expiration_date=exp,  # type: ignore[arg-type]
                    )
                    for a in cells_by_node.get(node_id, [])
                    if a.lot_id == lot_id
                ]
                if grid is not None
                else [],
            )
        )
    return out


@consumables_router.get(
    "/expiry-policy",
    response_model=ExpiryPolicyRead,
    summary="The configured expiration warning lead time",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def read_expiry_policy(db: DBSession) -> ExpiryPolicyRead:
    return ExpiryPolicyRead(warn_days=await cons_repo.get_warn_days(db))


@consumables_router.put(
    "/expiry-policy",
    response_model=ExpiryPolicyRead,
    summary="Set the expiration warning lead time",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def update_expiry_policy(
    db: DBSession, current: CurrentDbUserDep, payload: ExpiryPolicyUpdate
) -> ExpiryPolicyRead:
    """The requirements never fix this number — LOC-008 alerts only once stock
    is past its date, §4.2 wants a warning as it approaches — so it is a policy
    the client owns rather than a constant we guessed."""
    if not (cons_repo.MIN_WARN_DAYS <= payload.warn_days <= cons_repo.MAX_WARN_DAYS):
        raise ValidationError(
            f"Warning lead time must be between {cons_repo.MIN_WARN_DAYS} and "
            f"{cons_repo.MAX_WARN_DAYS} days",
            code="warn_days_out_of_range",
        )
    before = await cons_repo.get_warn_days(db)
    await cons_repo.set_warn_days(db, days=payload.warn_days, user_id=current.id)
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.app_settings",
        subject_id=None,
        subject_label="consumable_expiry_warn_days",
        before={"warn_days": before},
        after={"warn_days": payload.warn_days},
    )
    await db.commit()
    return ExpiryPolicyRead(warn_days=payload.warn_days)


async def _to_reads(
    db: DBSession, rows: list[ConsumableIssue], *, warn_days: int
) -> list[IssuedConsumableRead]:
    """Flatten the register for the API.

    Every field except the flag state comes off ``r.movement`` — this table
    stores none of it, so there is exactly one copy of each fact.
    """
    node_labels = await loc_repo.node_label_map(db) if rows else {}
    out: list[IssuedConsumableRead] = []
    for r in rows:
        m = r.movement
        # Read live off the lot, never off a copy — a corrected expiry has to
        # correct the alert.
        expiry = cons_repo.expiry_of(r)
        flag, days = cons_repo.flag_for(expiry, warn_days=warn_days)
        node_id = m.to_location_node_id
        name, path = node_labels.get(node_id, ("", "")) if node_id else ("", "")
        out.append(
            IssuedConsumableRead(
                id=str(r.id),
                item_id=str(m.item_id),
                item_number=m.item.item_number if m.item else "",
                item_description=getattr(m.item, "description", None),
                lot_number=m.lot.lot_number if m.lot else None,
                qty=int(m.qty_abs),
                kanban_node_id=str(node_id) if node_id else "",
                kanban_name=name,
                kanban_path=path or name,
                issued_at=m.performed_at,
                issued_by=getattr(m.performed_by, "full_name", None),
                expiration_date=expiry,
                # A cleared row keeps its dates but stops flagging — the check
                # happened, so the alert is answered (TX Spec §4.2).
                flag=None if r.cleared_at else flag,
                days_to_expiry=days,
                cleared_at=r.cleared_at,
                cleared_by=getattr(r.cleared_by, "full_name", None),
                disposition=r.disposition,
                clear_note=r.clear_note,
            )
        )
    return out


@consumables_router.get(
    "/issued",
    response_model=list[IssuedConsumableRead],
    summary="The Kanban register — what has been issued and is still tracked",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_issued(
    db: DBSession,
    kanban_node_id: Annotated[uuid.UUID | None, Query()] = None,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    include_cleared: Annotated[bool, Query()] = False,
) -> list[IssuedConsumableRead]:
    warn_days = await cons_repo.get_warn_days(db)
    rows = await cons_repo.list_issues(
        db,
        kanban_node_id=kanban_node_id,
        item_id=item_id,
        include_cleared=include_cleared,
    )
    return await _to_reads(db, rows, warn_days=warn_days)


@consumables_router.get(
    "/expiring",
    response_model=IssuedConsumableListResponse,
    summary="Consumables in a Kanban that are expiring or expired (LOC-008)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_expiring(
    db: DBSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> IssuedConsumableListResponse:
    """The alert feed. Cross-Kanban on purpose: "what needs a physical check?"
    should not require visiting nine clean rooms one at a time.

    Paged in SQL rather than in the client: every issue ever made stays in the
    register, so this list only grows, and a room's worth of expired gloves
    should not arrive as one unbounded payload.

    Rows with no expiration date are absent by construction — the SQL compares
    against a horizon, and NULL never satisfies it (07-09: "expiration flags
    apply only where a date exists")."""
    warn_days = await cons_repo.get_warn_days(db)
    filters = {"include_cleared": False, "expiring_only": True, "warn_days": warn_days}
    total = await cons_repo.count_issues(db, **filters)
    rows = await cons_repo.list_issues(db, **filters, limit=limit, offset=offset)
    return IssuedConsumableListResponse(
        items=await _to_reads(db, rows, warn_days=warn_days),
        total=total,
        limit=limit,
        offset=offset,
    )


# ── Writes ──────────────────────────────────────────────────────────────


async def _draw_source(
    db: DBSession,
    *,
    item_id: uuid.UUID,
    lot_uuid: uuid.UUID,
    node_uuid: uuid.UUID,
    qty: int,
    line_no: int,
    cell_allocation_ids: list[str],
) -> None:
    """Take ``qty`` of one lot at one storage node, FIFO across its allocations.
    Reducing an allocation to zero deactivates it.

    An LN2 box source names its vials instead: ``cell_allocation_ids`` are
    emptied exactly, and the quantity is a consequence of that selection. Same
    rule (and the same failure modes) as a kit issue from a box — see
    ``_move_component`` in :mod:`app.kitting.routes`.
    """
    if cell_allocation_ids:
        if qty != len(cell_allocation_ids):
            raise ValidationError(
                f"Source {line_no}: {len(cell_allocation_ids)} vials selected but "
                f"{qty} issued — for a box the quantity is the number of vials.",
                code="cell_count_mismatch",
            )
        wanted = [_parse_uuid(c, field="cell_allocation_ids") for c in cell_allocation_ids]
        picked = await kit_repo.allocations_by_ids(db, wanted)
        if (
            len(picked) != len(set(wanted))
            or any(a.location_node_id != node_uuid for a in picked)
            or any(a.lot_id != lot_uuid for a in picked)
        ):
            raise ValidationError(
                f"Source {line_no}: one or more selected vials are no longer "
                f"available at that location.",
                code="invalid_cell",
            )
        for alloc in picked:
            await loc_repo.reduce_allocation(db, allocation=alloc, qty=int(alloc.qty))
        return

    allocs = [
        a
        for a in await kit_repo.allocations_for_item_at_node(
            db, item_id, node_uuid, for_update=True
        )
        if a.lot_id == lot_uuid
    ]
    # A box source must name its vials — draining it FIFO would empty positions
    # the operator never pulled, and the grid on screen would stop matching the
    # physical tank.
    if any(a.grid_row is not None for a in allocs):
        raise ValidationError(
            f"Source {line_no}: this lot is in a box — select the exact vials to issue.",
            code="cells_required",
        )
    available = sum(int(a.qty) for a in allocs)
    if available == 0:
        raise NotFoundError(
            f"Source {line_no}: that lot is no longer stored at that location",
            code="no_stock_at_location",
        )
    if qty > available:
        raise ValidationError(
            f"Source {line_no}: requested {qty} exceeds the {available} available "
            f"for this lot here",
            code="issue_exceeds_available",
        )
    remaining = qty
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        remaining -= take


@consumables_router.post(
    "/issue",
    response_model=ConsumableIssueRead,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a consumable to a Kanban (terminal, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def issue_to_kanban(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ConsumableIssueRequest,
) -> ConsumableIssueRead:
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    kanban = await _require_kanban_node(db, payload.kanban_node_id)

    # Resolve + validate every source up front: all must be the SAME consumable,
    # so one signature covers one item's issue.
    item_id: uuid.UUID | None = None
    item = None
    plans: list[tuple[int, uuid.UUID, uuid.UUID, str | None, int, object, list[str]]] = []
    for i, src in enumerate(payload.sources, start=1):
        lot_uuid = _parse_uuid(src.lot_id, field="lot_id")
        node_uuid = _parse_uuid(src.node_id, field="node_id")
        lot = await inv_repo.get_lot(db, lot_uuid)
        if lot is None:
            raise NotFoundError(f"Lot {src.lot_id} not found", code="lot_not_found")
        if item_id is None:
            item_id = lot.item_id
            item = await _require_consumable_item(db, item_id)
        elif lot.item_id != item_id:
            raise ValidationError("All sources must be for the same consumable", code="mixed_items")
        plans.append(
            (
                i,
                lot_uuid,
                node_uuid,
                lot.lot_number,
                src.qty,
                lot.expiration_date,
                list(src.cell_allocation_ids),
            )
        )

    assert item_id is not None and item is not None  # sources has min_length 1

    lines: list[IssueResultLine] = []
    first_movement = None
    for line_no, lot_uuid, node_uuid, lot_number, qty, expiration, cell_ids in plans:
        await _draw_source(
            db,
            item_id=item_id,
            lot_uuid=lot_uuid,
            node_uuid=node_uuid,
            qty=qty,
            line_no=line_no,
            cell_allocation_ids=cell_ids,
        )
        movement = await cons_repo.create_issue_movement(
            db,
            item_id=item_id,
            lot_id=lot_uuid,
            from_location_node_id=node_uuid,
            kanban_node_id=kanban.id,
            qty=qty,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence_uuid,
            notes=payload.notes,
        )
        # NO allocation at the Kanban. The units are debited and gone; the bin
        # is the ADDRESS on the movement, not a place that holds a balance.
        # A balance here was built and rejected — see the kan01 migration
        # docstring for why.
        #
        # ONE FLAG PER SOURCE LOT — deliberate. TRX-003 drops per-lot
        # traceability for consumables, but §4.2 tracks the expiration of a
        # specific issued quantity, and two lots issued together can carry two
        # different dates, so each needs its own check and its own clearing.
        await cons_repo.record_issue(db, movement_id=movement.id)
        if first_movement is None:
            first_movement = movement
        lines.append(
            IssueResultLine(
                lot_id=str(lot_uuid),
                lot_number=lot_number,
                qty=qty,
                expiration_date=expiration,  # type: ignore[arg-type]
            )
        )

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

    _, kanban_path = await loc_repo.node_paths(db, from_node_id=kanban.id, to_node_id=kanban.id)
    response = ConsumableIssueRead(
        item_id=str(item_id),
        item_number=item.item_number,
        total_qty=sum(ln.qty for ln in lines),
        kanban_node_id=str(kanban.id),
        kanban_path=kanban_path or kanban.name,
        performed_at=first_movement.performed_at,
        lines=lines,
    )
    await db.commit()
    return response


# ── Kanban balance + restock (KAN-001) ──────────────────────────────────
#
# Declared ABOVE ``/{issue_id}/…`` — see the ordering note near the top. These
# are literal paths and FastAPI matches in declaration order.


async def _request_read(db: DBSession, req) -> RestockRequestRead:
    _, path = await loc_repo.node_paths(
        db, from_node_id=req.kanban_node_id, to_node_id=req.kanban_node_id
    )
    # No ``on_hand_qty``: a Kanban carries no balance to report. What the floor
    # can usefully be told instead is how much has been ISSUED into this bin
    # since the request was raised — the replenishment against the ask.
    issued = await cons_repo.issued_qty_since(
        db,
        kanban_node_id=req.kanban_node_id,
        item_id=req.item_id,
        since=req.requested_at,
    )
    return RestockRequestRead(
        id=str(req.id),
        kanban_node_id=str(req.kanban_node_id),
        kanban_path=path or (req.kanban.name if req.kanban else ""),
        item_id=str(req.item_id),
        item_number=req.item.item_number if req.item else "",
        description=req.item.description if req.item else None,
        requested_qty=req.requested_qty,
        note=req.note,
        state=req.state,  # type: ignore[arg-type]
        requested_at=req.requested_at,
        requested_by=req.requested_by.full_name if req.requested_by else None,
        closed_at=req.closed_at,
        closed_by=req.closed_by.full_name if req.closed_by else None,
        consumed_qty=req.consumed_qty,
        issued_since_qty=issued,
    )


@consumables_router.post(
    "/restock-requests",
    response_model=RestockRequestRead,
    status_code=status.HTTP_201_CREATED,
    summary="Raise a restock request for a Kanban (KAN-001)",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def create_restock_request(
    db: DBSession, current: CurrentDbUserDep, payload: RestockRequestCreate
) -> RestockRequestRead:
    """"We are low on this." Not e-signed — see :class:`RestockRequestCreate`.

    A duplicate is refused rather than queued: the partial unique index allows
    one open request per (bin, item), and asking twice is the same ask.
    """
    kanban = await _require_kanban_node(db, payload.kanban_node_id)
    item_uuid = _parse_uuid(payload.item_id, field="item_id")
    item = await _require_consumable_item(db, item_uuid)

    existing = await cons_repo.open_request_for(
        db, kanban_node_id=kanban.id, item_id=item_uuid
    )
    if existing is not None:
        raise ValidationError(
            "There is already an open restock request for this item in this Kanban.",
            code="restock_request_open",
            details={"existing_id": str(existing.id)},
        )

    req = await cons_repo.create_restock_request(
        db,
        kanban_node_id=kanban.id,
        item_id=item_uuid,
        requested_qty=payload.requested_qty,
        note=payload.note,
        requested_by_user_id=current.id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.kanban_restock_requests",
        subject_id=req.id,
        subject_label=f"Restock {kanban.name}",
        # Explicitly None, not omitted: the parameter is keyword-only and
        # REQUIRED, so leaving it out is a TypeError at call time rather than a
        # type error at import. A creation has no prior state to record.
        before=None,
        after={
            "item": item.item_number,
            "requested_qty": payload.requested_qty,
            "note": payload.note,
        },
    )
    await db.refresh(req, ["kanban", "item", "requested_by"])
    read = await _request_read(db, req)
    await db.commit()
    return read


@consumables_router.get(
    "/restock-requests",
    response_model=RestockRequestListResponse,
    summary="Restock requests, newest first (KAN-001)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_restock_requests(
    db: DBSession,
    kanban_node_id: Annotated[str | None, Query()] = None,
    # By ITEM, across every Kanban — the question the item page asks. A request
    # is raised on the floor by whoever notices the bin is low, and answered in
    # stores by whoever issues the replenishment; those are different people
    # looking at different screens, so the ask has to be findable from both
    # ends.
    item_id: Annotated[str | None, Query()] = None,
    state: Annotated[RequestState | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RestockRequestListResponse:
    node_uuid = _parse_uuid(kanban_node_id, field="kanban_node_id") if kanban_node_id else None
    item_uuid = _parse_uuid(item_id, field="item_id") if item_id else None
    rows = await cons_repo.list_restock_requests(
        db,
        kanban_node_id=node_uuid,
        item_id=item_uuid,
        state=state,
        limit=limit,
        offset=offset,
    )
    # The matching count, NOT ``len(rows)``. That is the page size, so a second
    # page would report a total equal to what is already on screen and the
    # paginator would never offer one.
    total = await cons_repo.count_restock_requests(
        db, kanban_node_id=node_uuid, item_id=item_uuid, state=state
    )
    return RestockRequestListResponse(
        items=[await _request_read(db, r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@consumables_router.post(
    "/restock-requests/{request_id}/cancel",
    response_model=RestockRequestRead,
    summary="Withdraw a restock request (KAN-001)",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def cancel_restock_request(
    db: DBSession, current: CurrentDbUserDep, request_id: Annotated[uuid.UUID, Path()]
) -> RestockRequestRead:
    """The bin was filled by hand, the line stopped, the item was swapped.

    Not e-signed and it writes no ledger row: withdrawing an ask states nothing
    about material. It closes with no ``consumption_movement_id``, which is why
    that column is nullable.
    """
    req = await cons_repo.get_restock_request(db, request_id)
    if req is None:
        raise NotFoundError(f"Restock request {request_id} not found", code="request_not_found")
    if req.state != "open":
        raise ValidationError(
            f"That request is already {req.state}.", code="request_not_open"
        )
    await cons_repo.close_restock_request(
        db, request=req, state="cancelled", user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kanban_restock_requests",
        subject_id=req.id,
        subject_label="Restock request cancelled",
        before={"state": "open"},
        after={"state": "cancelled"},
    )
    await db.refresh(req, ["kanban", "item", "requested_by", "closed_by"])
    read = await _request_read(db, req)
    await db.commit()
    return read


@consumables_router.post(
    "/restock-requests/{request_id}/acknowledge",
    response_model=RestockRequestRead,
    summary="Acknowledge and close a restock request (KAN-001, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def acknowledge_consumption(
    db: DBSession,
    current: CurrentDbUserDep,
    request_id: Annotated[uuid.UUID, Path()],
    payload: AcknowledgeConsumptionRequest,
) -> RestockRequestRead:
    """KAN-001's "acknowledges consumption" — the signed closure of a request.

    **This moves no stock, and that is the point.** The units were debited when
    they were issued to the Kanban (07-09 TRX-001) — there is no bin balance
    left to draw down. What is being recorded is that somebody dealt with the
    ask: a statement about material, not a transaction against it. No ledger
    row is written.

    **No quantity is required** (client 2026-08-27), and ``qty`` is optional.
    The requirement's "marks the depleted quantity consumed" was first read as
    wanting a figure; nothing anywhere consumes it — the stock left at issue, so
    no balance, report or reconciliation reads ``consumed_qty`` — and a request
    that carried no requested quantity produced an attestation reading "0 was
    used", a false sentence over a Part 11 signature. What is signed now is what
    is true: this request was actioned and is closed. See the request schema.

    **Still e-signed**, for the reason the expiry check is: an attributable
    statement about what became of material falls under Part 11 §11.200 whether
    or not a quantity moves. Its own verb (``consumable.consumption``), bound to
    the request row (VR-006) — several bins can have requests open at once, and
    an unbound ticket would close whichever one the next call named.
    """
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    req = await cons_repo.get_restock_request(db, request_id)
    if req is None:
        raise NotFoundError(f"Restock request {request_id} not found", code="request_not_found")
    if req.state != "open":
        raise ValidationError(f"That request is already {req.state}.", code="request_not_open")

    await cons_repo.close_restock_request(
        db,
        request=req,
        state="fulfilled",
        user_id=current.id,
        consumed_qty=payload.qty,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kanban_restock_requests",
        subject_id=req.id,
        subject_label=f"{req.item.item_number if req.item else ''} restock acknowledged",
        before={"state": "open", "consumed_qty": None},
        after={"state": "fulfilled", "consumed_qty": payload.qty, "note": payload.note},
        signature_id=evidence_uuid,
    )
    # Consumed LAST, so a replayed signature rolls the closure back with it.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=CONSUMPTION_ACTION,
        target_table="app.kanban_restock_requests",
        target_id=req.id,
        record_table="app.kanban_restock_requests",
        record_id=req.id,
    )
    await db.refresh(req, ["kanban", "item", "requested_by", "closed_by"])
    read = await _request_read(db, req)
    await db.commit()
    return read


@consumables_router.post(
    "/{issue_id}/acknowledge",
    response_model=IssuedConsumableRead,
    summary="Clear an expiration flag after the physical check (LOC-008, e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def acknowledge(
    db: DBSession,
    current: CurrentDbUserDep,
    issue_id: Annotated[uuid.UUID, Path()],
    payload: AcknowledgeRequest,
) -> IssuedConsumableRead:
    """E-signed (client 2026-08-12), action ``consumable.expiry_check``.

    07-09 TRX-006 asks for "a simple acknowledgment" and no quantity moves,
    which is why this was originally unsigned. The disposition is what changed
    the reading: "discarded" / "consumed before its date" is an attributable
    statement about what happened to material, and it is the ONLY record of
    that outcome anywhere in the system — the ledger stopped at the issue. Part
    11 §11.200 wants the person behind such a statement re-identified at the
    moment they make it. "Simple" is honoured as *one step and no quantities to
    reconcile*, which the dialog still is.

    Evidence is consumed LAST so a replay rolls the clearing back with it, and
    the signature is bound to this register row (VR-006) — a ticket minted on
    one flagged row cannot close out another.

    The flag is cleared, never the record — the register keeps saying where and
    when the material was issued, which is the part TRX-006 requires the
    acknowledgment to show.
    """
    evidence_uuid = _parse_uuid(payload.evidence_id, field="evidence_id")
    issue = await cons_repo.get_issue(db, issue_id)
    if issue is None:
        raise NotFoundError(f"Issued consumable {issue_id} not found", code="issue_not_found")
    if issue.cleared_at is not None:
        raise ValidationError("That flag has already been cleared", code="already_acknowledged")

    await cons_repo.clear_flag(
        db,
        issue=issue,
        user_id=current.id,
        disposition=payload.disposition,
        note=payload.note,
    )
    # Setting the FK does not populate the relationship on an already-loaded
    # instance, so the response would report a null clearer for the very action
    # that just named one. Refresh it before the row is serialised.
    await db.refresh(issue, ["cleared_by"])
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.consumable_issues",
        subject_id=issue.id,
        # Item / lot come off the MOVEMENT — the register itself stores neither.
        subject_label=(
            f"{issue.movement.item.item_number if issue.movement.item else ''} expiry check"
        ),
        before={"cleared": False},
        after={
            "cleared": True,
            "disposition": payload.disposition,
            "note": payload.note,
        },
        signature_id=evidence_uuid,
    )
    # The row this write produced IS the row it was signed about — unlike an
    # issue, nothing new is created here.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=ACK_ACTION,
        target_table="app.consumable_issues",
        target_id=issue.id,
        record_table="app.consumable_issues",
        record_id=issue.id,
    )
    warn_days = await cons_repo.get_warn_days(db)
    reads = await _to_reads(db, [issue], warn_days=warn_days)
    await db.commit()
    return reads[0]
