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
from app.core.search import MAX_SEARCH_LENGTH
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
    FloorKitBatch,
    FloorKitCancelled,
    FloorKitConsumed,
    FloorKitConsumedLine,
    FloorKitCounts,
    FloorKitLine,
    FloorKitsResponse,
    FloorSection,
    IssueRequest,
    IssueSourceInput,
    ItemKitAuditEventRow,
    ItemKitAuditResponse,
    ItemKitConsumptionResponse,
    ItemKitConsumptionRow,
    KitActivityResponse,
    KitActivityRow,
    KitAuditEventRow,
    KitConsumedLine,
    KitCreateRequest,
    KitLineFloorLot,
    KitLineIssuedFrom,
    KitLineRead,
    KitLineSourceLot,
    KitLineSourceOption,
    KitLineUpdateRequest,
    KitListItem,
    KitListResponse,
    KitNumberSuggestion,
    KitRead,
    KitUpdateRequest,
    ProduceRequest,
    ProductionDraftRequest,
    ReturnExcessRequest,
)

kits_router = APIRouter(prefix="/kits", tags=["kitting"])

# Where a kit's output / back-flush lands — free storage leaves only (no box
# cell placement in v1).
_PLACEABLE_NODE_TYPES = ("shelf", "sub_location")

# The reauth action verb minted by the frontend before close-out.
CLOSEOUT_ACTION = "kit.closeout"
PRODUCE_ACTION = "kit.produce"
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
    ``issued + additional − early_returned − used``.

    ``used_qty`` is cumulative across produce batches (KIT-007 incremental /
    serialized production): each ``produce`` consumes material, so the floor
    shrinks and the next batch (or close-out back-flush) sees only what remains.
    For a one-shot close (``used_qty`` starts null → 0) this is the classic
    ``issued + additional − early_returned``, so existing behaviour is unchanged.
    """
    return (
        line.issued_qty
        + line.additional_issued_qty
        - line.early_returned_qty
        - (line.used_qty or 0)
    )


def _needed(line: KitLine, target_qty: int) -> Decimal:
    """The BOM requirement for the whole build — ``qty_per_unit × target_qty``
    (``Transaction_Spec`` §2, "quantity needed is derived from the BOM"). Not
    stored; recomputed wherever it gates a step."""
    return line.qty_per_unit * target_qty


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
    """The close-out back-flush amount — whatever is still on the floor once the
    consumed material is accounted for (null until any production is recorded).
    ``_on_floor`` already subtracts cumulative ``used_qty``, so this is simply the
    remaining floor."""
    if line.used_qty is None:
        return None
    return _on_floor(line)


def _line_read(
    line: KitLine,
    target_qty: int,
    items: dict[uuid.UUID, Item],
    stock_by_node: dict[uuid.UUID, dict[uuid.UUID, int]],
    node_labels: dict[uuid.UUID, tuple[str, str]],
    cells_by_node: dict[uuid.UUID, dict[uuid.UUID, list]] | None = None,
    grid_meta: dict[uuid.UUID, tuple[int, int]] | None = None,
    lots_by_item: dict[uuid.UUID, list] | None = None,
    issued_breakdown: dict[uuid.UUID, list] | None = None,
    floor_lots: dict[uuid.UUID, list] | None = None,
) -> KitLineRead:
    item = items.get(line.item_id)
    per_node = stock_by_node.get(line.item_id, {})
    line_cells = (cells_by_node or {}).get(line.item_id, {})
    grid_meta = grid_meta or {}

    def _node_path(node_id: uuid.UUID | None) -> str:
        if node_id is None:
            return ""
        name, path = node_labels.get(node_id, ("", ""))
        return path or name

    issued_from = [
        KitLineIssuedFrom(lot_number=lot_number, location=_node_path(node_id), qty=qty)
        for lot_number, node_id, qty in (issued_breakdown or {}).get(line.id, [])
    ]

    def _lot_cells(node_id: uuid.UUID, lot_id: uuid.UUID) -> list[CellOption]:
        """The occupied cells of one lot in one box — so the picker can offer the
        exact vials of that lot (D2)."""
        return [
            CellOption(
                allocation_id=str(a.id),
                grid_row=int(a.grid_row),
                grid_col=int(a.grid_col),
                lot_id=str(a.lot_id),
                lot_number=getattr(getattr(a, "lot", None), "lot_number", None),
                expiration_date=getattr(getattr(a, "lot", None), "expiration_date", None),
            )
            for a in line_cells.get(node_id, [])
            if a.lot_id == lot_id
        ]

    source_lots: list[KitLineSourceLot] = []
    for lot_id, lot_number, exp, node_id, qty in (lots_by_item or {}).get(line.item_id, []):
        name, path = node_labels.get(node_id, ("", ""))
        rows_cols = grid_meta.get(node_id)
        is_grid = rows_cols is not None
        source_lots.append(
            KitLineSourceLot(
                lot_id=str(lot_id),
                lot_number=lot_number,
                expiration_date=exp,
                node_id=str(node_id),
                node_name=name,
                path=path,
                qty=qty,
                is_grid=is_grid,
                grid_rows=rows_cols[0] if rows_cols else None,
                grid_cols=rows_cols[1] if rows_cols else None,
                cells=_lot_cells(node_id, lot_id) if is_grid else [],
            )
        )

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
        source_lots=source_lots,
        issued_from=issued_from,
        on_floor_lots=[
            KitLineFloorLot(lot_id=str(lot_id), lot_number=lot_number, qty=qty)
            for lot_id, lot_number, qty in (floor_lots or {}).get(line.item_id, [])
        ],
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
    # Per-lot rows for the multi-source Issue picker (KIT-002/003).
    lots_by_item = await kit_repo.item_stock_by_node_lot(db, line_item_ids)
    # What each line was ISSUED from (lot × source), for the post-issue snapshot.
    issued_breakdown = await kit_repo.line_issue_breakdown(db, kit.id)
    # Per-lot WIP on this kit's production floor — the pickable RETURN sources
    # (client 2026-07-24); the operator picks which floor lot's units to hand back.
    floor_lots = await kit_repo.floor_lots_by_item_at_node(
        db, kit.production_location_node_id, line_item_ids
    )
    # Labels are needed for both the source picker and the issued-from snapshot,
    # so load them whenever the kit has lines.
    node_labels = await loc_repo.node_label_map(db) if kit.lines else {}
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
                ln,
                kit.target_qty,
                items,
                stock_by_node,
                node_labels,
                cells_by_node,
                grid_meta,
                lots_by_item,
                issued_breakdown,
                floor_lots,
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
    node_id: uuid.UUID | None = None,
    lot_id: uuid.UUID | None = None,
    cell_allocation_ids: list[str] | None = None,
) -> None:
    """Move ``qty`` of a line's component from a source node **to the kit's
    production node** — the relocation ``Transaction_Spec`` §2 requires.

    ``node_id`` selects the source location (defaults to the line's recorded
    source for the legacy single-source path). ``lot_id``, when given, restricts
    the draw to that one lot — the multi-source picker issues one pick per
    (location, lot) so it can split a need across lots FIFO (KIT-003). Without a
    ``lot_id`` the whole node is drained FIFO across its lots (legacy behavior).

    Reduces the source allocation FIFO (by expiry, then age) and re-allocates
    the **same lot** at the production node. Retaining the source lot is not a
    TRX-002 violation: TRX-002 forbids binding material to the production
    *output* lot at kitting time, not carrying its own incoming lot.

    ``qty_delta`` stays negative, so the material leaves *available* stock
    (TRX-001) while remaining physically placed as WIP. Blocks (422) when the
    source doesn't hold enough.
    """
    if node_id is None:
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
        allocs = await kit_repo.allocations_for_item_at_node(
            db, line.item_id, node_id, for_update=True
        )
        if lot_id is not None:
            # Multi-source: this pick draws one specific lot at the node.
            allocs = [a for a in allocs if a.lot_id == lot_id]
        available = sum(int(a.qty) for a in allocs)
        if qty > available:
            where = "that lot at the source location" if lot_id is not None else "the source location"
            raise ValidationError(
                f"Line {line.line_no}: only {available} available at {where} "
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
    for src_lot_id, moved in taken.items():
        # Merge into the lot's existing WIP row on the production floor rather
        # than opening a second row for the same lot (bulk placement).
        await loc_repo.create_or_merge_allocation(
            db,
            lot_id=src_lot_id,
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
            lot_id=src_lot_id,
        )


async def _parse_source_picks(
    db, *, line: KitLine, sources: list[IssueSourceInput]
) -> tuple[list[tuple[uuid.UUID, uuid.UUID | None, int, list[str]]], int, uuid.UUID | None]:
    """Validate a line's multi-source picks and normalize them to moves.

    Returns ``(moves, total_qty, primary_node)`` where each move is
    ``(node_id, lot_id, qty, cells)``. ``qty`` is the cell count for a box pick,
    otherwise the entered quantity. ``primary_node`` (the largest pick) seeds the
    line's source / return default. Per-lot availability is NOT checked here — it
    is enforced as each pick actually moves (``insufficient_source_stock``)."""
    moves: list[tuple[uuid.UUID, uuid.UUID | None, int, list[str]]] = []
    total = 0
    for s in sources:
        node_id = _parse_uuid_or_422(s.node_id, field="node_id")
        if not await kit_repo.storage_node_exists(db, node_id):
            raise NotFoundError("Source location not found", code="source_not_found")
        cells = list(s.cell_allocation_ids)
        lot_id = _parse_uuid_or_422(s.lot_id, field="lot_id") if s.lot_id else None
        eff = len(cells) if cells else s.qty
        if eff <= 0:
            continue
        moves.append((node_id, lot_id, eff, cells))
        total += eff
    primary = max(moves, key=lambda m: m[2])[0] if moves else None
    return moves, total, primary


async def _drain_production(db, *, kit: Kit, line: KitLine, qty: int) -> None:
    """Remove ``qty`` from the production node's allocations, FIFO. **Writes no
    stock movement** — the material already left ``v_item_stock`` at issue, so
    consuming it is a zero-delta event (§5). This only clears the WIP placement."""
    if qty <= 0:
        return
    allocs = await kit_repo.allocations_for_item_at_node(
        db, line.item_id, kit.production_location_node_id, for_update=True
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
    only_lot_id: uuid.UUID | None = None,
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
    allocs = await kit_repo.allocations_for_item_at_node(
        db, line.item_id, prod_node, for_update=True
    )
    # When the operator picked a specific floor lot to return (client 2026-07-24),
    # drain only that lot's WIP; otherwise drain FIFO across every lot on the floor
    # (close-out back-flush / cancel, unchanged).
    if only_lot_id is not None:
        allocs = [a for a in allocs if a.lot_id == only_lot_id]
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


async def _validate_return_cells(
    db,
    node,
    qty: int,
    cells: list,
    field: str,
    claimed: dict[uuid.UUID, set[tuple[int, int]]] | None = None,
) -> None:
    """A return into a box needs one free cell per unit (cells hold exactly one).
    Bulk nodes take no cells at all.

    ``claimed`` accumulates the cells already spoken for EARLIER IN THE SAME
    REQUEST, keyed by node. Without it each line was validated in isolation:
    two components both returning into Box 1.1.3 could each pick A1, since
    neither is in ``occupied_cells`` until something commits. Both passed, and
    the collision surfaced as a unique-violation on
    ``uq_lot_allocations_cell`` — a 500 where the operator needed a sentence
    telling them which cell to change.

    Callers that validate more than one destination MUST pass one dict for the
    whole request. It is mutated here.
    """
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
    # Cells another destination in THIS request already took. Checked before the
    # stored ones because it is the more confusing collision: nothing in the
    # database looks wrong, so "already occupied" would be a lie.
    if claimed is not None:
        conflict = seen & claimed.get(node.id, set())
        if conflict:
            row, col = sorted(conflict)[0]
            raise ValidationError(
                f"{field}: cell {row}×{col} in {node.name} is already taken by "
                "another component in this same request — one cell holds one "
                "unit. Pick a free cell, or send that component to another box.",
                code="cell_taken_in_request",
            )

    taken = await kit_repo.occupied_cells(db, node.id)
    clash = seen & taken
    if clash:
        row, col = sorted(clash)[0]
        raise ValidationError(
            f"{field}: cell {row}×{col} is already occupied — pick another, or "
            f"choose a different box.",
            code="cell_occupied",
        )

    if claimed is not None:
        claimed.setdefault(node.id, set()).update(seen)


async def _resolve_output_destinations(
    db, payload, good: int, claimed: dict[uuid.UUID, set[tuple[int, int]]] | None = None
) -> list[tuple[uuid.UUID, int, list]]:
    """Normalise + validate the produce / close output into placeable
    ``(node, qty, cells)`` destinations.

    Supports SPLITTING a batch across several locations (client 2026-07-23) when
    one box can't hold every unit — the leftover good units go to another box, a
    freezer, or a shelf. ``payload.outputs`` (the multi-destination list) wins;
    otherwise the single ``output_location_node_id`` (+ ``output_cells``) is used
    as one destination for the whole ``good``. Every destination is checked
    placeable, its cells validated, and the quantities must sum to ``good``.
    Returns ``[]`` when nothing is produced (``good == 0`` at close-out)."""
    if good <= 0:
        return []
    if payload.outputs:
        raw = [(o.location_node_id, o.qty, o.cells) for o in payload.outputs]
    elif payload.output_location_node_id is not None:
        raw = [(payload.output_location_node_id, good, payload.output_cells)]
    else:
        raise ValidationError("An output location is required", code="output_required")
    total = sum(qty for _, qty, _ in raw)
    if total != good:
        raise ValidationError(
            f"Output placement must total {good} unit(s) — got {total}.",
            code="output_qty_mismatch",
        )
    seen: set[uuid.UUID] = set()
    dests: list[tuple[uuid.UUID, int, list]] = []
    for node_str, qty, cells in raw:
        node_uuid = _parse_uuid_or_422(node_str, field="output_location_node_id")
        if node_uuid in seen:
            raise ValidationError(
                "Each output location can be used once — combine the quantities.",
                code="output_duplicate_node",
            )
        seen.add(node_uuid)
        node_obj = await _require_placeable(db, node_uuid, "Output location")
        await _validate_return_cells(db, node_obj, qty, cells, "Output location", claimed)
        dests.append((node_uuid, qty, cells))
    return dests


async def _resolve_return_destinations(
    db,
    *,
    destinations: list,
    fallback_node: uuid.UUID | None,
    fallback_cells: list,
    total: int,
    claimed: dict[uuid.UUID, set[tuple[int, int]]] | None = None,
) -> list[tuple[uuid.UUID, int, list]]:
    """Normalise + validate a return into placeable ``(node, qty, cells)`` slices.

    The return counterpart of :func:`_resolve_output_destinations`, and
    deliberately the same shape: material coming back off the floor may be SPLIT
    across several locations (client 2026-07-30) when one box hasn't enough free
    cells for all of it. Before this, a nearly-full box dead-ended the return with
    ``cell_count_mismatch`` and no way forward but choosing an entirely different
    location for every unit.

    ``destinations`` wins when present and must total ``total``; otherwise
    ``fallback_node`` (+ ``fallback_cells``) takes the whole quantity, which is
    the single-location path every caller used before.
    """
    if destinations:
        raw = [(d.location_node_id, d.qty, d.return_cells) for d in destinations]
        placed = sum(qty for _, qty, _ in raw)
        if placed != total:
            raise ValidationError(
                f"Return placement must total {total} unit(s) — got {placed}.",
                code="return_qty_mismatch",
            )
    elif fallback_node is not None:
        raw = [(str(fallback_node), total, fallback_cells)]
    else:
        raise ValidationError("A return location is required", code="return_required")

    seen: set[uuid.UUID] = set()
    out: list[tuple[uuid.UUID, int, list]] = []
    for node_str, qty, cells in raw:
        node_uuid = _parse_uuid_or_422(node_str, field="return_location_node_id")
        if node_uuid in seen:
            raise ValidationError(
                "Each return location can be used once — combine the quantities.",
                code="return_duplicate_node",
            )
        seen.add(node_uuid)
        node_obj = await _require_placeable(db, node_uuid, "Return location")
        await _validate_return_cells(db, node_obj, qty, cells, "Return location", claimed)
        out.append((node_uuid, qty, cells))
    return out


async def _resolve_output_lot_number(db, payload) -> str | None:
    """Validate the operator-entered produced-batch lot number (client 2026-07-24).

    Required + globally unique when the batch makes output (``good_qty >= 1``);
    ``None`` when nothing is produced (a ``good_qty == 0`` close-out mints no lot,
    so no number is needed). Uniqueness is application-level (the DB index is only
    partial-unique per item)."""
    if payload.good_qty < 1:
        return None
    lot_no = (payload.output_lot_number or "").strip()
    if not lot_no:
        raise ValidationError(
            "Enter a lot number for the produced batch.",
            code="output_lot_number_required",
        )
    if await inv_repo.lot_number_exists(db, lot_number=lot_no):
        raise ValidationError(
            f"Lot number {lot_no} is already in use.",
            code="output_lot_number_taken",
        )
    return lot_no


async def _place_units(
    db,
    *,
    kit: Kit,
    lot,
    node_id: uuid.UUID,
    qty: int,
    movement_type: str,
    kit_line_id: uuid.UUID | None,
    evidence: uuid.UUID,
    note: str,
    current,
    cells: list | None = None,
) -> None:
    """Allocate ``qty`` of an EXISTING ``lot`` into a node and write the unit-IN
    movement. The lot is created by the caller so a single batch can be split
    across several destinations (client 2026-07-23) while staying ONE lot.

    ``cells`` places the units into specific vial positions of an LN2 box (KIT-005
    "LN2 tank position") — one allocation per cell, qty 1, so single-occupancy
    holds; ``qty`` must equal ``len(cells)``. Without cells the units land as one
    bulk allocation on a shelf / freezer. Either way the ledger records ONE
    ``production_output`` row per destination (the cell is a placement detail, D4).
    """
    if cells:
        # LN2 box: one allocation per chosen cell (cells are single-occupancy).
        for c in cells:
            await loc_repo.create_allocation(
                db,
                lot_id=lot.id,
                location_node_id=node_id,
                qty=1,
                grid_row=c.grid_row,
                grid_col=c.grid_col,
                created_by_user_id=current.id,
            )
    else:
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
        item_id=lot.item_id,
        movement_type=movement_type,
        qty_delta=qty,
        from_location_node_id=None,
        to_location_node_id=node_id,
        performed_by_user_id=current.id,
        reauth_evidence_id=evidence,
        notes=note,
        lot_id=lot.id,
    )


async def _produce_batch(
    db,
    *,
    kit: Kit,
    good: int,
    scrap: int,
    destinations: list[tuple[uuid.UUID, int, list]],
    expiration_date: date | None,
    lot_number: str | None,
    used_by_line: dict[uuid.UUID, int],
    evidence: uuid.UUID,
    note: str,
    current,
) -> None:
    """Consume material and place ONE produced batch of the AY/FG — shared by the
    ``produce`` endpoint (keep open) and ``close-out`` (finalise), for KIT-007
    incremental / serialized production.

    The operator ENTERS the material used per component (``used_by_line``). Each
    is validated (client 2026-07-23): at least the recipe need
    ``ceil(qty_per_unit × (good + scrap))`` — you can't make N units with less
    than N units' worth (``used_below_need``) — and no more than what's on the
    floor (``used_exceeds_issued``). A component missing a value is
    ``used_qty_missing``. The used amount is drained and added to the cumulative
    ``used_qty``; ``good`` units are placed into the output as a NEW per-batch lot
    (``KIT-0289-1``, ``-2``, … — its own expiry, client 2026-07-23) and
    ``good_qty`` / ``scrap_qty`` accumulate. The batch's units may be SPLIT across
    several ``destinations`` (``(node, qty, cells)``; qtys sum to ``good``) when a
    single box can't hold them all — one lot, several places. It does NOT
    back-flush or change status — the caller decides whether to stay open or
    finalise."""
    attempted = good + scrap
    # Pre-flight EVERY line before anything moves, so a short batch produces nothing.
    consume: dict[uuid.UUID, int] = {}
    for line in kit.lines:
        if line.id not in used_by_line:
            raise ValidationError(
                f"Enter the material used for line {line.line_no}", code="used_qty_missing"
            )
        used = used_by_line[line.id]
        need = kit_repo.default_issued_qty(line.qty_per_unit, attempted)
        if used < need:
            raise ValidationError(
                f"Line {line.line_no}: used {used} is below the {need} needed to make "
                f"{attempted} unit(s) — you can't make {attempted} with less than "
                f"{attempted} unit(s)' worth of material.",
                code="used_below_need",
            )
        on_floor = _on_floor(line)
        if used > on_floor:
            raise ValidationError(
                f"Line {line.line_no}: used {used} exceeds the {on_floor} on the floor. "
                f"Issue more before producing.",
                code="used_exceeds_issued",
            )
        consume[line.id] = used
    for line in kit.lines:
        used = consume[line.id]
        if used <= 0:
            continue
        await _drain_production(db, kit=kit, line=line, qty=used)
        line.used_qty = (line.used_qty or 0) + used
    if good > 0 and destinations:
        # The operator entered this batch's lot number (client 2026-07-24 — replaces
        # the old auto KIT-0289-<n> suffix). ONE lot for the whole batch, even split
        # across destinations. Required-when-producing + global uniqueness are
        # enforced by the caller before we get here.
        assert lot_number, "lot_number is required when producing a batch"
        lot = await inv_repo.create_lot(
            db,
            item_id=kit.item_id,
            lot_number=lot_number,
            created_by_user_id=current.id,
            expiration_date=expiration_date,
        )
        for node_id, qty, cells in destinations:
            await _place_units(
                db,
                kit=kit,
                lot=lot,
                node_id=node_id,
                qty=qty,
                movement_type="production_output",
                kit_line_id=None,
                evidence=evidence,
                note=note,
                current=current,
                cells=cells or None,
            )
        # Primary destination (informational — the ledger has every split).
        kit.output_location_node_id = destinations[0][0]
    kit.good_qty = (kit.good_qty or 0) + good
    kit.scrap_qty = (kit.scrap_qty or 0) + scrap


async def _consumed_context(
    db, kit: Kit, used_by_line: dict[uuid.UUID, int]
) -> list[dict]:
    """The per-component material a batch consumed, resolved to item numbers, for
    the audit event. Consuming material writes NO stock movement (it left stock at
    issue), so without this the partial-produce consumption is invisible in the
    activity timeline — the client wants each batch's consumption shown, not only
    the close-out total (2026-07-23)."""
    consumed_ids = {ln.item_id for ln in kit.lines if used_by_line.get(ln.id, 0) > 0}
    items = await kit_repo.load_item_map(db, consumed_ids) if consumed_ids else {}
    return [
        {
            "item_id": str(ln.item_id),
            "item_number": items[ln.item_id].item_number if ln.item_id in items else "",
            "qty": used_by_line[ln.id],
        }
        for ln in kit.lines
        if used_by_line.get(ln.id, 0) > 0
    ]


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
    q: Annotated[
        str | None,
        Query(
            description="Search kit number, built item number, or description",
            max_length=MAX_SEARCH_LENGTH,
        ),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> KitListResponse:
    rows, total = await kit_repo.list_kits(
        db, status=status_filter, q=q, limit=limit, offset=offset
    )
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
    summary="One page of one section of a production floor's kits, plus tab counts",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def floor_kits(
    db: DBSession,
    node_id: Annotated[uuid.UUID, Path()],
    section: Annotated[
        FloorSection,
        Query(description="Which tab of the floor page to return."),
    ] = "in_production",
    limit: Annotated[int, Query(ge=1, le=100)] = 15,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> FloorKitsResponse:
    """Powers the Production floor page — attributes the work on a floor to the
    kit it belongs to (a floor holds material from every kit issued to it).

    Returns ONE section per call so a busy floor doesn't ship three lists at
    once, plus the counts for all three tabs so their badges stay correct
    whichever tab is open (client 2026-07-28).
    """
    counts = FloorKitCounts(
        in_production=0,  # filled below — the open-kit count is display-filtered
        closed=await kit_repo.count_kits_completed_on_floor(db, node_id),
        cancelled=await kit_repo.count_kits_cancelled_on_floor(db, node_id),
    )

    # Open kits are loaded whole rather than paged in SQL: the "show it only if
    # it has WIP or has produced here" rule below is computed in Python, so a
    # SQL LIMIT would page over rows that the filter then drops, and the count
    # would disagree with the list. A floor holds a handful of open kits, so
    # this is cheap; the two history sections (which do grow) page in SQL.
    open_kits = await kit_repo.kits_on_floor(db, node_id)
    done_kits = (
        await kit_repo.kits_completed_on_floor(db, node_id, limit=limit, offset=offset)
        if section == "closed"
        else []
    )
    cancelled_kits = (
        await kit_repo.kits_cancelled_on_floor(db, node_id, limit=limit, offset=offset)
        if section == "cancelled"
        else []
    )
    all_kits = (*open_kits, *done_kits, *cancelled_kits)
    item_ids = {k.item_id for k in all_kits} | {
        ln.item_id for k in all_kits for ln in k.lines
    }
    items = await kit_repo.load_item_map(db, item_ids)

    def _num(iid: uuid.UUID) -> tuple[str, str]:
        it = items.get(iid)
        return (it.item_number, it.description) if it else ("", "")

    # Batches each open kit has already produced (incremental production, KIT-007)
    # — one lot per batch — so the floor can show work already done, not just WIP.
    # Cancelled kits are included: their batches are exactly what the floor needs
    # to show, and they'd otherwise resolve to an empty list.
    batch_map = await kit_repo.produced_batches_for_kits(
        db, [k.id for k in (*open_kits, *cancelled_kits)]
    )

    active: list[FloorKit] = []
    for k in open_kits:
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
        # What produced batches have already consumed from the floor (cumulative
        # per component), shown as a "Consumed so far" breakdown.
        consumed_lines = [
            FloorKitConsumedLine(
                item_id=str(ln.item_id),
                item_number=_num(ln.item_id)[0],
                description=_num(ln.item_id)[1],
                used_qty=ln.used_qty or 0,
            )
            for ln in sorted(k.lines, key=lambda x: x.line_no)
            if (ln.used_qty or 0) > 0
        ]
        batches = [
            FloorKitBatch(lot_number=lot_number, qty=qty, produced_at=produced_at)
            for (lot_number, qty, produced_at) in batch_map.get(k.id, [])
        ]
        # Show the kit if it has material on the floor OR has already produced
        # something here (so a kit mid-production doesn't vanish once its WIP is 0).
        if not lines and not batches:
            continue
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
                good_qty=k.good_qty or 0,
                scrap_qty=k.scrap_qty or 0,
                consumed_total=sum(cl.used_qty for cl in consumed_lines),
                lines=lines,
                batches=batches,
                consumed=consumed_lines,
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

    cancelled: list[FloorKitCancelled] = []
    for k in cancelled_kits:
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
        cancelled.append(
            FloorKitCancelled(
                id=str(k.id),
                kit_number=k.kit_number,
                item_id=str(k.item_id),
                item_number=_num(k.item_id)[0],
                description=_num(k.item_id)[1],
                target_qty=k.target_qty,
                good_qty=k.good_qty,
                scrap_qty=k.scrap_qty,
                cancelled_at=k.closed_at,
                consumed_total=sum(ln.used_qty for ln in c_lines),
                batches=[
                    FloorKitBatch(lot_number=lot_number, qty=qty, produced_at=produced_at)
                    for (lot_number, qty, produced_at) in batch_map.get(k.id, [])
                ],
                lines=c_lines,
            )
        )

    # The open-kit count follows the same display filter as the list above, so
    # the tab badge and the pager agree with what is actually rendered.
    counts.in_production = len(active)
    if section == "in_production":
        total = len(active)
        active = active[offset : offset + limit]
    elif section == "closed":
        total = counts.closed
    else:
        total = counts.cancelled

    return FloorKitsResponse(
        section=section,
        total=total,
        counts=counts,
        active=active if section == "in_production" else [],
        completed=completed,
        cancelled=cancelled,
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
    operation = str(ctx.get("operation") or e.action)
    # good / scrap / output describe a PRODUCTION batch, so only produce,
    # close-out, and the production draft carry them. For any other event
    # (issue / additional issue / return / create / cancel / edit) they must stay
    # empty — the kit's ``after_state`` snapshot always holds the CUMULATIVE
    # good/scrap/output, and falling back to it wrongly stamped e.g. an
    # additional issue with "N made · M scrapped" (client 2026-07-24 bug).
    if operation in ("produce", "close_out", "production_draft"):
        good = ctx.get("good_qty")
        good = after.get("good_qty") if good is None else good
        scrap = ctx.get("scrap_qty")
        scrap = after.get("scrap_qty") if scrap is None else scrap
        out_node = ctx.get("output_location_node_id") or after.get("output_location_node_id")
        out_expiry = ctx.get("output_expiration_date")
    else:
        good = scrap = out_node = out_expiry = None
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
    consumed = [
        KitConsumedLine(
            item_id=str(c.get("item_id")),
            item_number=str(c.get("item_number") or ""),
            qty=int(c.get("qty") or 0),
        )
        for c in (ctx.get("consumed") or [])
        if int(c.get("qty") or 0) > 0
    ]
    return KitAuditEventRow(
        id=str(e.id),
        occurred_at=e.occurred_at,
        operation=operation,
        action=e.action,
        actor_user_id=str(e.actor_user_id) if e.actor_user_id else None,
        good_qty=good,
        scrap_qty=scrap,
        output_location=out_label,
        output_expiration_date=out_expiry,
        consumed=consumed,
        diff=e.diff,
    )


@kits_router.get(
    "/by-item/{item_id}/consumption",
    response_model=ItemKitConsumptionResponse,
    summary="Per-item kit consumption (issued / used / returned per kit)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def item_kit_consumption(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> ItemKitConsumptionResponse:
    """What each kit actually USED of this item.

    The Unit Ledger can show the stock events — ``kit_issue`` out,
    ``backflush`` in — but never the consumption between them, because using
    material writes no movement (it already left ``v_item_stock`` at issue,
    kitting.md §4.3). This supplies the missing middle term so the ledger can
    read the way REQ-2026-07-09-TRX-003 describes: "issued fifteen, used twelve,
    backflushed three".
    """
    lines = await kit_repo.consumption_lines_for_item(db, item_id, limit=limit)
    rows: list[ItemKitConsumptionRow] = []
    for ln in lines:
        kit = ln.kit
        if kit is None:
            continue
        issued_total = ln.issued_qty + ln.additional_issued_qty
        used = ln.used_qty or 0
        rows.append(
            ItemKitConsumptionRow(
                kit_id=str(kit.id),
                kit_number=kit.kit_number,
                status=kit.status,  # type: ignore[arg-type]
                issued_total=issued_total,
                used_qty=used,
                early_returned_qty=ln.early_returned_qty,
                # Back-flushed at close for a closed kit; still on the floor for
                # an open one. Never negative — the DB CHECK caps used at
                # issued + additional − early_returned.
                remainder=max(0, issued_total - ln.early_returned_qty - used),
            )
        )
    return ItemKitConsumptionResponse(lines=rows)


@kits_router.get(
    "/by-item/{item_id}/audit",
    response_model=ItemKitAuditResponse,
    summary="Per-item kitting audit history (every kit this item took part in)",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def item_kit_audit(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> ItemKitAuditResponse:
    """Kitting & reconciliation events for kits this item was built in, issued
    to, or back-flushed from (AUD-001, "viewable per item"). Complements the
    item's Unit Ledger movements with the good/scrap/consumed/output detail that
    never moves stock. Each row names + links its kit."""
    events = await kit_repo.audit_events_for_item(db, item_id, limit=limit)
    node_labels = await loc_repo.node_label_map(db) if events else {}
    return ItemKitAuditResponse(
        events=[_item_kit_audit_row(e, node_labels) for e in events]
    )


def _item_kit_audit_row(e, node_labels: dict | None = None) -> ItemKitAuditEventRow:
    """Same shape as :func:`_audit_event_row`, plus the owning kit (from the
    event's ``subject_id`` / ``subject_label``) and its e-signature."""
    base = _audit_event_row(e, node_labels)
    return ItemKitAuditEventRow(
        **base.model_dump(),
        kit_id=str(e.subject_id),
        kit_number=e.subject_label,
        signature_id=str(e.signature_id) if e.signature_id else None,
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

    # The draft edits are committed here, so the Issue button is the only write —
    # nothing is persisted while the user types. Two shapes are accepted per line:
    # the multi-source ``sources`` list (KIT-002/003, preferred), or the legacy
    # single source + issued_qty [+ cells].
    lines_by_id = {ln.id: ln for ln in kit.lines}
    multi_moves: dict[uuid.UUID, list[tuple[uuid.UUID, uuid.UUID | None, int, list[str]]]] = {}
    legacy_cells: dict[uuid.UUID, list[str]] = {}
    if payload and payload.lines:
        for line_in in payload.lines:
            lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
            line = lines_by_id.get(lid)
            if line is None:
                raise ValidationError(f"Line {lid} is not on this kit", code="line_not_in_kit")
            if line_in.sources:
                moves, total, primary = await _parse_source_picks(
                    db, line=line, sources=line_in.sources
                )
                line.issued_qty = total
                if primary is not None:
                    line.source_location_node_id = primary
                multi_moves[lid] = moves
            else:
                line.issued_qty = line_in.issued_qty or 0
                legacy_cells[lid] = line_in.cell_allocation_ids
                if line_in.source_location_node_id is not None:
                    src = _parse_uuid_or_422(
                        line_in.source_location_node_id, field="source_location_node_id"
                    )
                    if not await kit_repo.storage_node_exists(db, src):
                        raise NotFoundError("Source location not found", code="source_not_found")
                    line.source_location_node_id = src
        await db.flush()

    # Leftover back-flushes to where it was pulled from, so the return location
    # defaults to the line's source (the primary/largest pick for a multi line).
    for line in kit.lines:
        line.return_location_node_id = line.source_location_node_id

    # No recipe gating at issue (REQ-2026-07-22-KIT-007). A kit records what
    # physically happened, so a short or even empty issue is allowed — the
    # operator may issue for a whole campaign up front OR assign at point of use
    # and top up later with "issue more". The earlier hard gates
    # (``issued_below_need`` / ``source_below_need`` / ``nothing_to_issue``, all
    # client-added 2026-07-22) are removed. Physical reality still holds: a pick
    # can't pull more of a lot than exists (``insufficient_source_stock``) and a
    # line issuing > 0 still needs a source (``source_required``) — both enforced
    # inside ``_move_to_production`` as each pick moves.
    for line in kit.lines:
        if line.id in multi_moves:
            for node_id, lot_id, qty, cells in multi_moves[line.id]:
                await _move_to_production(
                    db,
                    kit=kit,
                    line=line,
                    qty=qty,
                    movement_type="kit_issue",
                    note=f"Issued {qty} to production for {kit.kit_number}",
                    current=current,
                    node_id=node_id,
                    lot_id=lot_id,
                    cell_allocation_ids=cells or None,
                )
            continue
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
            cell_allocation_ids=legacy_cells.get(line.id) or None,
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
    # Multi-source (KIT-004): the extra material may be drawn from any lots/
    # shelves, not just the line's original source. Legacy: a single qty [+ cells]
    # from the line's recorded source.
    if payload.sources:
        moves, added, _primary = await _parse_source_picks(db, line=line, sources=payload.sources)
        if added <= 0:
            raise ValidationError("Nothing to issue — every source is zero", code="nothing_to_issue")
        for node_id, lot_id, qty, cells in moves:
            await _move_to_production(
                db,
                kit=kit,
                line=line,
                qty=qty,
                movement_type="kit_additional_issue",
                note=f"Additional {qty} issued for {kit.kit_number}",
                current=current,
                node_id=node_id,
                lot_id=lot_id,
                cell_allocation_ids=cells or None,
            )
    else:
        if not payload.qty:
            raise ValidationError("A quantity or sources are required", code="qty_required")
        added = payload.qty
        await _move_to_production(
            db,
            kit=kit,
            line=line,
            qty=payload.qty,
            movement_type="kit_additional_issue",
            note=f"Additional {payload.qty} issued for {kit.kit_number}",
            current=current,
            cell_allocation_ids=payload.cell_allocation_ids or None,
        )
    line.additional_issued_qty += added
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
        context={"operation": "additional_issue", "line_no": line.line_no, "qty": added},
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
    The operator picks which on-floor LOT(s) to hand back and where (client
    2026-07-24, ``sources[]``); each returned unit keeps its origin lot (moved
    back, never re-minted), so nothing is stranded. The legacy single
    ``qty`` + ``return_location_node_id`` (FIFO across the floor's lots) still
    works when ``sources`` is empty. Unsigned, matching issue / additional issue
    (only close-out is e-signed)."""
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Material can only be returned while the kit is in production",
            code="kit_not_in_production",
        )
    line = next((ln for ln in kit.lines if ln.id == line_id), None)
    if line is None:
        raise NotFoundError(f"Line {line_id} not on kit {kit_id}", code="line_not_found")

    # No recipe cap on returns (REQ-2026-07-22-KIT-007): the operator may hand
    # back whatever wasn't used, even below the BOM requirement. The only limit is
    # physical: you can't return more than is on the floor (checked below).
    on_floor = _on_floor(line)
    before = _kit_snapshot(kit)

    # One cell can hold one unit, so every destination in THIS request competes
    # for the same free cells. Accumulated across all of them below.
    claimed_cells: dict[uuid.UUID, set[tuple[int, int]]] = {}

    if payload.sources:
        # Multi-source: the operator picked which on-floor LOT(s) to return and
        # where. Validate each pick placeable + its cells, cap the total at the
        # floor, and cap each lot at that lot's own on-floor qty.
        floor = await kit_repo.floor_lots_by_item_at_node(
            db, kit.production_location_node_id, {line.item_id}
        )
        avail_by_lot = {lid: q for (lid, _num, q) in floor.get(line.item_id, [])}
        picks: list[tuple[uuid.UUID, int, uuid.UUID, list]] = []
        per_lot: dict[uuid.UUID, int] = {}
        total = 0
        for s in payload.sources:
            lot_uuid = _parse_uuid_or_422(s.lot_id, field="lot_id")
            fallback = (
                _parse_uuid_or_422(
                    s.return_location_node_id, field="return_location_node_id"
                )
                if s.return_location_node_id
                else None
            )
            # One pick's units may themselves land in several places when no
            # single box has enough free cells.
            for node_uuid, q, cells in await _resolve_return_destinations(
                db,
                destinations=s.destinations,
                fallback_node=fallback,
                fallback_cells=s.return_cells,
                total=s.qty,
                claimed=claimed_cells,
            ):
                picks.append((lot_uuid, q, node_uuid, cells))
            per_lot[lot_uuid] = per_lot.get(lot_uuid, 0) + s.qty
            total += s.qty
        if total > on_floor:
            raise ValidationError(
                f"Line {line.line_no}: only {on_floor} on the production floor "
                f"(tried to return {total}).",
                code="return_exceeds_on_floor",
            )
        for lot_uuid, req in per_lot.items():
            avail = avail_by_lot.get(lot_uuid, 0)
            if req > avail:
                raise ValidationError(
                    f"Line {line.line_no}: only {avail} of that lot on the floor "
                    f"(tried to return {req}).",
                    code="return_exceeds_lot_on_floor",
                )
        note = f"Returned {total} to inventory from {kit.kit_number}"
        if payload.reason:
            note = f"{note} — {payload.reason}"
        for lot_uuid, q, node_uuid, cells in picks:
            await _return_to_inventory(
                db,
                kit=kit,
                line=line,
                qty=q,
                to_node=node_uuid,
                evidence=None,
                note=note,
                current=current,
                return_cells=cells,
                movement_type="kit_return",
                only_lot_id=lot_uuid,
            )
        line.early_returned_qty += total
        line.return_location_node_id = picks[-1][2]
        returned_qty = total
    else:
        # Legacy single: FIFO across the floor's lots (unchanged path).
        if payload.qty is None or (
            payload.return_location_node_id is None and not payload.destinations
        ):
            raise ValidationError(
                "Provide sources[] or a qty with a return_location_node_id.",
                code="return_input_required",
            )
        if payload.qty > on_floor:
            raise ValidationError(
                f"Line {line.line_no}: only {on_floor} on the production floor "
                f"(tried to return {payload.qty}).",
                code="return_exceeds_on_floor",
            )
        to_node = (
            _parse_uuid_or_422(
                payload.return_location_node_id, field="return_location_node_id"
            )
            if payload.return_location_node_id
            else None
        )
        resolved = await _resolve_return_destinations(
            db,
            destinations=payload.destinations,
            fallback_node=to_node,
            fallback_cells=payload.return_cells,
            total=payload.qty,
            claimed=claimed_cells,
        )
        note = f"Returned {payload.qty} to inventory from {kit.kit_number}"
        if payload.reason:
            note = f"{note} — {payload.reason}"
        for node_uuid, q, cells in resolved:
            await _return_to_inventory(
                db,
                kit=kit,
                line=line,
                qty=q,
                to_node=node_uuid,
                evidence=None,
                note=note,
                current=current,
                return_cells=cells,
                movement_type="kit_return",
            )
        line.early_returned_qty += payload.qty
        line.return_location_node_id = resolved[-1][0]
        returned_qty = payload.qty
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
            "qty": returned_qty,
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


# ── Produce a batch (e-signed; keeps the kit OPEN) ──────────────────────


@kits_router.post(
    "/{kit_id}/produce",
    response_model=KitRead,
    summary="Produce a batch of the AY/FG and keep the kit open. E-signed.",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def produce_kit(
    db: DBSession,
    current: CurrentDbUserDep,
    kit_id: Annotated[uuid.UUID, Path()],
    payload: ProduceRequest,
) -> KitRead:
    """Make a batch now, keep the kit open for more (KIT-007 incremental /
    serialized production). Produces ``good_qty`` units from the material used,
    accumulating on the kit; the leftover stays on the floor for the next batch
    or the final close-out. E-signed (action ``kit.produce``)."""
    kit = await _require_kit(db, kit_id)
    if kit.status not in ("issued", "in_production"):
        raise ValidationError(
            "Only a kit in production can produce a batch",
            code="kit_not_in_production",
        )
    before = _kit_snapshot(kit)
    if payload.output_expiration_date and payload.output_expiration_date < _now().date():
        raise ValidationError(
            "The produced lot's expiry can't be in the past", code="expiry_in_past"
        )
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    lot_no = await _resolve_output_lot_number(db, payload)
    # One cell can hold one unit, so every destination in THIS request competes
    # for the same free cells. Accumulated across all of them below.
    claimed_cells: dict[uuid.UUID, set[tuple[int, int]]] = {}
    destinations = await _resolve_output_destinations(
        db, payload, payload.good_qty, claimed_cells
    )
    lines_by_id = {ln.id: ln for ln in kit.lines}
    used_by_line: dict[uuid.UUID, int] = {}
    for line_in in payload.lines:
        lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        if lid not in lines_by_id:
            raise ValidationError(f"Line {lid} is not on this kit", code="line_not_in_kit")
        used_by_line[lid] = line_in.used_qty

    await _produce_batch(
        db,
        kit=kit,
        good=payload.good_qty,
        scrap=payload.scrap_qty,
        destinations=destinations,
        expiration_date=payload.output_expiration_date,
        lot_number=lot_no,
        used_by_line=used_by_line,
        evidence=evidence_uuid,
        note=f"Produced batch of {payload.good_qty} for {kit.kit_number}",
        current=current,
    )
    kit.status = "in_production"  # stays OPEN — produce more, or close later
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
            "operation": "produce",
            "good_qty": payload.good_qty,
            "scrap_qty": payload.scrap_qty,
            "output_lot_number": lot_no,
            "output_location_node_id": (
                str(destinations[0][0]) if destinations else None
            ),
            "output_destination_count": len(destinations),
            "output_expiration_date": (
                payload.output_expiration_date.isoformat()
                if payload.output_expiration_date
                else None
            ),
            "consumed": await _consumed_context(db, kit, used_by_line),
        },
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=PRODUCE_ACTION,
        target_table="app.kits",
        target_id=kit.id,
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
    # A kit must yield at least one good unit over its lifetime — but with
    # incremental production (KIT-007) the good units may have been made in
    # earlier ``produce`` batches, so the check is on the CUMULATIVE total
    # (already-produced + this final batch). A close with good_qty 0 is valid
    # when prior batches already produced something — it just back-flushes the
    # remainder and locks the kit.
    if (kit.good_qty or 0) + payload.good_qty < 1:
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

    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    # Operator-entered lot number for this final batch (client 2026-07-24) —
    # required + globally unique when good_qty >= 1, None when the close makes 0.
    lot_no = await _resolve_output_lot_number(db, payload)
    # The output may target an LN2 box (KIT-005) and may be SPLIT across several
    # boxes / freezers / shelves (client 2026-07-23) when one box can't hold every
    # unit — each destination is checked placeable and its cells validated up
    # front so a bad selection blocks before anything is written. Empty (no output)
    # when this final batch makes 0 good units.
    # One cell can hold one unit, so every destination in THIS request competes
    # for the same free cells. Accumulated across all of them below.
    claimed_cells: dict[uuid.UUID, set[tuple[int, int]]] = {}
    destinations = await _resolve_output_destinations(
        db, payload, payload.good_qty, claimed_cells
    )

    # Per-line consumption (used, validated in _produce_batch) + back-flush
    # destinations for the leftover. Omitted lines default to the source.
    lines_by_id = {ln.id: ln for ln in kit.lines}
    used_by_line: dict[uuid.UUID, int] = {}
    return_cells_by_line: dict[uuid.UUID, list] = {}
    return_dests_by_line: dict[uuid.UUID, list] = {}
    for line_in in payload.lines:
        lid = _parse_uuid_or_422(line_in.line_id, field="line_id")
        if lid not in lines_by_id:
            raise ValidationError(f"Line {lid} is not on this kit", code="line_not_in_kit")
        used_by_line[lid] = line_in.used_qty
        return_cells_by_line[lid] = line_in.return_cells
        return_dests_by_line[lid] = line_in.destinations
        if line_in.return_location_node_id is not None:
            ret = _parse_uuid_or_422(
                line_in.return_location_node_id, field="return_location_node_id"
            )
            await _require_placeable(db, ret, "Return location")
            lines_by_id[lid].return_location_node_id = ret

    # 1. Produce the FINAL batch — consumes the entered used (≥ need, ≤ floor),
    #    places good, accumulates on the kit (same helper as ``produce``). good
    #    may be 0 when everything was produced in earlier batches; close then
    #    just back-flushes the remainder and locks.
    await _produce_batch(
        db,
        kit=kit,
        good=payload.good_qty,
        scrap=payload.scrap_qty,
        destinations=destinations,
        expiration_date=payload.output_expiration_date,
        lot_number=lot_no,
        used_by_line=used_by_line,
        evidence=evidence_uuid,
        note=f"{payload.good_qty} produced and stocked for {kit.kit_number}",
        current=current,
    )

    # 2. Back-flush whatever is still on the floor — the remainder after every
    #    produce batch (``_on_floor`` already nets out cumulative used) — to each
    #    line's return location (REQ-2026-07-09-TRX-003), so the kit's WIP
    #    reaches zero.
    for line in kit.lines:
        returned = _on_floor(line)
        if returned <= 0:
            continue
        ret_node = line.return_location_node_id or line.source_location_node_id
        dests = return_dests_by_line.get(line.id) or []
        if ret_node is None and not dests:
            raise ValidationError(
                f"Line {line.line_no} has nowhere to back-flush to", code="return_required"
            )
        resolved = await _resolve_return_destinations(
            db,
            destinations=dests,
            fallback_node=ret_node,
            fallback_cells=return_cells_by_line.get(line.id, []),
            total=returned,
            claimed=claimed_cells,
        )
        # One back-flush movement per destination: the leftover may be split
        # across boxes when no single one has enough free cells.
        for node_uuid, qty, ret_cells in resolved:
            await _return_to_inventory(
                db,
                kit=kit,
                line=line,
                qty=qty,
                to_node=node_uuid,
                evidence=evidence_uuid,
                note=(
                    f"Issued {line.issued_qty + line.additional_issued_qty}, "
                    f"used {line.used_qty}, backflushed {qty}"
                ),
                current=current,
                # Back-flushing into an LN2 box places one unit per chosen cell.
                # The cells are validated just above, and were being dropped here
                # — the units landed in the box as one cell-less allocation, so
                # the grid showed nothing and the vial positions were lost
                # (KIT-005). Every other return path already passes them.
                return_cells=ret_cells,
            )
        line.return_location_node_id = resolved[-1][0]

    kit.status = "closed"
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
            "output_lot_number": lot_no,
            "output_location_node_id": (
                str(destinations[0][0]) if destinations else None
            ),
            "output_destination_count": len(destinations),
            "output_expiration_date": (
                payload.output_expiration_date.isoformat()
                if payload.output_expiration_date
                else None
            ),
            "consumed": await _consumed_context(db, kit, used_by_line),
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
        # One cell can hold one unit, so every destination in THIS request competes
        # for the same free cells. Accumulated across all of them below.
        claimed_cells: dict[uuid.UUID, set[tuple[int, int]]] = {}
        for line in kit.lines:
            on_floor = _on_floor(line)
            if on_floor <= 0:
                continue
            line_in = by_line.get(line.id)
            if line_in is not None:
                fallback = (
                    _parse_uuid_or_422(
                        line_in.return_location_node_id, field="return_location_node_id"
                    )
                    if line_in.return_location_node_id
                    else None
                )
                dests = await _resolve_return_destinations(
                    db,
                    destinations=line_in.destinations,
                    fallback_node=fallback,
                    fallback_cells=line_in.return_cells,
                    total=on_floor,
                    claimed=claimed_cells,
                )
            else:
                fallback = line.return_location_node_id or line.source_location_node_id
                if fallback is None:
                    raise ValidationError(
                        f"Line {line.line_no} has nowhere to return to",
                        code="return_required",
                    )
                dests = await _resolve_return_destinations(
                    db,
                    destinations=[],
                    fallback_node=fallback,
                    fallback_cells=[],
                    total=on_floor,
                    claimed=claimed_cells,
                )
            # One return movement per destination — the material may be split
            # across boxes when no single one has enough free cells.
            for node_uuid, qty, cells in dests:
                await _return_to_inventory(
                    db,
                    kit=kit,
                    line=line,
                    qty=qty,
                    to_node=node_uuid,
                    evidence=None,
                    note=f"{kit.kit_number} cancelled — {qty} returned to inventory",
                    current=current,
                    return_cells=cells,
                    movement_type="kit_cancel_return",
                )
            line.early_returned_qty += on_floor
            # The last destination is what the line remembers as "where it went"
            # — the same convention the multi-source return already uses.
            line.return_location_node_id = dests[-1][0]
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
