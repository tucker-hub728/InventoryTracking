"""Kitting / back-flush API (``/v1/kits``).

Implements the lifecycle from ``docs/modules/kitting.md``: Draft → Issued →
In Production → Closed (+ draft-only Cancel). Quantity changes are written to
the ``app.stock_movements`` ledger; on-hand stays derived through
``app.v_item_stock``. Only **close-out** is e-signed.

v1 boundary (see module doc §1): this module is a *writer* of the ledger. It
does not deplete per-node ``lot_allocations`` — placement is the Location
System's job — so a component's source/return/output nodes are recorded on the
movements but not reconciled against per-cell stock here.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit.recorder import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.locations import repository as loc_repo
from app.models.inventory import Item, StockMovement
from app.models.kitting import Kit, KitLine
from app.security.permissions import RequirePermission

from . import repository as kit_repo
from .schemas import (
    AdditionalIssueRequest,
    CancelRequest,
    CloseOutRequest,
    IssueRequest,
    KitActivityResponse,
    KitActivityRow,
    KitCreateRequest,
    KitLineRead,
    KitLineSourceOption,
    KitLineUpdateRequest,
    KitListItem,
    KitListResponse,
    KitRead,
    ProductionDraftRequest,
)

kits_router = APIRouter(prefix="/kits", tags=["kitting"])

# Where a kit's output / back-flush lands — free storage leaves only (no box
# cell placement in v1).
_PLACEABLE_NODE_TYPES = ("shelf", "sub_location")

# The reauth action verb minted by the frontend before close-out.
CLOSEOUT_ACTION = "kit.closeout"
_BUILT_TIERS = ("sub_assembly", "finished_good")


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(f"{field} is not a valid UUID", code="invalid_uuid") from exc


def _line_returned(line: KitLine) -> int | None:
    if line.used_qty is None:
        return None
    return line.issued_qty + line.additional_issued_qty - line.used_qty


def _line_read(
    line: KitLine,
    target_qty: int,
    items: dict[uuid.UUID, Item],
    stock_by_node: dict[uuid.UUID, dict[uuid.UUID, int]],
    node_labels: dict[uuid.UUID, tuple[str, str]],
) -> KitLineRead:
    item = items.get(line.item_id)
    per_node = stock_by_node.get(line.item_id, {})
    options = sorted(
        (
            KitLineSourceOption(
                node_id=str(node_id),
                name=node_labels.get(node_id, ("", ""))[0],
                path=node_labels.get(node_id, ("", ""))[1],
                qty=qty,
            )
            for node_id, qty in per_node.items()
        ),
        key=lambda o: o.name,
    )
    return KitLineRead(
        id=str(line.id),
        line_no=line.line_no,
        item_id=str(line.item_id),
        item_number=item.item_number if item else "",
        description=item.description if item else "",
        qty_per_unit=line.qty_per_unit,
        needed_qty=line.qty_per_unit * target_qty,
        issued_qty=line.issued_qty,
        additional_issued_qty=line.additional_issued_qty,
        used_qty=line.used_qty,
        returned_qty=_line_returned(line),
        source_location_node_id=(
            str(line.source_location_node_id) if line.source_location_node_id else None
        ),
        return_location_node_id=(
            str(line.return_location_node_id) if line.return_location_node_id else None
        ),
        on_hand=sum(per_node.values()),
        source_options=options,
        source_available=(
            per_node.get(line.source_location_node_id, 0)
            if line.source_location_node_id
            else 0
        ),
    )


async def _kit_read(db, kit: Kit) -> KitRead:
    item_ids = {kit.item_id} | {ln.item_id for ln in kit.lines}
    items = await kit_repo.load_item_map(db, item_ids)
    # Per-node stock only matters for the component lines (the Issue-step
    # source picker + on-hand preview).
    line_item_ids = {ln.item_id for ln in kit.lines}
    stock_by_node = await kit_repo.item_stock_by_node(db, line_item_ids)
    node_labels = await loc_repo.node_label_map(db) if stock_by_node else {}
    parent = items.get(kit.item_id)
    return KitRead(
        id=str(kit.id),
        kit_number=kit.kit_number,
        item_id=str(kit.item_id),
        item_number=parent.item_number if parent else "",
        description=parent.description if parent else "",
        target_qty=kit.target_qty,
        status=kit.status,  # type: ignore[arg-type]
        production_location_node_id=str(kit.production_location_node_id),
        output_location_node_id=(
            str(kit.output_location_node_id) if kit.output_location_node_id else None
        ),
        good_qty=kit.good_qty,
        scrap_qty=kit.scrap_qty,
        notes=kit.notes,
        issued_at=kit.issued_at,
        closed_at=kit.closed_at,
        created_by_user_id=str(kit.created_by_user_id),
        created_at=kit.created_at,
        updated_at=kit.updated_at,
        lines=[
            _line_read(ln, kit.target_qty, items, stock_by_node, node_labels)
            for ln in kit.lines
        ],
    )


async def _require_kit(db, kit_id: uuid.UUID) -> Kit:
    kit = await kit_repo.get_kit(db, kit_id)
    if kit is None:
        raise NotFoundError(f"Kit {kit_id} not found", code="kit_not_found")
    return kit


async def _consume_from_source(
    db, *, kit: Kit, line: KitLine, qty: int, movement_type: str, note: str, current
) -> None:
    """Consume ``qty`` of a line's component from its source node — decrement the
    node's lot allocations FIFO (by expiry, then age) and write one kit movement
    per lot. Blocks (422) when the source doesn't hold enough (task 2 limit)."""
    node_id = line.source_location_node_id
    if node_id is None:
        raise ValidationError(
            f"Line {line.line_no} needs a source location", code="source_required"
        )
    allocs = await kit_repo.allocations_for_item_at_node(db, line.item_id, node_id)
    available = sum(int(a.qty) for a in allocs)
    if qty > available:
        raise ValidationError(
            f"Line {line.line_no}: only {available} available at the source location "
            f"(tried to issue {qty}).",
            code="insufficient_source_stock",
        )
    remaining = qty
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        await kit_repo.create_kit_movement(
            db,
            kit_id=kit.id,
            kit_line_id=line.id,
            item_id=line.item_id,
            movement_type=movement_type,
            qty_delta=-take,
            from_location_node_id=node_id,
            to_location_node_id=None,
            performed_by_user_id=current.id,
            reauth_evidence_id=None,
            notes=note,
            lot_id=alloc.lot_id,
        )
        remaining -= take


