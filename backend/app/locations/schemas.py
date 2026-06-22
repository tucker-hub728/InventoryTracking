"""Pydantic schemas for the location system API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

# All node types accepted on read (includes retired ``cassette_rack`` /
# ``sub_slot`` so any legacy rows still serialise).
NodeType = Literal[
    "tank_quadrant",
    "rack",
    "cassette",
    "cryo_box_rack",
    "box",
    "flat",
    "cassette_rack",
    "sub_slot",
]
# Only these are creatable via the API (§4.1 — legacy types are retired).
CreatableNodeType = Literal[
    "tank_quadrant", "rack", "cassette", "cryo_box_rack", "box", "flat"
]
FlatCategory = Literal["kanban", "lab", "qc", "engineering", "materials"]
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


# A required, non-blank comment — used on e-signed operations (§3: comments
# are mandatory on transactions requiring an electronic signature).
def _required_comment(v: str) -> str:
    s = (v or "").strip()
    if not s:
        raise ValueError("A comment is required for this action")
    return s


RequiredComment = Annotated[str, BeforeValidator(_required_comment), Field(max_length=2048)]


# ── Nodes ───────────────────────────────────────────────────────────────


class NodeCreate(BaseModel):
    """Create one node. The route enforces the strict parent-type rule:

    * ``tank_quadrant`` and ``flat`` are roots (``parent_id`` must be null);
      ``flat`` requires ``flat_category``.
    * ``rack`` → ``tank_quadrant``; ``cassette`` / ``cryo_box_rack`` → ``rack``;
      ``box`` → ``cassette`` **or** ``cryo_box_rack``.

    A Box requires ``grid_rows`` / ``grid_cols`` (a Box under a Cassette must
    have ``grid_cols == 1``). Dedication is only valid on a ``tank_quadrant``.
    """

    model_config = ConfigDict(extra="forbid")

    node_type: CreatableNodeType
    code: Annotated[str, _trim_nonblank("code")] = Field(max_length=64)
    name: Annotated[str, _trim_nonblank("name")] = Field(max_length=128)
    parent_id: str | None = None
    flat_category: FlatCategory | None = None
    grid_rows: int | None = Field(default=None, ge=1, le=400)
    grid_cols: int | None = Field(default=None, ge=1, le=400)
    dedicated_customer_id: str | None = None
    dedicated_product_id: str | None = None
    notes: str | None = Field(default=None, max_length=2048)


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
    allocation. E-signed — ``evidence_id`` (action ``movement.receipt``) and a
    comment are required. Total placed for a lot may not exceed its
    ``ordered_qty`` (when set).
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    node_id: str
    qty: int = Field(gt=0)
    grid_row: int | None = Field(default=None, ge=1, le=400)
    grid_col: int | None = Field(default=None, ge=1, le=400)
    override: bool = False
    evidence_id: str
    notes: RequiredComment


class TransferRequest(BaseModel):
    """Move a quantity from one allocation to another node cell (§3 Transfer).

    Recorded in the GxP ledger as a ``transfer_out`` / ``transfer_in`` pair —
    e-signed, so ``evidence_id`` (action ``movement.transfer``) and a comment
    are required.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    to_node_id: str
    qty: int = Field(gt=0)
    to_grid_row: int | None = Field(default=None, ge=1, le=400)
    to_grid_col: int | None = Field(default=None, ge=1, le=400)
    override: bool = False
    evidence_id: str
    notes: RequiredComment


class ConsumeRequest(BaseModel):
    """Consume a unit out of an allocation (location → OUT, §3).

    A real unit-out: posts a ``dispense`` ledger movement (``qty_delta < 0``)
    so on-hand drops; the unit can't be used again. ``to_node_id`` is the
    **Flat location** that consumed it (e.g. a lab / Kanban) — recorded as the
    movement's destination. E-signed — ``evidence_id`` (action
    ``movement.dispense``) and a comment are required.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    # The Flat location that consumed the unit (where it went).
    to_node_id: str
    qty: int = Field(gt=0)
    evidence_id: str
    notes: RequiredComment


class NodeMovementRead(BaseModel):
    """A ledger movement that touched a node — for the click-through history."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    lot_id: str | None = None
    lot_number: str | None = None
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
