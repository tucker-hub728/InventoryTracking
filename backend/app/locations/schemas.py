"""Pydantic schemas for the location system API."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

NodeType = Literal[
    "tank_quadrant", "rack", "cassette_rack", "box", "sub_slot", "flat"
]
FlatCategory = Literal["kanban", "lab", "qc", "engineering", "materials"]
MovementKind = Literal["place", "transfer", "consume"]


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

    * ``tank_quadrant`` and ``flat`` are roots (``parent_id`` must be null);
      ``flat`` requires ``flat_category``.
    * ``rack`` → parent ``tank_quadrant``; ``cassette_rack`` → ``rack``;
      ``box`` → ``cassette_rack``; ``sub_slot`` → ``box``.
    """

    model_config = ConfigDict(extra="forbid")

    node_type: NodeType
    code: Annotated[str, _trim_nonblank("code")] = Field(max_length=64)
    name: Annotated[str, _trim_nonblank("name")] = Field(max_length=128)
    parent_id: str | None = None
    flat_category: FlatCategory | None = None
    notes: str | None = Field(default=None, max_length=2048)


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
    qty: Decimal
    is_active: bool
    created_at: datetime


class PlaceRequest(BaseModel):
    """Place (map) a lot into a destination storage node (§8).

    ``node_id`` must be a ``sub_slot`` or a ``flat`` node. For a sub_slot,
    ``qty`` must be 1 and the slot must be empty unless ``override`` is set
    (requires the override permission).
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    node_id: str
    qty: Decimal = Field(gt=Decimal("0"))
    override: bool = False
    notes: str | None = Field(default=None, max_length=2048)


class TransferRequest(BaseModel):
    """Move a quantity from one allocation to another location (§9).

    Lot identity and hierarchy are untouched — only allocation rows change
    and a movement is logged.
    """

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    to_node_id: str
    qty: Decimal = Field(gt=Decimal("0"))
    override: bool = False
    notes: str | None = Field(default=None, max_length=2048)


class ConsumeRequest(BaseModel):
    """Consume a quantity out of an allocation (location → OUT, §9)."""

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    qty: Decimal = Field(gt=Decimal("0"))
    notes: str | None = Field(default=None, max_length=2048)


class MovementRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    lot_id: str
    lot_number: str | None = None
    movement_kind: MovementKind
    from_node_id: str | None
    from_node_name: str | None = None
    to_node_id: str | None
    to_node_name: str | None = None
    qty: Decimal
    notes: str | None
    performed_by_user_id: str
    performed_at: datetime


# Resolve the forward reference for the nested tree model.
NodeTreeRead.model_rebuild()
