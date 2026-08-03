"""Request / response schemas for the customer-shipment endpoint."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.bounds import MAX_QTY


class ShipCell(BaseModel):
    """One occupied vial position in an LN2 box — exactly one unit of one lot
    (``uq_lot_allocations_cell``). The operator taps these to choose *which*
    vials leave; the recorded location stays the box (D4)."""

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    grid_row: int
    grid_col: int
    lot_id: str
    lot_number: str | None = None
    expiration_date: date | None = None


class ShipSourceRead(BaseModel):
    """One shippable source row for a finished good — a lot at a storage
    location with its available quantity. Powers the ship dialog's source
    picker; production (WIP) nodes are excluded upstream.

    For an LN2 box the row is a grid: ``is_grid`` is true, ``grid_rows`` /
    ``grid_cols`` give the geometry, and ``cells`` are this lot's occupied vials
    so the dialog can draw the box and the operator taps the exact vials to ship
    (same as the kitting Issue step)."""

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
    cells: list[ShipCell] = []


class ShipSourceInput(BaseModel):
    """One source pick for a shipment — a quantity of one lot at one storage
    node. A shipment may draw from SEVERAL sources when the finished good is
    spread across locations (mirrors the kitting multi-source Issue). For an LN2
    box, ``cell_allocation_ids`` names the exact vials and ``qty`` must equal
    their count; for a bulk shelf / freezer lot the quantity drains FIFO."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    lot_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    cell_allocation_ids: list[str] | None = None


class ShipOutRequest(BaseModel):
    """Ship a finished good OUT to a customer — the terminal transaction
    (CUST-001 / TRX-005). The finished good leaves inventory (TRX-006 — no
    cascade to components).

    ``customer_id`` is **required** — every shipment names a customer (client
    decision; the earlier catalog / no-customer path is removed).
    ``reference_number`` is the free-text tracking / sales-order number (TRX-005).

    E-signed — ``evidence_id`` (action ``movement.customer_shipment``) is
    required; a comment is optional.
    """

    model_config = ConfigDict(extra="forbid")

    sources: list[ShipSourceInput] = Field(min_length=1)
    customer_id: str
    reference_number: str | None = Field(default=None, max_length=256)
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class ShipmentLine(BaseModel):
    """One lot that a shipment drew from."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    lot_number: str | None
    qty: int


class ShipmentRead(BaseModel):
    """The result of a shipment — the customer, reference, and the per-lot
    breakdown of what left inventory."""

    model_config = ConfigDict(extra="forbid")

    item_id: str
    item_number: str
    total_qty: int
    customer_id: str
    customer_name: str
    reference_number: str | None
    performed_at: datetime
    lines: list[ShipmentLine]
