"""Pydantic schemas for the Kitting / back-flush API.

Implements ``docs/modules/kitting.md``. Reads use ``from_attributes``; writes
use ``extra='forbid'``. Only **close-out** is electronically signed (client
2026-07-20) — it carries the ``_ESignFields``; issue / additional issue /
cancel are unsigned.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

KitStatus = Literal["draft", "issued", "in_production", "closed", "cancelled"]


# ── E-signature mixin (close-out only) ──────────────────────────────────


class _ESignFields(BaseModel):
    """Electronic-signature fields. The ``reason`` comment is optional."""

    evidence_id: str = Field(
        min_length=1, description="Fresh reauth evidence id for the signed action"
    )
    reason: str = Field(
        default="",
        max_length=512,
        description="Optional reason, recorded on the audit row",
    )


# ── Reads ───────────────────────────────────────────────────────────────


class CellOption(BaseModel):
    """One occupied grid cell in a box — always exactly one unit of one lot
    (``uq_lot_allocations_cell``). The operator picks these to choose *which*
    vials leave; the recorded location stays the box (D4)."""

    allocation_id: str
    grid_row: int
    grid_col: int
    lot_id: str
    lot_number: str | None = None
    expiration_date: date | None = None


class KitLineSourceOption(BaseModel):
    """A location that currently holds the component, with its available qty."""

    node_id: str
    name: str
    path: str
    qty: int
    # Grid-bearing (LN2 box) nodes carry their cells so the Issue step can draw
    # the grid. Bulk nodes (shelf / sub-location) leave these empty and keep the
    # plain quantity input.
    is_grid: bool = False
    grid_rows: int | None = None
    grid_cols: int | None = None
    cells: list[CellOption] = Field(default_factory=list)


class KitLineSourceLot(BaseModel):
    """One **lot** of a component available at one location — a pickable issue
    source (KIT-002/003). The Issue picker lists these FIFO-ordered so the
    operator can draw the need across several lots/shelves at once, and see how
    much comes from each. For an LN2 box, ``cells`` holds the exact vials of
    this lot so the operator picks them by position (D2)."""

    lot_id: str
    lot_number: str | None = None
    expiration_date: date | None = None
    node_id: str
    node_name: str
    path: str
    qty: int
    # Grid-bearing (LN2 box) source: the quantity follows the cells picked.
    is_grid: bool = False
    grid_rows: int | None = None
    grid_cols: int | None = None
    cells: list[CellOption] = Field(default_factory=list)


class KitLineIssuedFrom(BaseModel):
    """One (lot, source location) the line was ISSUED from — the snapshot the
    Issue step shows once material has moved (client 2026-07-22). Derived from
    the ``kit_issue`` ledger rows, so it reflects the real multi-lot split."""

    lot_number: str | None = None
    location: str
    qty: int


class KitLineFloorLot(BaseModel):
    """One lot of a component currently on the production floor (WIP) — a pickable
    RETURN source (client 2026-07-24). The Return dialog lists these FIFO-ordered
    so the operator picks which lot's units to hand back; each returned unit keeps
    its origin lot (TRX-008: moved back, never re-minted, never stranded)."""

    lot_id: str
    lot_number: str | None = None
    qty: int


class KitLineRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    line_no: int
    item_id: str
    item_number: str
    description: str
    qty_per_unit: Decimal
    # Derived = qty_per_unit × kit.target_qty.
    needed_qty: Decimal
    issued_qty: int
    additional_issued_qty: int
    used_qty: int | None = None
    # Returned to inventory before close-out (TRX-008).
    early_returned_qty: int = 0
    # Derived = issued + additional − early_returned: what is still on the
    # production floor and must be reconciled at close-out.
    on_floor_qty: int = 0
    # Derived = on_floor − used (null until used is entered) — the close-out
    # back-flush amount.
    returned_qty: int | None = None
    source_location_node_id: str | None = None
    return_location_node_id: str | None = None
    # Location-System stock for this component (from lot_allocations).
    on_hand: int = 0
    # Per-location totals (legacy single-source picker).
    source_options: list[KitLineSourceOption] = Field(default_factory=list)
    # Per-LOT sources (multi-source picker, KIT-002/003), FIFO-ordered.
    source_lots: list[KitLineSourceLot] = Field(default_factory=list)
    # The (lot, location) the line was ISSUED from — the post-issue snapshot.
    issued_from: list[KitLineIssuedFrom] = Field(default_factory=list)
    # Per-LOT WIP on the production floor — pickable RETURN sources (client
    # 2026-07-24): the operator picks which floor lot's units to hand back.
    on_floor_lots: list[KitLineFloorLot] = Field(default_factory=list)
    # Available at the currently-chosen source node (the issue cap).
    source_available: int = 0


class KitRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kit_number: str
    item_id: str
    item_number: str
    description: str
    target_qty: int
    status: KitStatus
    production_location_node_id: str
    output_location_node_id: str | None = None
    good_qty: int | None = None
    scrap_qty: int | None = None
    notes: str | None = None
    issued_at: datetime | None = None
    closed_at: datetime | None = None
    created_by_user_id: str
    created_at: datetime
    updated_at: datetime
    lines: list[KitLineRead] = Field(default_factory=list)


class KitListItem(BaseModel):
    """Row shape for the kit list (no lines)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    kit_number: str
    item_id: str
    item_number: str
    description: str
    target_qty: int
    status: KitStatus
    production_location_node_id: str
    # Human path of the production floor (e.g. "Manufacturing Floor").
    production_location: str | None = None
    # Human path of where the output was stocked — null until close-out.
    output_location: str | None = None
    good_qty: int | None = None
    scrap_qty: int | None = None
    line_count: int = 0
    created_at: datetime