async def _require_placeable(db, node_id: uuid.UUID, field: str):
    """A node stock can be placed into — a free storage leaf (no box cells in v1)."""
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"{field} not found", code="location_not_found")
    if node.node_type not in _PLACEABLE_NODE_TYPES:
        raise ValidationError(
            f"{field} must be a warehouse shelf or freezer sub-location "
            f"(not a {node.node_type}).",
            code="node_not_placeable",
        )
    return node


async def _place(
    db,
    *,
    kit: Kit,
    item_id: uuid.UUID,
    node_id: uuid.UUID,
    qty: int,
    movement_type: str,
    kit_line_id: uuid.UUID | None,
    lot_suffix: str,
    evidence: uuid.UUID,
    note: str,
    current,
) -> None:
    """Place ``qty`` of an item into a node — create a lot + allocation and write
    the unit-IN movement. Used for production output + back-flush at close-out."""
    lot = await inv_repo.create_lot(
        db,
        item_id=item_id,
        lot_number=f"KIT-{kit.kit_number}-{lot_suffix}",
        created_by_user_id=current.id,
    )
    await loc_repo.create_allocation(
        db,
        lot_id=lot.id,
        location_node_id=node_id,
        qty=qty,
        created_by_user_id=current.id,
    )
    await kit_repo.create_kit_movement(
        db,
        kit_id=kit.id,
        kit_line_id=kit_line_id,
        item_id=item_id,
        movement_type=movement_type,
        qty_delta=qty,
        from_location_node_id=None,
        to_location_node_id=node_id,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence,
        notes=note,
        lot_id=lot.id,
    )


# ── List / get ──────────────────────────────────────────────────────────


