"""Kitting / back-flush API (``/v1/kits``).

Implements the lifecycle from ``docs/modules/kitting.md``: Draft → Issued →
In Production → Closed (+ draft-only Cancel). Quantity changes are written to
the ``app.stock_movements`` ledger; on-hand stays derived through
``app.v_item_stock``. Only **close-out** is e-signed.

Stock model (``docs/modules/kitting-wip-build.md``, corrected 2026-07-21):
issuing **moves** material from its source node to the kit's production node —
``Transaction_Spec`` §2 requires the location to be updated at kitting. The
movement keeps a negative ``qty_delta``, so available on-hand drops at issue
(TRX-001), while ``lot_allocations`` holds the WIP at the production node until
close-out. The two balances therefore diverge by the WIP amount while kits are
open, by design: ``v_item_stock`` is *available* stock, allocations are
*physical placement*.

Excess can be handed back at any point in production with no lot assignment
(REQ-2026-07-01-TRX-008), and cancelling an in-production kit returns
everything — nothing is ever stranded, because nothing was bound to a
production lot at kitting (TRX-002).
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit.recorder import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.locations import repository as loc_repo
from app.models.inventory import Item, StockMovement
from app.models.kitting import Kit, KitLine
from app.security.permissions import RequirePermission

from . import repository as kit_repo
from .schemas import (
    AdditionalIssueRequest,
    CancelRequest,
    CellOption,
    CloseOutRequest,
    FloorKit,
    FloorKitConsumed,
    FloorKitConsumedLine,
    FloorKitLine,
    FloorKitsResponse,
    IssueRequest,
    KitActivityResponse,
    KitActivityRow,
    KitAuditEventRow,
    KitCreateRequest,
    KitLineRead,
    KitLineSourceOption,
    KitLineUpdateRequest,
    KitListItem,
    KitListResponse,
    KitNumberSuggestion,
    KitRead,
    KitUpdateRequest,
    ProductionDraftRequest,
    ReturnExcessRequest,
)

kits_router = APIRouter(prefix="/kits", tags=["kitting"])

# Where a kit's output / back-flush lands — free storage leaves only (no box
# cell placement in v1).
_PLACEABLE_NODE_TYPES = ("shelf", "sub_location")

# The reauth action verb minted by the frontend before close-out.
CLOSEOUT_ACTION = "kit.closeout"
CANCEL_ACTION = "kit.cancel"
_BUILT_TIERS = ("sub_assembly", "finished_good")

# Smallest BOM a kit can be opened against. Transaction_Spec §1.1 composes
# every built item from two inputs (CR+CR→AY, AY+AY→AY, CR+AY→FG), so a
# single-line BOM is an unfinished recipe, not a kittable item.
_MIN_BOM_LINES = 2


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(f"{field} is not a valid UUID", code="invalid_uuid") from exc


def _on_floor(line: KitLine) -> int:
    """What is still physically on the production floor for this line —
    ``issued + additional − early_returned`` (§3.3 of the build plan)."""
    return line.issued_qty + line.additional_issued_qty - line.early_returned_qty


def _needed(line: KitLine, target_qty: int) -> Decimal:
    """The BOM requirement for the whole build — ``qty_per_unit × target_qty``
    (``Transaction_Spec`` §2, "quantity needed is derived from the BOM"). Not
    stored; recomputed wherever it gates a step."""
    return line.qty_per_unit * target_qty


def _effective_target(kit: Kit) -> int:
    """The unit count the kit is committed to build **right now**: the actual
    attempted output (good + scrap) once production figures exist, otherwise the
    planned target.

    Client-directed (2026-07-22), BEYOND ``Transaction_Spec`` — the spec keeps
    "needed" fixed at ``BOM × target`` and reconciles on actual Qty Used. Here
    "needed" is dynamic: producing more units than planned raises it, so more
    material must be issued and less can be returned. Isolated in this one helper
    so the deviation is easy to trace / revert."""
    attempted = (kit.good_qty or 0) + (kit.scrap_qty or 0)
    return attempted if attempted > 0 else kit.target_qty


def _needed_units(line: KitLine, kit: Kit) -> int:
    """The dynamic need for a line, rounded up to whole units — the floor the
    on-floor quantity (and Qty Used) may not drop below."""
    return kit_repo.default_issued_qty(line.qty_per_unit, _effective_target(kit))


def _kit_snapshot(kit: Kit) -> dict:
    """A full audit snapshot of a kit and *every* line.

    Recorded on **every** kitting activity event (client 2026-07-22 — "capture
    everything, don't miss anything"), so the audit trail never loses a field:
    good/scrap, per-line needed/issued/additional/used/returned, and the source
    and return locations. All values are JSON-native (UUIDs and the Decimal
    ``qty_per_unit`` / ``needed`` are stringified) so they store cleanly in the
    ``audit.audit_events`` JSONB columns.
    """
    return {
        "status": kit.status,
        "kit_number": kit.kit_number,
        "item_id": str(kit.item_id),
        "target_qty": kit.target_qty,
        "good_qty": kit.good_qty,
        "scrap_qty": kit.scrap_qty,
        "production_location_node_id": str(kit.production_location_node_id),
        "output_location_node_id": (
            str(kit.output_location_node_id) if kit.output_location_node_id else None
        ),
        "lines": [
            {
                "line_no": ln.line_no,
                "item_id": str(ln.item_id),
                "qty_per_unit": str(ln.qty_per_unit),
                "needed_qty": str(_needed(ln, kit.target_qty)),
                "issued_qty": ln.issued_qty,
                "additional_issued_qty": ln.additional_issued_qty,
                "used_qty": ln.used_qty,
                "early_returned_qty": ln.early_returned_qty,
                "on_floor_qty": _on_floor(ln),
                "source_location_node_id": (
                    str(ln.source_location_node_id) if ln.source_location_node_id else None
                ),
                "return_location_node_id": (
                    str(ln.return_location_node_id) if ln.return_location_node_id else None
                ),
            }
            for ln in sorted(kit.lines, key=lambda x: x.line_no)
        ],
    }


def _line_returned(line: KitLine) -> int | None:
    """The close-out back-flush amount (null until used is entered)."""
    if line.used_qty is None:
        return None
    return _on_floor(line) - line.used_qty


def _line_read(
    line: KitLine,
    target_qty: int,
    items: dict[uuid.UUID, Item],
    stock_by_node: dict[uuid.UUID, dict[uuid.UUID, int]],
    node_labels: dict[uuid.UUID, tuple[str, str]],
    cells_by_node: dict[uuid.UUID, dict[uuid.UUID, list]] | None = None,
    grid_meta: dict[uuid.UUID, tuple[int, int]] | None = None,
) -> KitLineRead:
    item = items.get(line.item_id)
    per_node = stock_by_node.get(line.item_id, {})
    line_cells = (cells_by_node or {}).get(line.item_id, {})
    grid_meta = grid_meta or {}

    def _option(node_id: uuid.UUID, qty: int) -> KitLineSourceOption:
        cells = line_cells.get(node_id, [])
        rows_cols = grid_meta.get(node_id)
        return KitLineSourceOption(
            node_id=str(node_id),
            name=node_labels.get(node_id, ("", ""))[0],
            path=node_labels.get(node_id, ("", ""))[1],
            qty=qty,
            is_grid=rows_cols is not None,
            grid_rows=rows_cols[0] if rows_cols else None,
            grid_cols=rows_cols[1] if rows_cols else None,
            cells=[
                CellOption(
                    allocation_id=str(a.id),
                    grid_row=int(a.grid_row),
                    grid_col=int(a.grid_col),
                    lot_id=str(a.lot_id),
                    lot_number=getattr(getattr(a, "lot", None), "lot_number", None),
                    expiration_date=getattr(getattr(a, "lot", None), "expiration_date", None),
                )
                for a in cells
            ],
        )

    options = sorted(
        (_option(node_id, qty) for node_id, qty in per_node.items()),
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
        early_returned_qty=line.early_returned_qty,
        on_floor_qty=_on_floor(line),
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
            per_node.get(line.source_location_node_id, 0) if line.source_location_node_id else 0
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
    # LN2 boxes additionally carry their occupied cells, so the Issue step can
    # draw the grid and the operator picks exact vials (D2).
    cells_by_node = await kit_repo.item_cells_by_node(db, line_item_ids)
    grid_ids = {node_id for per_node in cells_by_node.values() for node_id in per_node}
    grid_meta = {
        n.id: (int(n.grid_rows), int(n.grid_cols))
        for n in (await kit_repo.grid_nodes(db, grid_ids)).values()
        if n.grid_rows and n.grid_cols
    }
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
            _line_read(
                ln, kit.target_qty, items, stock_by_node, node_labels, cells_by_node, grid_meta
            )
            for ln in kit.lines
        ],
    )


async def _require_kit(db, kit_id: uuid.UUID) -> Kit:
    kit = await kit_repo.get_kit(db, kit_id)
    if kit is None:
        raise NotFoundError(f"Kit {kit_id} not found", code="kit_not_found")
    return kit


async def _move_to_production(
    db,
    *,
    kit: Kit,
    line: KitLine,
    qty: int,
    movement_type: str,
    note: str,
    current,
    cell_allocation_ids: list[str] | None = None,
) -> None:
    """Move ``qty`` of a line's component from its source node **to the kit's
    production node** — the relocation ``Transaction_Spec`` §2 requires.

    Reduces the source allocation FIFO (by expiry, then age) and re-allocates
    the **same lot** at the production node. Retaining the source lot is not a
    TRX-002 violation: TRX-002 forbids binding material to the production
    *output* lot at kitting time, not carrying its own incoming lot.

    ``qty_delta`` stays negative, so the material leaves *available* stock
    (TRX-001) while remaining physically placed as WIP. Blocks (422) when the
    source doesn't hold enough.
    """
    node_id = line.source_location_node_id
    if node_id is None:
        raise ValidationError(
            f"Line {line.line_no} needs a source location", code="source_required"
        )
    if cell_allocation_ids:
        # LN2: the operator chose exact vials, so consume precisely those rows
        # rather than walking FIFO. Quantity is a consequence of the selection.
        if qty != len(cell_allocation_ids):
            raise ValidationError(
                f"Line {line.line_no}: {len(cell_allocation_ids)} cells selected but "
                f"{qty} issued — for a box the quantity is the number of cells.",
                code="cell_count_mismatch",
            )
        wanted = [_parse_uuid_or_422(c, field="cell_allocation_ids") for c in cell_allocation_ids]
        allocs = await kit_repo.allocations_by_ids(db, wanted)
        found = {a.id for a in allocs}
        if len(allocs) != len(set(wanted)) or any(a.location_node_id != node_id for a in allocs):
            raise ValidationError(
                f"Line {line.line_no}: one or more selected cells are no longer "
                f"available at that location.",
                code="invalid_cell",
            )
        missing = [str(w) for w in wanted if w not in found]
        if missing:
            raise ValidationError(
                f"Line {line.line_no}: cell no longer available ({missing[0]}).",
                code="invalid_cell",
            )
    else:
        allocs = await kit_repo.allocations_for_item_at_node(db, line.item_id, node_id)
        available = sum(int(a.qty) for a in allocs)
        if qty > available:
            raise ValidationError(
                f"Line {line.line_no}: only {available} available at the source location "
                f"(tried to issue {qty}).",
                code="insufficient_source_stock",
            )
    prod_node = kit.production_location_node_id
    remaining = qty
    taken: dict[uuid.UUID, int] = {}
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        taken[alloc.lot_id] = taken.get(alloc.lot_id, 0) + take
        remaining -= take

    # One allocation and ONE ledger row per LOT — never per source allocation.
    # A cryobox holds a separate allocation per cell, so pulling three vials of
    # the same lot would otherwise post three rows of −1 for what is a single
    # transaction. Distinct lots still get their own rows: the ledger groups by
    # lot, and merging them would misstate which lot moved.
    for lot_id, moved in taken.items():
        # Merge into the lot's existing WIP row on the production floor rather
        # than opening a second row for the same lot (bulk placement).
        await loc_repo.create_or_merge_allocation(
            db,
            lot_id=lot_id,
            location_node_id=prod_node,
            qty=moved,
            created_by_user_id=current.id,
        )
        await kit_repo.create_kit_movement(
            db,
            kit_id=kit.id,
            kit_line_id=line.id,
            item_id=line.item_id,
            movement_type=movement_type,
            qty_delta=-moved,
            from_location_node_id=node_id,
            to_location_node_id=prod_node,
            performed_by_user_id=current.id,
            reauth_evidence_id=None,
            notes=note,
            lot_id=lot_id,
        )


async def _drain_production(db, *, kit: Kit, line: KitLine, qty: int) -> None:
    """Remove ``qty`` from the production node's allocations, FIFO. **Writes no
    stock movement** — the material already left ``v_item_stock`` at issue, so
    consuming it is a zero-delta event (§5). This only clears the WIP placement."""
    if qty <= 0:
        return
    allocs = await kit_repo.allocations_for_item_at_node(
        db, line.item_id, kit.production_location_node_id
    )
    remaining = qty
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        remaining -= take
    if remaining > 0:
        raise ValidationError(
            f"Line {line.line_no}: the production floor holds {qty - remaining} of the "
            f"{qty} recorded — cannot reconcile.",
            code="insufficient_wip",
        )


async def _return_to_inventory(
    db,
    *,
    kit: Kit,
    line: KitLine,
    qty: int,
    to_node: uuid.UUID,
    evidence: uuid.UUID | None,
    note: str,
    current,
    return_cells: list | None = None,
    movement_type: str = "backflush",
) -> None:
    """Hand ``qty`` back from the production floor to a storage node as an
    explicit return movement (TRX-003 — never a plain receipt).

    ``movement_type`` distinguishes the three return events, which are
    physically identical but mean different things (kitting05):

      * ``backflush``          the signed close-out reconciliation (TRX-003)
      * ``kit_return``         excess handed back mid-production (TRX-008)
      * ``kit_cancel_return``  the kit was abandoned and everything came back

    The material returns **on its original lot**: the allocation is *moved*
    back, not re-minted, so the lot's expiry and every other attribute survive
    the round trip. Re-minting lost the expiry date, which broke expiry
    alerting on returned stock (client, 2026-07-21).

    This satisfies REQ-2026-07-01-TRX-008: nothing is stranded, because the lot
    is the material's own incoming lot — always live, always ours. TRX-008
    forbids binding material to a *production* lot and never requires the
    operator to assign one; it does not require discarding the incoming lot.
    """
    prod_node = kit.production_location_node_id
    allocs = await kit_repo.allocations_for_item_at_node(db, line.item_id, prod_node)
    on_floor = sum(int(a.qty) for a in allocs)
    if qty > on_floor:
        raise ValidationError(
            f"Line {line.line_no}: only {on_floor} on the production floor "
            f"(tried to return {qty}).",
            code="return_exceeds_on_floor",
        )
    pending_cells = list(return_cells or [])
    is_grid_target = bool(pending_cells)
    remaining = qty
    returned: dict[uuid.UUID, int] = {}
    for alloc in allocs:
        if remaining <= 0:
            break
        take = min(remaining, int(alloc.qty))
        await loc_repo.reduce_allocation(db, allocation=alloc, qty=take)
        if is_grid_target:
            # Grid target: one allocation per cell, one unit each — cells are
            # single-occupancy so they cannot be merged.
            for _ in range(take):
                cell = pending_cells.pop(0)
                await loc_repo.create_allocation(
                    db,
                    lot_id=alloc.lot_id,
                    location_node_id=to_node,
                    qty=1,
                    grid_row=cell.grid_row,
                    grid_col=cell.grid_col,
                    created_by_user_id=current.id,
                )
        returned[alloc.lot_id] = returned.get(alloc.lot_id, 0) + take
        remaining -= take

    # Placement may need a row per cell, but the LEDGER records one row per lot
    # per transaction — the cell is a placement detail, and the movement names
    # the box (D4). Returning three vials of one lot is one back-flush row.
    for lot_id, moved in returned.items():
        if not is_grid_target:
            # Back-flush to a shelf: add to the lot's existing row there instead
            # of opening a second row for the same (item, lot).
            await loc_repo.create_or_merge_allocation(
                db,
                lot_id=lot_id,
                location_node_id=to_node,
                qty=moved,
                created_by_user_id=current.id,
            )
        await kit_repo.create_kit_movement(
            db,
            kit_id=kit.id,
            kit_line_id=line.id,
            item_id=line.item_id,
            movement_type=movement_type,
            qty_delta=moved,
            from_location_node_id=prod_node,
            to_location_node_id=to_node,
            performed_by_user_id=current.id,
            reauth_evidence_id=evidence,
            notes=note,
            lot_id=lot_id,
        )


async def _require_placeable(db, node_id: uuid.UUID, field: str):
    """A node stock can be placed into: a bulk storage leaf, or a grid-bearing
    box (LN2) — the latter only alongside an explicit free-cell selection,
    which :func:`_validate_return_cells` enforces."""
    node = await loc_repo.get_node(db, node_id)
    if node is None:
        raise NotFoundError(f"{field} not found", code="location_not_found")
    if node.node_type not in _PLACEABLE_NODE_TYPES and node.grid_rows is None:
        raise ValidationError(
            f"{field} must be a warehouse shelf, freezer sub-location, or an LN2 box "
            f"(not a {node.node_type}).",
            code="node_not_placeable",
        )
    return node


async def _validate_return_cells(db, node, qty: int, cells: list, field: str) -> None:
    """A return into a box needs one free cell per unit (cells hold exactly one).
    Bulk nodes take no cells at all."""
    is_grid = node.grid_rows is not None
    if not is_grid:
        if cells:
            raise ValidationError(
                f"{field} is not a grid location, so it takes a quantity, not cells.",
                code="cells_not_applicable",
            )
        return
    if len(cells) != qty:
        raise ValidationError(
            f"{field}: pick exactly {qty} free cell(s) — a box cell holds one unit "
            f"({len(cells)} selected).",
            code="cell_count_mismatch",
        )
    rows, cols = int(node.grid_rows), int(node.grid_cols or 1)
    seen: set[tuple[int, int]] = set()
    for c in cells:
        pos = (c.grid_row, c.grid_col)
        if not (1 <= c.grid_row <= rows and 1 <= c.grid_col <= cols):
            raise ValidationError(
                f"{field}: cell {c.grid_row}×{c.grid_col} is outside this box " f"({rows}×{cols}).",
                code="cell_out_of_range",
            )
        if pos in seen:
            raise ValidationError(
                f"{field}: cell {c.grid_row}×{c.grid_col} selected twice.",
                code="cell_duplicated",
            )
        seen.add(pos)
    taken = await kit_repo.occupied_cells(db, node.id)
    clash = seen & taken
    if clash:
        row, col = sorted(clash)[0]
        raise ValidationError(
            f"{field}: cell {row}×{col} is already occupied — pick another, or "
            f"choose a different box.",
            code="cell_occupied",
        )


async def _place(
    db,
    *,
    kit: Kit,
    item_id: uuid.UUID,
    node_id: uuid.UUID,
    qty: int,
    movement_type: str,
    kit_line_id: uuid.UUID | None,
    evidence: uuid.UUID,
    note: str,
    current,
    expiration_date: date | None = None,
) -> None:
    """Place ``qty`` of an item into a node — create a lot + allocation and write
    the unit-IN movement. Used for the production output at close-out: the AY/FG
    was genuinely just manufactured, so a new lot is correct here (unlike a
    return, which moves the material's own lot back).

    ``expiration_date`` carries the produced item's shelf life
    (REQ-2026-07-01-INV-008); without it the lot lands with a NULL expiry and
    never fires expiry alerting.
    """
    lot = await inv_repo.create_lot(
        db,
        item_id=item_id,
        # The produced lot IS the kit/batch — the operator names it once, when
        # opening the kit, and that name carries the traveler's batch number
        # through to inventory. Lot numbers are unique per item and kit names
        # are globally unique, so this can never collide.
        lot_number=kit.kit_number,
        created_by_user_id=current.id,
        expiration_date=expiration_date,
    )
    await loc_repo.create_or_merge_allocation(
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
    node_labels = await loc_repo.node_label_map(db) if rows else {}

    def _label(node_id: uuid.UUID | None) -> str | None:
        if node_id is None:
            return None
        lbl = node_labels.get(node_id)
        return (lbl[1] or lbl[0]) if lbl else None

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
                production_location=_label(k.production_location_node_id),
                output_location=_label(k.output_location_node_id),
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
    "/next-number",
    response_model=KitNumberSuggestion,
    summary="A free KIT-#### to pre-fill the New-kit name field",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def next_kit_number(db: DBSession) -> KitNumberSuggestion:
    # Declared BEFORE /{kit_id} so "next-number" isn't captured as a kit id.
    return KitNumberSuggestion(kit_number=await kit_repo.suggest_kit_number(db))


@kits_router.get(
    "/floor/{node_id}",
    response_model=FloorKitsResponse,
    summary="Open kits building on a production floor, with their on-floor material",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def floor_kits(db: DBSession, node_id: Annotated[uuid.UUID, Path()]) -> FloorKitsResponse:
    """Powers the Production view — attributes the WIP on a floor to the kit it
    belongs to (a floor holds material from every kit issued to it)."""
    active_kits = await kit_repo.kits_on_floor(db, node_id)
    done_kits = await kit_repo.kits_completed_on_floor(db, node_id)
    item_ids = {k.item_id for k in (*active_kits, *done_kits)} | {
        ln.item_id for k in (*active_kits, *done_kits) for ln in k.lines
    }
    items = await kit_repo.load_item_map(db, item_ids)

    def _num(iid: uuid.UUID) -> tuple[str, str]:
        it = items.get(iid)
        return (it.item_number, it.description) if it else ("", "")

    active: list[FloorKit] = []
    for k in active_kits:
        lines = [
            FloorKitLine(
                item_id=str(ln.item_id),
                item_number=_num(ln.item_id)[0],
                description=_num(ln.item_id)[1],
                on_floor_qty=_on_floor(ln),
            )
            for ln in sorted(k.lines, key=lambda x: x.line_no)
            if _on_floor(ln) > 0
        ]
        if not lines:
            continue  # nothing physically on this floor for the kit
        active.append(
            FloorKit(
                id=str(k.id),
                kit_number=k.kit_number,
                item_id=str(k.item_id),
                item_number=_num(k.item_id)[0],
                description=_num(k.item_id)[1],
                target_qty=k.target_qty,
                status=k.status,  # type: ignore[arg-type]
                on_floor_total=sum(ln.on_floor_qty for ln in lines),
                lines=lines,
            )
        )

    completed: list[FloorKitConsumed] = []
    for k in done_kits:
        c_lines = [
            FloorKitConsumedLine(
                item_id=str(ln.item_id),
                item_number=_num(ln.item_id)[0],
                description=_num(ln.item_id)[1],
                used_qty=ln.used_qty or 0,
            )
            for ln in sorted(k.lines, key=lambda x: x.line_no)
            if (ln.used_qty or 0) > 0
        ]
        completed.append(
            FloorKitConsumed(
                id=str(k.id),
                kit_number=k.kit_number,
                item_id=str(k.item_id),
                item_number=_num(k.item_id)[0],
                description=_num(k.item_id)[1],
                target_qty=k.target_qty,
                good_qty=k.good_qty,
                scrap_qty=k.scrap_qty,
                closed_at=k.closed_at,
                consumed_total=sum(ln.used_qty for ln in c_lines),
                lines=c_lines,
            )
        )

    return FloorKitsResponse(active=active, completed=completed)


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
    events = await kit_repo.kit_audit_events(db, kit_id)
    # Resolve the output-location node id carried on close-out events to a
    # human path (Warehouse One › Shelf Y) for the activity timeline.
    node_labels = await loc_repo.node_label_map(db) if events else {}
    return KitActivityResponse(
        items=[_activity_row(m, items) for m in movements],
        events=[_audit_event_row(e, node_labels) for e in events],
    )


def _audit_event_row(e, node_labels: dict | None = None) -> KitAuditEventRow:
    ctx = e.context or {}
    after = e.after_state or {}
    good = ctx.get("good_qty")
    good = after.get("good_qty") if good is None else good
    scrap = ctx.get("scrap_qty")
    scrap = after.get("scrap_qty") if scrap is None else scrap
    out_node = ctx.get("output_location_node_id") or after.get("output_location_node_id")
    out_label: str | None = None
    if out_node and node_labels:
        try:
            key = uuid.UUID(str(out_node))
        except (ValueError, TypeError):
            key = None
        label = node_labels.get(key) if key is not None else None
        if label:
            # node_label_map yields (name, path); prefer the fuller path.
            out_label = label[1] or label[0]
    return KitAuditEventRow(
        id=str(e.id),
        occurred_at=e.occurred_at,
        operation=str(ctx.get("operation") or e.action),
        action=e.action,
        actor_user_id=str(e.actor_user_id) if e.actor_user_id else None,
        good_qty=good,
        scrap_qty=scrap,
        output_location=out_label,
        output_expiration_date=ctx.get("output_expiration_date"),
        diff=e.diff,
    )


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
    # Transaction_Spec §2: material is moved to a production/manufacturing
    # location at kitting, so a kit's production node must be one — a warehouse
    # shelf is not a production floor.
    if not await kit_repo.production_node_exists(db, prod_node):
        raise ValidationError(
            "Production location must be an active production or lab floor "
            "(e.g. Clean Room 1, PD Lab One)",
            code="not_a_production_location",
        )

    children = await kit_repo.list_bom_children(db, item_id)
    if not children:
        raise ValidationError(
            "This item has no bill of materials, so it can't be kitted",
            code="item_has_no_bom",
        )
    # Every composition rule in Transaction_Spec §1.1 is two-input
    # (CR+CR→AY, AY+AY→AY, CR+AY→FG), so a single-component "recipe" is an
    # unfinished BOM rather than something you gather a kit for. Enforced here
    # as well as in the picker, so the rule holds for any client.
    if len(children) < _MIN_BOM_LINES:
        raise ValidationError(
            f"A kit needs at least {_MIN_BOM_LINES} components in its bill of "
            f"materials — this item has {len(children)}.",
            code="item_bom_too_small",
        )

    kit_number = payload.kit_number.strip()
    if not kit_number:
        raise ValidationError("Kit name is required", code="kit_number_required")
    if await kit_repo.kit_number_taken(db, kit_number):
        raise ConflictError(
            f'The kit name "{kit_number}" is already in use.',
            code="kit_number_conflict",
        )
    kit = await kit_repo.create_kit(
        db,
        kit_number=kit_number,
        item_id=item_id,
        target_qty=payload.target_qty,
        production_location_node_id=prod_node,
        notes=payload.notes,
        created_by_user_id=current.id,
    )
    # No default source. Guessing "the first active shelf" was wrong more often
    # than right — it frequently doesn't stock the component at all — and a
    # pre-filled location reads as a decision someone made. The operator picks
    # per line from the locations that actually hold the item.
    for line_no, bom in enumerate(children, start=1):
        await kit_repo.add_kit_line(
            db,
            kit_id=kit.id,
            line_no=line_no,
            item_id=bom.child_item_id,
            qty_per_unit=bom.qty_per_unit,
            issued_qty=kit_repo.default_issued_qty(bom.qty_per_unit, payload.target_qty),
            source_location_node_id=None,
        )

    refreshed = await _require_kit(db, kit.id)
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=None,
        after=_kit_snapshot(refreshed),
        context={"operation": "create"},
    )
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


# ── Edit kit (name / target) ─────────────────────────────────────────────


@kits_router.patch(
    "/{kit_id}",
    response_model=KitRead,
    summary="Edit a kit's name and/or target (name while open, target while draft)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def update_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: KitUpdateRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    before = _kit_snapshot(kit)

    if payload.kit_number is not None:
        # The name doubles as the produced lot number, so it may change while the
        # kit is still open but not once it is closed / cancelled (the record and
        # its lot are then final).
        if kit.status in ("closed", "cancelled"):
            raise ValidationError("A closed or cancelled kit cannot be renamed", code="kit_locked")
        new_name = payload.kit_number.strip()
        if not new_name:
            raise ValidationError("Kit name is required", code="kit_number_required")
        if new_name != kit.kit_number and await kit_repo.kit_number_taken(db, new_name):
            raise ConflictError(
                f'The kit name "{new_name}" is already in use.', code="kit_number_conflict"
            )
        kit.kit_number = new_name

    if payload.target_qty is not None and payload.target_qty != kit.target_qty:
        # Target drives every line's needed quantity, so it is only editable
        # before anything is issued (draft). Re-default each line's issued qty to
        # the new need so the Issue step stays pre-filled sensibly.
        if kit.status != "draft":
            raise ValidationError(
                "Target can only be changed while the kit is a draft (before issue)",
                code="target_locked",
            )
        kit.target_qty = payload.target_qty
        for line in kit.lines:
            line.issued_qty = kit_repo.default_issued_qty(line.qty_per_unit, payload.target_qty)

    kit.updated_by_user_id = current.id
    await db.flush()
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "edit_kit"},
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
    current: CurrentDbUserDep,
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

    before = _kit_snapshot(kit)
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
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "edit_line", "line_no": line.line_no},
    )
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

    before = _kit_snapshot(kit)

    # The draft edits (issued qty + source per line) are committed here, so the
    # Issue button is the only write — nothing is persisted while the user types.
    cells_by_line: dict[uuid.UUID, list[str]] = {}
    if payload and payload.lines:
        lines_by_id = {ln.id: ln for ln in kit.lines}
        for line_in in payload.lines:
            cells_by_line[_parse_uuid_or_422(line_in.line_id, field="line_id")] = (
                line_in.cell_allocation_ids
            )
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

    # Hard issue gate (client 2026-07-22). A kit may only be issued when EVERY
    # line is fully covered: issued ≥ the BOM need, and the source physically
    # holds at least the need. This is stricter than ``Transaction_Spec`` §2
    # (which leaves "quantity issued" a free manual entry) but consistent with
    # it — §2 defines "needed" as the build requirement and every worked example
    # issues ≥ needed. No partial / short issue: one short component blocks the
    # whole kit. Runs as a pre-flight over all lines BEFORE any material moves,
    # so nothing is issued when the kit can't be fully covered.
    for line in kit.lines:
        needed = _needed(line, kit.target_qty)
        if line.issued_qty < needed:
            raise ValidationError(
                f"Line {line.line_no}: issued {line.issued_qty} is below the {needed} "
                f"needed to build {kit.target_qty}. Issue at least the needed quantity "
                f"— a short kit can't be issued.",
                code="issued_below_need",
            )
        node_id = line.source_location_node_id
        if node_id is None:
            raise ValidationError(
                f"Line {line.line_no} needs a source location before issue",
                code="source_required",
            )
        allocs = await kit_repo.allocations_for_item_at_node(db, line.item_id, node_id)
        available = sum(int(a.qty) for a in allocs)
        if available < needed:
            raise ValidationError(
                f"Line {line.line_no}: the source location holds only {available}, but "
                f"{needed} are needed to build {kit.target_qty}. Restock before issuing "
                f"— you cannot move forward with a short kit.",
                code="source_below_need",
            )

    for line in kit.lines:
        if line.issued_qty <= 0:
            continue
        await _move_to_production(
            db,
            kit=kit,
            line=line,
            qty=line.issued_qty,
            movement_type="kit_issue",
            note=f"Issued {line.issued_qty} to production for {kit.kit_number}",
            current=current,
            cell_allocation_ids=cells_by_line.get(line.id),
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
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "issue"},
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

    before = _kit_snapshot(kit)
    await _move_to_production(
        db,
        kit=kit,
        line=line,
        qty=payload.qty,
        movement_type="kit_additional_issue",
        note=f"Additional {payload.qty} issued for {kit.kit_number}",
        current=current,
        cell_allocation_ids=payload.cell_allocation_ids,
    )
    line.additional_issued_qty += payload.qty
    kit.updated_by_user_id = current.id
    await db.flush()
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "additional_issue", "line_no": line.line_no, "qty": payload.qty},
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


@kits_router.post(
    "/{kit_id}/lines/{line_id}/return",
    response_model=KitRead,
    summary="Return excess material from the floor back into inventory (TRX-008)",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def return_excess(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    line_id: Annotated[uuid.UUID, Path()],
    payload: ReturnExcessRequest,
) -> KitRead:
    """REQ-2026-07-01-TRX-008 — the admin/manual "15 pulled, 3 returned" action.
    Returns stock on a fresh unassigned lot so it can never be stranded.
    Unsigned, matching issue / additional issue (only close-out is e-signed)."""
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Material can only be returned while the kit is in production",
            code="kit_not_in_production",
        )
    line = next((ln for ln in kit.lines if ln.id == line_id), None)
    if line is None:
        raise NotFoundError(f"Line {line_id} not on kit {kit_id}", code="line_not_found")

    on_floor = _on_floor(line)
    if payload.qty > on_floor:
        raise ValidationError(
            f"Line {line.line_no}: only {on_floor} on the production floor "
            f"(tried to return {payload.qty}).",
            code="return_exceeds_on_floor",
        )
    # Client-directed cap (2026-07-22): you may only hand back the SURPLUS above
    # what's needed — the floor can never drop below the build requirement, or
    # there wouldn't be enough left to make the units. Returning down to zero was
    # the bug. "needed" is dynamic via _effective_target.
    needed_units = _needed_units(line, kit)
    max_return = on_floor - needed_units
    if payload.qty > max_return:
        raise ValidationError(
            f"Line {line.line_no}: at most {max(max_return, 0)} can be returned — {needed_units} "
            f"must stay on the floor to build {_effective_target(kit)}. Return the surplus above "
            f"what's needed, not below it.",
            code="return_below_need",
        )
    to_node = _parse_uuid_or_422(payload.return_location_node_id, field="return_location_node_id")
    node = await _require_placeable(db, to_node, "Return location")
    await _validate_return_cells(db, node, payload.qty, payload.return_cells, "Return location")

    before = _kit_snapshot(kit)
    note = f"Returned {payload.qty} to inventory from {kit.kit_number}"
    if payload.reason:
        note = f"{note} — {payload.reason}"
    await _return_to_inventory(
        db,
        kit=kit,
        line=line,
        qty=payload.qty,
        to_node=to_node,
        evidence=None,
        note=note,
        current=current,
        return_cells=payload.return_cells,
        movement_type="kit_return",
    )
    line.early_returned_qty += payload.qty
    line.return_location_node_id = to_node
    kit.updated_by_user_id = current.id
    await db.flush()
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=before,
        after=_kit_snapshot(kit),
        context={
            "operation": "early_return",
            "line_no": line.line_no,
            "qty": payload.qty,
            "reason": payload.reason,
        },
    )
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
    before = _kit_snapshot(kit)
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
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.kits",
        subject_id=kit.id,
        subject_label=kit.kit_number,
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "production_draft"},
    )
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
    before = _kit_snapshot(kit)
    # Good units can never be zero — a kit must yield at least one good unit to
    # close out (client 2026-07-22, Task 3). Scrap alone is not a valid close.
    if payload.good_qty < 1:
        raise ValidationError(
            "A kit must produce at least 1 good unit to close out",
            code="good_required",
        )
    # A produced lot can't already be expired (client 2026-07-22) — expiry, when
    # given, must be today or later.
    if payload.output_expiration_date and payload.output_expiration_date < _now().date():
        raise ValidationError(
            "The produced lot's expiry can't be in the past",
            code="expiry_in_past",
        )

    # ── Client-directed yield gate (2026-07-22) ─────────────────────────────
    # BEYOND ``Transaction_Spec``: the spec reconciles close-out on the actual
    # *Qty Used* per line (§3 / Table 3) and never recomputes "needed". The
    # client asked to ALSO refuse close-out unless the material issued could
    # physically have produced the claimed output — i.e. issued+additional ≥
    # (good+scrap) × qty_per_unit for every line. Isolated here with its own
    # error code so it can be relaxed if the client reverts to the pure
    # Qty-Used model. The existing ``used ≤ on_floor`` guard below is unchanged.
    attempted = payload.good_qty + payload.scrap_qty
    for line in kit.lines:
        yield_need = line.qty_per_unit * attempted
        total_issued = line.issued_qty + line.additional_issued_qty
        if total_issued < yield_need:
            raise ValidationError(
                f"Line {line.line_no}: {total_issued} issued, but producing "
                f"{payload.good_qty} good + {payload.scrap_qty} scrap needs {yield_need} "
                f"per the BOM. Record an additional issue before closing out.",
                code="issued_below_yield",
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
    # The cap is what is still ON THE FLOOR — net of anything already returned
    # under TRX-008 — not the raw issued total.
    for line_in in payload.lines:
        lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        line = lines_by_id[lid]
        on_floor = _on_floor(line)
        if line_in.used_qty > on_floor:
            raise ValidationError(
                f"Line {line.line_no}: used {line_in.used_qty} exceeds the {on_floor} "
                f"still on the production floor. Record an additional issue to cover it.",
                code="used_exceeds_issued",
            )
        # Client-directed lower bound (2026-07-22, Task 5.1): you can't have
        # consumed LESS than the BOM requires for the output you claim — that
        # much material is what makes the good+scrap units. Uses the close-out
        # payload's attempted total (good+scrap), not the possibly-stale kit row.
        # BEYOND Transaction_Spec, which reconciles on Qty Used without a floor.
        need = kit_repo.default_issued_qty(line.qty_per_unit, attempted)
        if line_in.used_qty < need:
            raise ValidationError(
                f"Line {line.line_no}: used {line_in.used_qty} is below the {need} needed to "
                f"produce {payload.good_qty} good + {payload.scrap_qty} scrap. That much material "
                f"is required to make the output.",
                code="used_below_need",
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
            evidence=evidence_uuid,
            note=f"{payload.good_qty} produced and stocked for {kit.kit_number}",
            current=current,
            expiration_date=payload.output_expiration_date,
        )

    # 2. Drain the production floor. `used` is consumed with no movement (it
    #    already left v_item_stock at issue, §5); the leftover back-flushes to
    #    the return node (REQ-2026-07-09-TRX-003) on a fresh unassigned lot.
    #    used + leftover == on_floor, so the kit's WIP always reaches zero.
    cells_by_line = {
        _parse_uuid_or_422(li.line_id, field="line_id"): li.return_cells for li in payload.lines
    }
    for line in kit.lines:
        await _drain_production(db, kit=kit, line=line, qty=line.used_qty or 0)
        returned = _line_returned(line) or 0
        if returned <= 0:
            continue
        ret_node = line.return_location_node_id or line.source_location_node_id
        if ret_node is None:
            raise ValidationError(
                f"Line {line.line_no} has nowhere to back-flush to", code="return_required"
            )
        node = await _require_placeable(db, ret_node, "Return location")
        ret_cells = cells_by_line.get(line.id, [])
        await _validate_return_cells(db, node, returned, ret_cells, "Return location")
        await _return_to_inventory(
            db,
            kit=kit,
            line=line,
            qty=returned,
            to_node=ret_node,
            evidence=evidence_uuid,
            return_cells=ret_cells,
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
        before=before,
        after=_kit_snapshot(kit),
        context={
            "operation": "close_out",
            "good_qty": payload.good_qty,
            "scrap_qty": payload.scrap_qty,
            "output_location_node_id": str(output_node),
            "output_expiration_date": (
                payload.output_expiration_date.isoformat()
                if payload.output_expiration_date
                else None
            ),
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
    summary="Cancel an open kit — draft (no movements) or in-production (returns everything). E-signed.",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def cancel_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: CancelRequest,
) -> KitRead:
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("draft", "issued", "in_production"):
        raise ValidationError(
            "Only an open kit can be cancelled",
            code="cancel_not_open",
        )
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    before = _kit_snapshot(kit)
    # Post-issue cancel (resolves the deferred §99.8): hand every unit still on
    # the floor back to inventory. Safe by construction — nothing was bound to a
    # production lot at kitting (TRX-002), so nothing can be stranded, and the
    # return carries no lot assignment (TRX-008). A draft has moved nothing, so
    # it writes no movements at all.
    if kit.status != "draft":
        # Per-line destinations (D1). When supplied they must cover every line
        # still holding material, so the dialog can't silently drop a component.
        by_line = {
            _parse_uuid_or_422(li.line_id, field="line_id"): li for li in payload.lines
        }
        if by_line:
            missing = [ln.line_no for ln in kit.lines if _on_floor(ln) > 0 and ln.id not in by_line]
            if missing:
                raise ValidationError(
                    f"Every line still holding material needs a return location "
                    f"(missing: {missing}).",
                    code="cancel_lines_missing",
                )
        for line in kit.lines:
            on_floor = _on_floor(line)
            if on_floor <= 0:
                continue
            line_in = by_line.get(line.id)
            if line_in is not None:
                ret_node = _parse_uuid_or_422(
                    line_in.return_location_node_id, field="return_location_node_id"
                )
                cells = line_in.return_cells
            else:
                ret_node = line.return_location_node_id or line.source_location_node_id
                cells = []
            if ret_node is None:
                raise ValidationError(
                    f"Line {line.line_no} has nowhere to return to",
                    code="return_required",
                )
            node = await _require_placeable(db, ret_node, "Return location")
            await _validate_return_cells(db, node, on_floor, cells, "Return location")
            await _return_to_inventory(
                db,
                kit=kit,
                line=line,
                qty=on_floor,
                to_node=ret_node,
                evidence=None,
                note=f"{kit.kit_number} cancelled — {on_floor} returned to inventory",
                current=current,
                return_cells=cells,
                movement_type="kit_cancel_return",
            )
            line.early_returned_qty += on_floor
            line.return_location_node_id = ret_node
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
        before=before,
        after=_kit_snapshot(kit),
        context={"operation": "cancel", "reason": payload.reason or None},
        signature_id=evidence_uuid,
    )
    # Consume the evidence last so a replay rolls back the whole cancel.
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=CANCEL_ACTION,
        target_table="app.kits",
        target_id=kit.id,
    )
    refreshed = await _require_kit(db, kit.id)
    response = await _kit_read(db, refreshed)
    await db.commit()
    return response


def _now() -> datetime:
    return datetime.now(UTC)