class KitNumberSuggestion(BaseModel):
    """A free ``KIT-####`` for the New-kit dialog to pre-fill."""

    kit_number: str


class KitListResponse(BaseModel):
    items: list[KitListItem] = Field(default_factory=list)
    total: int
    limit: int
    offset: int


class KitActivityRow(BaseModel):
    """One kit ledger entry (a ``stock_movements`` row for this kit)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    performed_at: datetime
    movement_type: str
    item_id: str
    item_number: str
    qty_delta: int
    from_location_node_id: str | None = None
    to_location_node_id: str | None = None
    notes: str | None = None
    performed_by_user_id: str


class KitConsumedLine(BaseModel):
    """One component consumed by a produce / close batch — recorded on the event
    so the activity timeline can show what each batch used, not just the output.
    Consumption writes no stock movement (the material left stock at issue), so
    without this the partial-produce consumption would be invisible."""

    item_id: str
    item_number: str
    qty: int


class KitAuditEventRow(BaseModel):
    """One audit-trail entry for a kit (from ``audit.audit_events``).

    Complements :class:`KitActivityRow`: the stock ledger only records quantity
    *movements*, so scrap — which never moves stock — is invisible there. These
    rows carry the full-snapshot events (client 2026-07-22), including good and
    scrap counts, so the activity view misses nothing.
    """

    id: str
    occurred_at: datetime
    # The kitting operation (issue / additional_issue / early_return /
    # production_draft / close_out / cancel / create / edit_line), from the
    # event context; falls back to the coarse audit action.
    operation: str
    action: str
    actor_user_id: str | None = None
    good_qty: int | None = None
    scrap_qty: int | None = None
    # Where the produced output was stocked + its lot expiry (close-out only).
    output_location: str | None = None
    output_expiration_date: str | None = None
    # Material this batch consumed (produce / close), per component. Empty for
    # non-producing events.
    consumed: list[KitConsumedLine] = Field(default_factory=list)
    # Per-field {before, after} for what changed on this event.
    diff: dict | None = None


class FloorKitLine(BaseModel):
    """One component a kit is holding on the production floor."""

    item_id: str
    item_number: str
    description: str
    on_floor_qty: int


class FloorKitBatch(BaseModel):
    """One batch a kit has already produced while still open (KIT-007 incremental
    production) — its operator-entered lot number, the good units placed, and
    when. Powers the "Batches produced" list in the Production view."""

    lot_number: str | None = None
    qty: int
    produced_at: datetime | None = None


class FloorKitConsumedLine(BaseModel):
    """A component a kit consumed on the floor (produced batches, or a close-out)."""

    item_id: str
    item_number: str
    description: str
    used_qty: int


class FloorKit(BaseModel):
    """An open kit building on a production floor, with its on-floor material —
    so the Production view can attribute WIP to the kit it belongs to. Carries
    what it has already produced/consumed (incremental production, KIT-007): the
    per-batch lots, the cumulative good/scrap, and the material consumed so far."""

    id: str
    kit_number: str
    item_id: str
    item_number: str
    description: str
    target_qty: int
    status: KitStatus
    on_floor_total: int
    good_qty: int = 0
    scrap_qty: int = 0
    consumed_total: int = 0
    lines: list[FloorKitLine] = Field(default_factory=list)
    # Batches produced so far (each a minted lot) and the material consumed by
    # them — shown alongside the live WIP so the floor reflects work already done.
    batches: list[FloorKitBatch] = Field(default_factory=list)
    consumed: list[FloorKitConsumedLine] = Field(default_factory=list)


class FloorKitConsumed(BaseModel):
    """A closed kit that built on this floor — what it consumed and yielded, so
    the Production view can show completed builds alongside live WIP."""

    id: str
    kit_number: str
    item_id: str
    item_number: str
    description: str
    target_qty: int
    good_qty: int | None = None
    scrap_qty: int | None = None
    closed_at: datetime | None = None
    consumed_total: int
    lines: list[FloorKitConsumedLine] = Field(default_factory=list)


class FloorKitCancelled(BaseModel):
    """A kit that was cancelled AFTER producing on this floor.

    Cancelling from ``in_production`` is allowed, and under incremental
    production (KIT-007) the kit may already have made batches — real stock on
    real lots. Those batches are not undone by the cancel, so the floor still
    has to account for them (client 2026-07-28). Carries the same detail as an
    open kit's history: the per-batch lots and the per-component consumption.
    """

    id: str
    kit_number: str
    item_id: str
    item_number: str
    description: str
    target_qty: int
    good_qty: int | None = None
    scrap_qty: int | None = None
    # ``closed_at`` is stamped on cancel as well as on close.
    cancelled_at: datetime | None = None
    consumed_total: int = 0
    batches: list[FloorKitBatch] = Field(default_factory=list)
    lines: list[FloorKitConsumedLine] = Field(default_factory=list)


#: The three tabs of a production floor's detail page. Named for the kit STATUS
#: each holds — ``closed`` is the status the rest of the system uses (and the
#: badge the operator sees), so the tab, the badge and the SRS's "close-out"
#: language all agree (client 2026-07-28, replacing an earlier "consumed").
FloorSection = Literal["in_production", "closed", "cancelled"]


class FloorKitCounts(BaseModel):
    """Row counts for all three sections, so the tabs can show their counts
    without fetching every section's rows."""

    in_production: int = 0
    closed: int = 0
    cancelled: int = 0