@kits_router.get(
    "",
    response_model=KitListResponse,
    summary="List kits (newest first)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_kits(
    db: DBSession,
    status_filter: Annotated[
        Literal["draft", "issued", "in_production", "closed", "cancelled"] | None,
        Query(alias="status", description="Filter by kit status"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> KitListResponse:
    rows, total = await kit_repo.list_kits(db, status=status_filter, limit=limit, offset=offset)
    items = await kit_repo.load_item_map(db, {k.item_id for k in rows})
    return KitListResponse(
        items=[
            KitListItem(
                id=str(k.id),
                kit_number=k.kit_number,
                item_id=str(k.item_id),
                item_number=(items[k.item_id].item_number if k.item_id in items else ""),
                description=(items[k.item_id].description if k.item_id in items else ""),
                target_qty=k.target_qty,
                status=k.status,  # type: ignore[arg-type]
                production_location_node_id=str(k.production_location_node_id),
                good_qty=k.good_qty,
                scrap_qty=k.scrap_qty,
                line_count=len(k.lines),
                created_at=k.created_at,
            )
            for k in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@kits_router.get(
    "/{kit_id}",
    response_model=KitRead,
    summary="Get one kit with its lines",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_kit(db: DBSession, kit_id: Annotated[uuid.UUID, Path()]) -> KitRead:
    kit = await _require_kit(db, kit_id)
    return await _kit_read(db, kit)


@kits_router.get(
    "/{kit_id}/activity",
    response_model=KitActivityResponse,
    summary="The kit's ledger (its stock movements, newest first)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def kit_activity(db: DBSession, kit_id: Annotated[uuid.UUID, Path()]) -> KitActivityResponse:
    await _require_kit(db, kit_id)
    movements = await kit_repo.kit_movements(db, kit_id)
    items = await kit_repo.load_item_map(db, {m.item_id for m in movements})
    return KitActivityResponse(items=[_activity_row(m, items) for m in movements])


def _activity_row(m: StockMovement, items: dict[uuid.UUID, Item]) -> KitActivityRow:
    item = items.get(m.item_id)
    return KitActivityRow(
        id=str(m.id),
        performed_at=m.performed_at,
        movement_type=m.movement_type,
        item_id=str(m.item_id),
        item_number=item.item_number if item else "",
        qty_delta=m.qty_delta,
        from_location_node_id=(str(m.from_location_node_id) if m.from_location_node_id else None),
        to_location_node_id=(str(m.to_location_node_id) if m.to_location_node_id else None),
        notes=m.notes,
        performed_by_user_id=str(m.performed_by_user_id),
    )


# ── Create ──────────────────────────────────────────────────────────────


@kits_router.post(
    "",
    response_model=KitRead,
    status_code=status.HTTP_201_CREATED,
    summary="Open a kit for a sub-assembly or finished good",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_kit(
    db: DBSession, current: CurrentDbUserDep, payload: KitCreateRequest
) -> KitRead:
    item_id = _parse_uuid_or_422(payload.item_id, field="item_id")
    prod_node = _parse_uuid_or_422(
        payload.production_location_node_id, field="production_location_node_id"
    )

    tier_type = await kit_repo.get_item_tier_type(db, item_id)
    if tier_type is None:
        raise NotFoundError(f"Item {item_id} not found", code="item_not_found")
    if tier_type not in _BUILT_TIERS:
        raise ValidationError(
            "Only a sub-assembly or finished good can be kitted",
            code="item_not_buildable",
        )
    if not await kit_repo.storage_node_exists(db, prod_node):
        raise NotFoundError("Production location not found", code="production_location_not_found")

    children = await kit_repo.list_bom_children(db, item_id)
    if not children:
        raise ValidationError(
            "This item has no bill of materials, so it can't be kitted",
            code="item_has_no_bom",
        )

    kit_number = await kit_repo.next_kit_number(db)
    kit = await kit_repo.create_kit(
        db,
        kit_number=kit_number,
        item_id=item_id,
        target_qty=payload.target_qty,
        production_location_node_id=prod_node,
        notes=payload.notes,
        created_by_user_id=current.id,
    )
    default_source = await kit_repo.default_source_node_id(db)
    for line_no, bom in enumerate(children, start=1):
        await kit_repo.add_kit_line(
            db,
            kit_id=kit.id,
            line_no=line_no,
            item_id=bom.child_item_id,
            qty_per_unit=bom.qty_per_unit,
            issued_qty=kit_repo.default_issued_qty(bom.qty_per_unit, payload.target_qty),
            source_location_node_id=default_source,
        )

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=None,
        after={"item_id": str(item_id), "target_qty": kit.target_qty},
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Draft line edit ─────────────────────────────────────────────────────


@kits_router.patch(
    "/{kit_id}/lines/{line_id}",
    response_model=KitRead,
    summary="Edit a draft line (issued qty / source)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_line(
    db: DBSession,
    kit_id: Annotated[uuid.UUID, Path()],
    line_id: Annotated[uuid.UUID, Path()],
    payload: KitLineUpdateRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status != "draft":
        raise ValidationError(
            "Lines can only be edited while the kit is a draft",
            code="kit_not_draft",
        )
    line = next((ln for ln in kit.lines if ln.id == line_id), None)
    if line is None:
        raise NotFoundError(f"Line {line_id} not on kit {kit_id}", code="line_not_found")

    if payload.issued_qty is not None:
        line.issued_qty = payload.issued_qty
    if payload.source_location_node_id is not None:
        src = _parse_uuid_or_422(payload.source_location_node_id, field="source_location_node_id")
        if not await kit_repo.storage_node_exists(db, src):
            raise NotFoundError("Source location not found", code="source_not_found")
        line.source_location_node_id = src
        # Return defaults to the source it was pulled from (editable at close-out).
        line.return_location_node_id = src
    await db.flush()
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Issue ───────────────────────────────────────────────────────────────


@kits_router.post(
    "/{kit_id}/issue",
    response_model=KitRead,
    summary="Issue material to production (draft → in production)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def issue_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: IssueRequest | None = None,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status != "draft":
        raise ValidationError("Only a draft kit can be issued", code="kit_not_draft")

    # The draft edits (issued qty + source per line) are committed here, so the
    # Issue button is the only write — nothing is persisted while the user types.
    if payload and payload.lines:
        lines_by_id = {ln.id: ln for ln in kit.lines}
        for line_in in payload.lines:
            lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
            line = lines_by_id.get(lid)
            if line is None:
                raise ValidationError(f"Line {lid} is not on this kit", code="line_not_in_kit")
            line.issued_qty = line_in.issued_qty
            if line_in.source_location_node_id is not None:
                src = _parse_uuid_or_422(
                    line_in.source_location_node_id, field="source_location_node_id"
                )
                if not await kit_repo.storage_node_exists(db, src):
                    raise NotFoundError("Source location not found", code="source_not_found")
                line.source_location_node_id = src
        await db.flush()

    # Leftover back-flushes to where it was pulled from, so the return location
    # defaults to the line's actual source (still editable at close-out).
    for line in kit.lines:
        line.return_location_node_id = line.source_location_node_id

    if all(ln.issued_qty <= 0 for ln in kit.lines):
        raise ValidationError("Nothing to issue — every line is zero", code="nothing_to_issue")

    for line in kit.lines:
        if line.issued_qty <= 0:
            continue
        await _consume_from_source(
            db,
            kit=kit,
            line=line,
            qty=line.issued_qty,
            movement_type="kit_issue",
            note=f"Issued {line.issued_qty} to production for {kit.kit_number}",
            current=current,
        )

    # Issuing lands the kit on the production floor — move straight into
    # production so the next step is ready (mirrors the mock).
    kit.status = "in_production"
    kit.issued_at = _now()
    kit.issued_by_user_id = current.id
    kit.updated_by_user_id = current.id
    await db.flush()
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before={"status": "draft"},
        after={"status": kit.status},
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


@kits_router.post(
    "/{kit_id}/lines/{line_id}/additional-issue",
    response_model=KitRead,
    summary="Issue extra material to a line mid-production",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def additional_issue(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    line_id: Annotated[uuid.UUID, Path()],
    payload: AdditionalIssueRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Additional material can only be issued to a kit in production",
            code="kit_not_in_production",
        )
    line = next((ln for ln in kit.lines if ln.id == line_id), None)
    if line is None:
        raise NotFoundError(f"Line {line_id} not on kit {kit_id}", code="line_not_found")

    await _consume_from_source(
        db,
        kit=kit,
        line=line,
        qty=payload.qty,
        movement_type="kit_additional_issue",
        note=f"Additional {payload.qty} issued for {kit.kit_number}",
        current=current,
    )
    line.additional_issued_qty += payload.qty
    kit.updated_by_user_id = current.id
    await db.flush()
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Production draft (unsigned; the signed commit is close-out) ──────────


@kits_router.patch(
    "/{kit_id}/production",
    response_model=KitRead,
    summary="Save the production figures (good/scrap/output) before close-out",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def save_production(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: ProductionDraftRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Production figures can only be saved while the kit is in production",
            code="kit_not_in_production",
        )
    if payload.good_qty is not None:
        kit.good_qty = payload.good_qty
    if payload.scrap_qty is not None:
        kit.scrap_qty = payload.scrap_qty
    if payload.output_location_node_id:
        out_node = _parse_uuid_or_422(
            payload.output_location_node_id, field="output_location_node_id"
        )
        await _require_placeable(db, out_node, "Output location")
        kit.output_location_node_id = out_node
    kit.updated_by_user_id = current.id
    await db.flush()
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Close-out (e-signed, atomic) ────────────────────────────────────────


@kits_router.post(
    "/{kit_id}/close-out",
    response_model=KitRead,
    summary="Post output, reconcile, and back-flush the leftover. E-signed.",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def close_out_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: CloseOutRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Only a kit in production can be closed out", code="kit_not_closeable"
        )
    if payload.good_qty + payload.scrap_qty == 0:
        raise ValidationError(
            "Record what production yielded — made and scrapped can't both be zero",
            code="no_output",
        )
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    output_node = _parse_uuid_or_422(
        payload.output_location_node_id, field="output_location_node_id"
    )
    await _require_placeable(db, output_node, "Output location")

    lines_by_id = {ln.id: ln for ln in kit.lines}
    used_by_id: dict[uuid.UUID, int] = {}
    for line_in in payload.lines:
        lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        if lid not in lines_by_id:
            raise ValidationError(f"Line {lid} is not on this kit", code="line_not_in_kit")
        used_by_id[lid] = line_in.used_qty
    missing = [ln.line_no for ln in kit.lines if ln.id not in used_by_id]
    if missing:
        raise ValidationError(
            f"Enter a used quantity for every line (missing: {missing})",
            code="used_qty_missing",
        )

    # Apply used + validate the over-use guard (also enforced by DB CHECK).
    for line_in in payload.lines:
        lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        line = lines_by_id[lid]
        issued_total = line.issued_qty + line.additional_issued_qty
        if line_in.used_qty > issued_total:
            raise ValidationError(
                f"Line {line.line_no}: used {line_in.used_qty} exceeds issued "
                f"{issued_total}. Record an additional issue to cover it.",
                code="used_exceeds_issued",
            )
        line.used_qty = line_in.used_qty
        if line_in.return_location_node_id is not None:
            ret = _parse_uuid_or_422(
                line_in.return_location_node_id, field="return_location_node_id"
            )
            await _require_placeable(db, ret, "Return location")
            line.return_location_node_id = ret

    # 1. Production output → place the finished AY/FG into stock (§3.1).
    if payload.good_qty > 0:
        await _place(
            db,
            kit=kit,
            item_id=kit.item_id,
            node_id=output_node,
            qty=payload.good_qty,
            movement_type="production_output",
            kit_line_id=None,
            lot_suffix="OUT",
            evidence=evidence_uuid,
            note=f"{payload.good_qty} produced and stocked for {kit.kit_number}",
            current=current,
        )

    # 2. Back-flush the leftover per line — place it back into inventory
    #    (REQ-2026-07-09-TRX-003). No lot traceability, so it returns as a fresh lot.
    for line in kit.lines:
        returned = _line_returned(line) or 0
        if returned <= 0:
            continue
        ret_node = line.return_location_node_id or line.source_location_node_id
        if ret_node is None:
            raise ValidationError(
                f"Line {line.line_no} has nowhere to back-flush to", code="return_required"
            )
        await _require_placeable(db, ret_node, "Return location")
        await _place(
            db,
            kit=kit,
            item_id=line.item_id,
            node_id=ret_node,
            qty=returned,
            movement_type="backflush",
            kit_line_id=line.id,
            lot_suffix=f"BF-{line.line_no}",
            evidence=evidence_uuid,
            note=(
                f"Issued {line.issued_qty + line.additional_issued_qty}, "
                f"used {line.used_qty}, backflushed {returned}"
            ),
            current=current,
        )

    kit.status = "closed"
    kit.good_qty = payload.good_qty
    kit.scrap_qty = payload.scrap_qty
    kit.output_location_node_id = output_node
    kit.closed_at = _now()
    kit.closed_by_user_id = current.id
    kit.updated_by_user_id = current.id
    await db.flush()

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before={"status": "in_production"},
        after={
            "status": "closed",
            "good_qty": payload.good_qty,
            "scrap_qty": payload.scrap_qty,
        },
        signature_id=evidence_uuid,
    )
    # Consume the evidence last so a replay rolls back the whole close-out.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=CLOSEOUT_ACTION,
        target_table="app.kits",
        target_id=kit.id,
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Cancel (draft-only) ─────────────────────────────────────────────────


@kits_router.post(
    "/{kit_id}/cancel",
    response_model=KitRead,
    summary="Cancel a draft kit (nothing has moved)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def cancel_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: CancelRequest | None = None,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    # Draft-only for now (client 2026-07-20). Post-issue cancel (back-flush
    # everything) is deferred — see the module doc §99.8.
    if kit.status != "draft":
        raise ValidationError(
            "Only a draft kit can be cancelled",
            code="cancel_draft_only",
        )
    kit.status = "cancelled"
    kit.closed_at = _now()
    kit.closed_by_user_id = current.id
    kit.updated_by_user_id = current.id
    await db.flush()
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before={"status": "draft"},
        after={"status": "cancelled"},
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


def _now() -> datetime:
    return datetime.now(UTC)
