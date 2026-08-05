"""Pydantic schemas for the location system API."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from app.core.bounds import MAX_QTY

# All node types accepted on read (includes retired ``cassette`` /
# ``cryo_box_rack`` / ``cassette_rack`` / ``sub_slot`` / ``flat`` so any legacy
# rows still serialise).
NodeType = Literal[
    "tank",
    "tank_quadrant",
    "rack",
    "cassette",
    "cryo_box_rack",
    "box",
    "room",
    "room_location",
    "sub_location",
    "warehouse",
    "shelf",
    "flat",
    "cassette_rack",
    "sub_slot",
]
# Only these are creatable via the API (§4.1 — legacy types are retired).
# ``flat`` is retired. Rooms and the warehouse (with its A–Z shelves) stay
# seed-managed — the client's building does not gain rooms on a whim.
#
# ``room_location`` IS creatable: REQ-2026-07-15-LOC-002 says Cold Storage
# covers −20 °C, −80 °C and 2–8 °C refrigerators, and LOC-004 leaves the
# refrigerator list outstanding, so the client adds those groups themselves.
# LOC-006 restricts that to Super Admin, enforced in the route.
CreatableNodeType = Literal[
    "tank",
    "tank_quadrant",
    "rack",
    "box",
    "room_location",
    "sub_location",
]
# Legacy — kept so pre-existing flat rows still read; not creatable.
FlatCategory = Literal[
    "kanban", "lab", "qc", "engineering", "materials", "production"
]
# Ledger movement kinds surfaced for a node's click-through history.
MovementType = Literal[
    "receipt", "dispense", "discard", "adjustment", "transfer_out", "transfer_in"
]


def _trim_nonblank(field: str):
    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        if not s:
            raise ValueError(f"{field} must not be blank")
        return s

    return BeforeValidator(_check)


# ── Nodes ───────────────────────────────────────────────────────────────


class NodeCreate(BaseModel):
    """Create one node. The route enforces the strict parent-type rule:

    * ``tank`` and ``room`` are the roots (``parent_id`` must be null); a room
      is seed-managed, so ``tank`` is the only creatable root.
    * ``tank_quadrant`` → ``tank`` (at most four); ``rack`` → ``tank_quadrant``;
      ``box`` → ``rack``.

    A Box requires ``grid_rows`` / ``grid_cols``. Dedication is only valid on a
    ``tank_quadrant``. ``flat``, ``cassette`` and ``cryo_box_rack`` are retired
    and cannot be created.
    """

    model_config = ConfigDict(extra="forbid")

    node_type: CreatableNodeType
    code: Annotated[str, _trim_nonblank("code")] = Field(max_length=64)
    name: Annotated[str, _trim_nonblank("name")] = Field(max_length=128)
    parent_id: str | None = None
    grid_rows: int | None = Field(default=None, ge=1, le=400)
    grid_cols: int | None = Field(default=None, ge=1, le=400)
    dedicated_customer_id: str | None = None
    dedicated_product_id: str | None = None
    notes: str | None = Field(default=None, max_length=2048)


class NodeUpdateRequest(BaseModel):
    """Rename a node. Only the user-facing ``name`` is editable here; the
    ``code`` identity and type are immutable. Parentage moves via
    ``PATCH /location-nodes/{id}/parent``."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trim_nonblank("name")] = Field(max_length=128)


class NodeMoveRequest(BaseModel):
    """Re-hang a node under a different parent (REQ-2026-07-22-LOC-004).

    The subtree follows automatically — only this node's ``parent_id`` changes.
    The new parent must be of the type this node's level hangs under, so a rack
    can move to another quadrant but never onto a box.
    """

    model_config = ConfigDict(extra="forbid")

    parent_id: str