class FloorKitsResponse(BaseModel):
    """One PAGE of one section, plus the counts for every tab.

    Only the list matching ``section`` is populated — the floor page fetches the
    tab being viewed rather than all three, which is the point of paging it
    (client 2026-07-28).
    """

    section: FloorSection
    # Rows in the requested section across all pages (drives the pager).
    total: int = 0
    counts: FloorKitCounts = Field(default_factory=FloorKitCounts)
    # Open kits with material still on the floor (WIP).
    active: list[FloorKit] = Field(default_factory=list)
    # Closed kits that built here — what they consumed.
    completed: list[FloorKitConsumed] = Field(default_factory=list)
    # Cancelled kits that had already produced here before being abandoned.
    cancelled: list[FloorKitCancelled] = Field(default_factory=list)


class KitActivityResponse(BaseModel):
    items: list[KitActivityRow] = Field(default_factory=list)
    # The audit-trail events for the kit (newest first) — carry good/scrap and
    # per-line changes the stock ledger can't show.
    events: list[KitAuditEventRow] = Field(default_factory=list)


class ItemKitConsumptionRow(BaseModel):
    """What ONE kit did with this item — the reconciliation the ledger can't
    show on its own.

    Consumption writes no stock movement (the material left ``v_item_stock`` at
    issue), so ``used_qty`` is read straight off the kit line. Raw figures are
    returned rather than a formatted sentence: how it reads depends on the kit's
    status, and that's the caller's business.

    ``remainder`` = ``issued_total − early_returned_qty − used_qty``. For a
    CLOSED kit that is what was back-flushed at close-out; for an OPEN one it is
    what is still on the production floor.
    """

    kit_id: str
    kit_number: str
    status: KitStatus
    #: ``issued_qty + additional_issued_qty`` — everything this kit ever pulled.
    issued_total: int
    used_qty: int
    #: Handed back before close-out (TRX-008), plus anything returned on cancel.
    early_returned_qty: int
    remainder: int


class ItemKitConsumptionResponse(BaseModel):
    lines: list[ItemKitConsumptionRow] = Field(default_factory=list)


class ItemKitAuditEventRow(KitAuditEventRow):
    """A kit audit event surfaced on an ITEM's audit history (AUD-001) — the same
    event shape plus which kit it belongs to, so the per-item timeline can label
    and link it."""

    kit_id: str
    kit_number: str | None = None
    # The e-signature (re-auth) recorded on the event, so the row can show the
    # "e-signed" badge (produce / close-out / cancel are signed).
    signature_id: str | None = None


class ItemKitAuditResponse(BaseModel):
    # Kit audit events for every kit this item took part in (newest first).
    events: list[ItemKitAuditEventRow] = Field(default_factory=list)


# ── Writes ──────────────────────────────────────────────────────────────


class KitCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Operator-supplied, so the system record can carry the batch/traveler
    # number the paper record uses — the spec leans on that link ("a kit is
    # closed out using data from the traveler"). Also becomes the produced
    # lot's number at close-out. The UI pre-fills a free KIT-#### suggestion.
    kit_number: str = Field(
        min_length=1,
        max_length=64,
        description="Kit / batch name. Must be unique; also names the produced lot.",
    )
    item_id: str = Field(description="The sub-assembly or finished good to build")
    target_qty: int = Field(gt=0, description="How many to build")
    production_location_node_id: str = Field(
        description="Advisory production floor (a real location node)"
    )
    notes: str | None = Field(default=None, max_length=2048)


class KitUpdateRequest(BaseModel):
    """Edit a kit's name and/or target quantity.

    ``kit_number`` is editable while the kit is still open (not closed /
    cancelled). ``target_qty`` may only change while the kit is a draft — after
    issue it is locked because it drives every line's needed quantity.
    """

    model_config = ConfigDict(extra="forbid")

    kit_number: str | None = Field(default=None, min_length=1, max_length=64)
    target_qty: int | None = Field(default=None, gt=0)


class KitLineUpdateRequest(BaseModel):
    """Edit a draft line's issued quantity and/or source location."""

    model_config = ConfigDict(extra="forbid")

    issued_qty: int | None = Field(default=None, ge=0)
    source_location_node_id: str | None = None


class IssueSourceInput(BaseModel):
    """One lot pick within a line's issue — draw ``qty`` of the component from a
    specific (location, lot). The Issue picker builds one of these per lot the
    operator selects (KIT-003, "FIFO across multiple lots"). For a box lot the
    exact vials are named by ``cell_allocation_ids`` and ``qty`` follows their
    count."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    lot_id: str | None = None
    qty: int = Field(ge=0)
    # Box lot only: the exact cells to pull. When present, ``qty`` must equal
    # its length (a cell holds one unit, D2).
    cell_allocation_ids: list[str] = Field(default_factory=list)


class IssueLineInput(BaseModel):
    """A line's final issue, committed with the Issue action.

    Two shapes are accepted. The multi-source ``sources`` list (KIT-002/003) is
    preferred and takes precedence when present. The legacy single-source fields
    (``issued_qty`` + ``source_location_node_id`` [+ ``cell_allocation_ids``])
    remain for back-compat.
    """

    model_config = ConfigDict(extra="forbid")

    line_id: str
    # Multi-source: draw the need across one or more (location, lot) picks.
    sources: list[IssueSourceInput] = Field(default_factory=list)
    # ── Legacy single-source (used only when ``sources`` is empty) ──
    issued_qty: int | None = Field(default=None, ge=0)
    source_location_node_id: str | None = None
    # LN2 only: the exact cells to pull. Empty = bulk source, drain FIFO by
    # expiry. When present, ``issued_qty`` must equal its length (D2).
    cell_allocation_ids: list[str] = Field(default_factory=list)


class ReturnCellInput(BaseModel):
    """A free cell to place a returned unit into."""

    model_config = ConfigDict(extra="forbid")

    grid_row: int = Field(ge=1)
    grid_col: int = Field(ge=1)


class IssueRequest(BaseModel):
    """Optional body for ``POST /issue`` — the draft edits are saved here in one
    shot so the Issue button is the only write (no per-keystroke PATCH)."""

    model_config = ConfigDict(extra="forbid")

    lines: list[IssueLineInput] = Field(default_factory=list)


class ProductionDraftRequest(BaseModel):
    """Save the Production-step figures (good/scrap/output) before close-out.
    Persisted so the numbers survive a reload; the signed commit is close-out."""

    model_config = ConfigDict(extra="forbid")

    good_qty: int | None = Field(default=None, ge=0)
    scrap_qty: int | None = Field(default=None, ge=0)
    output_location_node_id: str | None = None


class AdditionalIssueRequest(BaseModel):
    """Issue extra material to a line mid-production. Prefers the multi-source
    ``sources`` list (any location/lot, KIT-004); the legacy ``qty`` [+ cells]
    pulls from the line's original source and is used only when ``sources`` is
    empty."""

    model_config = ConfigDict(extra="forbid")

    # Multi-source: one or more (location, lot) picks, like the initial issue.
    sources: list[IssueSourceInput] = Field(default_factory=list)
    # ── Legacy single-source (used only when ``sources`` is empty) ──
    qty: int | None = Field(default=None, gt=0, description="Extra quantity to issue")
    # LN2 only: the exact cells to pull; ``qty`` must equal its length.
    cell_allocation_ids: list[str] = Field(default_factory=list)


class ReturnSourceInput(BaseModel):
    """One (floor lot → storage) return pick (client 2026-07-24): hand back ``qty``
    of a specific on-floor lot to a chosen location, mirroring the Issue picker.
    The units keep their origin lot (TRX-008: moved back, never re-minted)."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str = Field(description="Which on-floor lot's units to return")
    qty: int = Field(gt=0, description="How many of this lot to hand back")
    return_location_node_id: str = Field(description="Storage node the material goes back to")
    # Required when the return target is a box: one free cell per returned unit.
    return_cells: list[ReturnCellInput] = Field(default_factory=list)