class ProductionAreaCreate(BaseModel):
    """Create one production area (a ``flat`` node, ``flat_category='production'``).

    Production is seeded to cover the client's existing spaces; a new area is
    added by an admin on request (SRS 2026-07-22). Only the ``name`` is given —
    the ``code`` is generated server-side from it, and the type/category/root
    placement are fixed. Renaming afterwards uses ``NodeUpdateRequest``."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trim_nonblank("name")] = Field(max_length=128)


class GridUpdateRequest(BaseModel):
    """Resize a Box's grid. Rejected if it would orphan a placed cell."""

    model_config = ConfigDict(extra="forbid")

    grid_rows: int = Field(ge=1, le=400)
    grid_cols: int = Field(ge=1, le=400)


class DedicationUpdateRequest(BaseModel):
    """Set / clear a quadrant's dedication (customer XOR product; both null
    clears it)."""

    model_config = ConfigDict(extra="forbid")

    dedicated_customer_id: str | None = None
    dedicated_product_id: str | None = None

    @model_validator(mode="after")
    def _exclusive(self) -> DedicationUpdateRequest:
        if self.dedicated_customer_id and self.dedicated_product_id:
            raise ValueError(
                "A quadrant may be dedicated to a customer OR a product, not both"
            )
        return self


class NodeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_id: str | None
    node_type: NodeType
    flat_category: FlatCategory | None
    code: str
    name: str
    is_active: bool
    notes: str | None
    grid_rows: int | None = None
    grid_cols: int | None = None
    dedicated_customer_id: str | None = None
    dedicated_product_id: str | None = None
    # Resolved from the nearest ancestor quadrant (for descendants of a
    # dedicated quadrant); equal to the node's own value on the quadrant.
    inherited_customer_id: str | None = None
    inherited_product_id: str | None = None
    # Convenience flags for the UI.
    can_store: bool = False
    child_count: int = 0
    active_allocation_count: int = 0
    # Full breadcrumb from the root (e.g. "Q1 › R01 › Cassette 01 › Box 03").
    # Populated where the UI needs to disambiguate a node by its ancestry
    # (e.g. the transfer-destination picker); null elsewhere.
    path: str | None = None
    created_at: datetime
    updated_at: datetime


class NodeTreeRead(NodeRead):
    """A node with its children nested (LN2 tree view)."""

    children: list[NodeTreeRead] = Field(default_factory=list)


# ── Allocations ─────────────────────────────────────────────────────────


class AllocationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    lot_id: str
    lot_number: str | None = None
    # The item's UUID — item detail URLs key on it, so the UI can link straight
    # to the canonical page instead of resolving the (derived) number first.
    item_id: str | None = None
    item_number: str | None = None
    location_node_id: str
    location_name: str | None = None
    location_node_type: NodeType | None = None
    grid_row: int | None = None
    grid_col: int | None = None
    qty: int
    is_active: bool
    created_at: datetime


class PlaceRequest(BaseModel):
    """Place a lot into a destination storage node — the unit-IN (§3).

    For a Box, ``grid_row`` / ``grid_col`` are required, must be within the
    Box's grid, and ``qty`` must be 1 (one unit per cell); the cell must be
    empty unless ``override`` is set (requires the override permission). For a
    flat node, coordinates must be omitted and ``qty`` may be > 1.

    Placement is the inbound quantity event: it posts a ``+qty`` ``receipt``
    movement to the GxP ledger (on-hand becomes ledger-derived) AND writes an
    allocation. E-signed — ``evidence_id`` (action ``movement.receipt``) is
    required; a comment is optional. Total placed for a lot may not exceed its
    ``ordered_qty`` (when set).
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    node_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    grid_row: int | None = Field(default=None, ge=1, le=400)
    grid_col: int | None = Field(default=None, ge=1, le=400)
    override: bool = False
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class BatchCell(BaseModel):
    """One target cell in a multi-cell box placement (one unit per cell)."""

    model_config = ConfigDict(extra="forbid")

    grid_row: int = Field(ge=1, le=400)
    grid_col: int = Field(ge=1, le=400)


class PlaceBatchRequest(BaseModel):
    """Place one lot into several Box cells in a single e-signed action (§3).

    Each listed cell receives exactly one unit; the whole batch is authorised
    by ONE re-authentication (``evidence_id``, action ``movement.receipt``); a
    comment is optional. Cells must be distinct, within the Box grid, and empty
    unless ``override`` is set. The lifetime cap (total placed ≤ ``ordered_qty``)
    applies across the batch.
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    node_id: str
    cells: list[BatchCell] = Field(min_length=1, max_length=400)
    override: bool = False
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _distinct_cells(self) -> PlaceBatchRequest:
        seen = {(c.grid_row, c.grid_col) for c in self.cells}
        if len(seen) != len(self.cells):
            raise ValueError("Cells must be distinct")
        return self