class ReturnExcessRequest(BaseModel):
    """Return excess material from the floor back into inventory
    (REQ-2026-07-01-TRX-008). Prefers the multi-source ``sources`` list — the
    operator picks which on-floor LOT to return and where (client 2026-07-24), so
    each pick keeps its origin lot and nothing is stranded. The legacy single
    ``qty`` + ``return_location_node_id`` (FIFO across the floor's lots) is used
    only when ``sources`` is empty."""

    model_config = ConfigDict(extra="forbid")

    # Multi-source: one or more (floor lot, destination) picks.
    sources: list[ReturnSourceInput] = Field(default_factory=list)
    # ── Legacy single (used only when ``sources`` is empty) ──
    qty: int | None = Field(default=None, gt=0, description="How much to hand back (≤ on-floor qty)")
    return_location_node_id: str | None = Field(
        default=None, description="Storage node the material goes back to"
    )
    # Required when the return target is a box: one free cell per returned unit.
    return_cells: list[ReturnCellInput] = Field(default_factory=list)
    reason: str | None = Field(default=None, max_length=512)


class CloseOutLineInput(BaseModel):
    """Per-component close-out: the material used (≥ recipe need, ≤ on-floor) and
    where the leftover back-flushes."""

    model_config = ConfigDict(extra="forbid")

    line_id: str
    used_qty: int = Field(ge=0, description="Material consumed by the final batch")
    return_location_node_id: str | None = Field(
        default=None, description="Where leftover returns; defaults to the source"
    )
    # Required when the leftover returns into a box: one free cell per unit.
    return_cells: list[ReturnCellInput] = Field(default_factory=list)


class ProduceLineInput(BaseModel):
    """One component's material consumed by a produce batch (operator-entered)."""

    model_config = ConfigDict(extra="forbid")

    line_id: str
    used_qty: int = Field(ge=0, description="Material consumed for THIS batch")


class OutputDestinationInput(BaseModel):
    """One place a produced batch is stocked. Split a batch across several when a
    single box can't hold every unit (client 2026-07-23): the rest of the good
    units go to another box, a freezer, or a shelf. The units stay ONE lot (same
    batch, same expiry) allocated across the destinations.

    A box destination lists one free ``cells`` entry per unit (``len == qty``); a
    shelf / freezer takes ``qty`` only (no cells)."""

    model_config = ConfigDict(extra="forbid")

    location_node_id: str
    qty: int = Field(ge=1, description="Units placed at this location")
    cells: list[ReturnCellInput] = Field(default_factory=list)