class ConsumeBatchRequest(BaseModel):
    """Consume several box-cell allocations of ONE lot in a single e-signed
    action (§3). All source allocations must share the same lot and source
    node; the whole batch posts a single ``dispense`` of the summed quantity
    (the ledger shows "units out N", not N×1). ``to_node_id`` is the Flat
    location that used the units.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_ids: list[str] = Field(min_length=1, max_length=400)
    to_node_id: str
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class TransferBatchRequest(BaseModel):
    """Move units of ONE lot to a destination, signed once (§3 Transfer).

    Source = one or more allocations sharing a lot + source node. The
    destination decides how quantity is expressed:

    * **Box** (grid): ``to_cells`` lists the exact empty cells to fill, one
      unit each — quantity = ``len(to_cells)``. ``qty`` must be null.
    * **Flat**: ``qty`` is the number of units to move; ``to_cells`` must be
      empty.

    The whole batch posts a single ``transfer_out`` / ``transfer_in`` pair of
    the moved quantity.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_ids: list[str] = Field(min_length=1, max_length=400)
    to_node_id: str
    to_cells: list[BatchCell] = Field(default_factory=list, max_length=400)
    qty: int | None = Field(default=None, gt=0, le=MAX_QTY)
    override: bool = False
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _distinct_cells(self) -> TransferBatchRequest:
        seen = {(c.grid_row, c.grid_col) for c in self.to_cells}
        if len(seen) != len(self.to_cells):
            raise ValueError("Destination cells must be distinct")
        return self


class TransferSourceInput(BaseModel):
    """One leg of a transfer: a quantity of ONE lot at ONE storage node, and the
    ONE destination it moves to.

    The destination lives on the source, not on the request, so a transfer that
    draws from several places can send each to a different one — 10 vials off
    Shelf C into a box, 5 off Shelf D onto Shelf F, one signature. The operator
    states the mapping rather than the system inferring it, which matches the
    physical act they are signing for (client 2026-08-05).

    For an LN2 box SOURCE, ``cell_allocation_ids`` names the exact vials and
    ``qty`` must equal their count; for a bulk shelf / freezer lot the quantity
    drains that lot's allocations there FIFO. For a box DESTINATION,
    ``to_cells`` lists one free cell per unit (``len == qty``); a flat
    destination takes no cells.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    lot_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    cell_allocation_ids: list[str] | None = None
    to_node_id: str
    to_cells: list[BatchCell] = Field(default_factory=list, max_length=400)


class TransferMultiRequest(BaseModel):
    """Move ONE item's stock from SEVERAL lots / locations, each to its own
    destination, signed once (REQ-2026-07-15-TRX-001 as refined 2026-07-22).

    This is the inventory-workspace transfer: the operator opens an item, sees
    where it is stocked, and moves stock without first navigating to a location.
    ``/transfer`` and ``/transfer-batch`` keep serving the within-location path,
    which starts from an allocation the operator already has in front of them.

    Every source must resolve to the same item; each carries its own
    ``to_node_id`` (see :class:`TransferSourceInput`). A source whose
    destination is its own location is rejected — moving within one box or
    shelf is the single-allocation ``/transfer`` path.

    Posts one ``transfer_out`` / ``transfer_in`` pair **per source** (a pair
    carries a single lot, a single source and a single destination), all
    authorised by the one signature — ``evidence_id`` (action
    ``movement.transfer``).
    """

    model_config = ConfigDict(extra="forbid")

    sources: list[TransferSourceInput] = Field(min_length=1, max_length=100)
    override: bool = False
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _distinct_cells(self) -> TransferMultiRequest:
        # One lot × location MAY appear on several legs — that is how a shelf
        # holding 5 units empties into a box with only 4 free cells, the rest
        # going elsewhere. The draw is sequential and each leg re-reads what is
        # left, so the total can never exceed what is actually there.
        #
        # Two legs sending units to the SAME cell is a different matter: caught
        # here rather than at the unique index, which would surface as a 500.
        cells = [(s.to_node_id, c.grid_row, c.grid_col) for s in self.sources for c in s.to_cells]
        if len(set(cells)) != len(cells):
            raise ValueError("Destination cells must be distinct")
        return self


class ItemStockLocationCell(BaseModel):
    """One occupied vial position in an LN2 box — exactly one unit of one lot
    (``uq_lot_allocations_cell``), so the transfer dialog can draw the box and
    the operator taps the exact vials to move."""

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    grid_row: int
    grid_col: int
    lot_id: str
    lot_number: str | None = None
    expiration_date: date | None = None


class ItemStockLocationRead(BaseModel):
    """Where one item is stocked, a row per **(lot × storage location)**.

    Powers the item drill-down's "Stock by location" tab (REQ-2026-07-01-INV-007
    — "drilling into a finished good shall reveal its storage location(s)") and
    the transfer dialog's source picker (TRX-001). Rows arrive FIFO-ordered
    (earliest expiry first, then oldest lot). WIP held by an open kit on a
    production floor is excluded — it is not available stock.

    Unlike ``/shipments/sources/{item_id}`` this serves **every** tier, not only
    the built ones: a raw material is transferable but never shippable.
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    lot_number: str | None
    expiration_date: date | None
    node_id: str
    # Human location path, e.g. "Warehouse One › Shelf B".
    location: str
    qty: int
    is_grid: bool = False
    grid_rows: int | None = None
    grid_cols: int | None = None
    cells: list[ItemStockLocationCell] = []


class LotAvailabilityRead(BaseModel):
    """How much of a lot may still be placed — for the unit-in lot picker.

    ``remaining`` is ``ordered_qty - placed`` (lifetime unit-in), or null when
    the lot has no ``ordered_qty`` cap (placement is unbounded).
    """

    lot_id: str
    ordered_qty: int | None = None
    placed: int = 0
    remaining: int | None = None


class TransferRequest(BaseModel):
    """Move a quantity from one allocation to another node cell (§3 Transfer).

    Recorded in the GxP ledger as a ``transfer_out`` / ``transfer_in`` pair —
    e-signed, so ``evidence_id`` (action ``movement.transfer``) is required; a
    comment is optional.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    to_node_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    to_grid_row: int | None = Field(default=None, ge=1, le=400)
    to_grid_col: int | None = Field(default=None, ge=1, le=400)
    override: bool = False
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class ConsumeRequest(BaseModel):
    """Consume a unit out of an allocation (location → OUT, §3).

    A real unit-out: posts a ``dispense`` ledger movement (``qty_delta < 0``)
    so on-hand drops; the unit can't be used again. ``to_node_id`` is the
    **Flat location** that consumed it (e.g. a lab / Kanban) — recorded as the
    movement's destination. E-signed — ``evidence_id`` (action
    ``movement.dispense``) is required; a comment is optional.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    # The Flat location that consumed the unit (where it went).
    to_node_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class NodeMovementRead(BaseModel):
    """A ledger movement that touched a node — for the click-through history."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    lot_id: str | None = None
    lot_number: str | None = None
    # See ``AllocationRead.item_id`` — lets the UI deep-link by UUID.
    item_id: str | None = None
    item_number: str | None = None
    movement_type: MovementType
    from_location_node_id: str | None = None
    to_location_node_id: str | None = None
    qty_delta: int
    notes: str | None
    performed_by_user_id: str
    performed_at: datetime


# Resolve the forward reference for the nested tree model.
NodeTreeRead.model_rebuild()