class ProduceRequest(_ESignFields):
    """Produce a batch of the AY/FG **without closing the kit** (KIT-007
    incremental / serialized production): make ``good_qty`` units, leaving the
    kit open to produce more later. E-signed (action ``kit.produce``). No
    back-flush — the leftover stays on the floor for the next batch or the final
    close-out.

    The operator ENTERS the material used per component; each must be **≥ the
    recipe need** ``ceil(qty_per_unit × (good+scrap))`` (client 2026-07-23 — you
    can't make N units with less than N units' worth) and **≤ what's on the
    floor**."""

    model_config = ConfigDict(extra="forbid")

    good_qty: int = Field(ge=1, description="Good units produced in THIS batch")
    scrap_qty: int = Field(ge=0, description="Units scrapped in this batch")
    # Single-destination (legacy) output: where the whole batch is stocked, with
    # one free cell per good unit for a box. Optional when ``outputs`` is used.
    output_location_node_id: str | None = Field(
        default=None, description="Where this batch is stocked (single destination)"
    )
    output_cells: list[ReturnCellInput] = Field(default_factory=list)
    # Multi-destination output: split the good units across several locations when
    # one box can't hold them all. Overrides the single ``output_*`` fields; the
    # quantities must sum to ``good_qty``.
    outputs: list[OutputDestinationInput] = Field(default_factory=list)
    output_expiration_date: date | None = Field(
        default=None, description="Expiry of the produced AY/FG lot"
    )
    # Operator-entered lot number for this produced batch (client 2026-07-24 —
    # replaces the old auto KIT-0289-N suffix). Optional on the wire so a
    # good_qty == 0 batch can post; required-when-producing is enforced in the route.
    output_lot_number: str | None = Field(
        default=None, description="Operator-entered lot number for the produced batch"
    )
    lines: list[ProduceLineInput] = Field(
        min_length=1, description="Material consumed per component this batch"
    )


class CloseOutRequest(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    good_qty: int = Field(ge=0, description="Good finished units produced in this final batch")
    scrap_qty: int = Field(ge=0, description="Units scrapped in this final batch")
    # Single-destination (legacy) output. Optional when ``outputs`` is used, and
    # not required at all when the final batch makes 0 good units.
    output_location_node_id: str | None = Field(
        default=None, description="Where the finished quantity is stocked (single destination)"
    )
    # Required when the output target is an LN2 box (KIT-005 "LN2 tank
    # position"): one free cell per produced good unit, so ``len`` must equal
    # ``good_qty``. Empty for a shelf / freezer (bulk placement).
    output_cells: list[ReturnCellInput] = Field(default_factory=list)
    # Multi-destination output: split the good units across several locations when
    # one box can't hold them all (client 2026-07-23). Overrides the single
    # ``output_*`` fields; the quantities must sum to ``good_qty``.
    outputs: list[OutputDestinationInput] = Field(default_factory=list)
    # REQ-2026-07-01-INV-008 — the produced AY/FG must carry an expiration
    # date. Optional on the wire so an item with no shelf life can close out,
    # but the UI prompts for it.
    output_expiration_date: date | None = Field(
        default=None, description="Expiry of the produced AY/FG lot"
    )
    # Operator-entered lot number for the final produced batch (client 2026-07-24 —
    # replaces the old auto KIT-0289-N suffix). Optional on the wire so a
    # good_qty == 0 close (no lot minted) is valid; required-when-producing is
    # enforced in the route.
    output_lot_number: str | None = Field(
        default=None, description="Operator-entered lot number for the produced batch"
    )
    # Optional per-line back-flush destinations for the leftover; omitted lines
    # default to the source they were pulled from.
    lines: list[CloseOutLineInput] = Field(default_factory=list)


class CancelLineInput(BaseModel):
    """Where one line's on-floor material goes when the kit is cancelled."""

    model_config = ConfigDict(extra="forbid")

    line_id: str
    return_location_node_id: str
    return_cells: list[ReturnCellInput] = Field(default_factory=list)


class CancelRequest(_ESignFields):
    """Cancelling a kit is electronically signed (client 2026-07-22) — it abandons
    the batch and, post-issue, returns material to inventory. Carries the e-sign
    ``evidence_id`` + optional ``reason`` from ``_ESignFields``."""

    model_config = ConfigDict(extra="forbid")

    # Per-line return destinations (D1). Omitted → each line falls back to its
    # return/source location. When supplied it must cover every line still
    # holding material, so the UI can never silently drop a component.
    lines: list[CancelLineInput] = Field(default_factory=list)
