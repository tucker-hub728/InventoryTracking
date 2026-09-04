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
    # The lot's release state (STS-001), so the ship dialog can warn before a
    # rejected batch goes out to a customer (client 2026-08-17). Null where no
    # release workflow applies.
    release_state: str | None = None
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


# ── Per-customer shipment history (read-only) ──────────────────────────
#
# CUST-003: this ledger is read-only. Every schema below is a RESPONSE — there is
# no request shape here, and no route that writes one, because nothing about a
# recorded shipment can be edited. Corrections are new ledger rows, which is what
# the append-only trigger on ``app.stock_movements`` says in its own error text.


class CustomerShippedTotals(BaseModel):
    """One customer's lifetime shipping figures, for the customers list.

    Customers never shipped to are absent from the response rather than present
    with zeroes — the list renders the dash from the gap, so "never shipped to"
    stays visibly different from a customer whose history exists.
    """

    model_config = ConfigDict(extra="forbid")

    customer_id: str
    shipment_count: int
    total_qty: int
    last_shipped_at: datetime | None


class CustomerShippedItemRow(BaseModel):
    """One item this customer has been sent, with its lifetime total.

    ``item_number`` is empty and ``item_description`` None only when the item was
    hard-deleted out from under its own ledger rows. The row survives anyway: the
    units left the building, and dropping it would silently shrink the total.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    item_number: str
    item_description: str | None
    total_qty: int
    shipment_count: int
    last_shipped_at: datetime | None


class CustomerShippedItemsResponse(BaseModel):
    """The by-item rollup — unpaged, biggest total first."""

    model_config = ConfigDict(extra="forbid")

    items: list[CustomerShippedItemRow]
    total_qty: int
    shipment_count: int


class CustomerShipmentLine(BaseModel):
    """One lot that a shipment event drew from — one ledger row.

    ``source_path`` is the location path SNAPSHOT taken when the row was written,
    not a live lookup: it must keep saying where the stock came from after that
    shelf is renamed or removed.
    """

    model_config = ConfigDict(extra="forbid")

    movement_id: str
    lot_id: str | None
    lot_number: str | None
    qty: int
    source_path: str | None
    #: The shelf itself, so the panel can link to it. Nullable only in theory —
    #: ck_movements_locations requires a FROM on a shipment — but the column is
    #: nullable, and inventing a cast for a value the schema permits to be absent
    #: is how a 500 gets written.
    source_node_id: str | None


class CustomerShipmentEvent(BaseModel):
    """One shipment — one signed operator action, not one ledger row.

    A multi-source ship posts a row per source lot in a single transaction; they
    share ``shipped_at`` exactly and are folded back together here, with the lots
    in ``lines``. ``lines`` therefore always has at least one entry.
    """

    model_config = ConfigDict(extra="forbid")

    shipped_at: datetime
    item_id: str
    item_number: str
    item_description: str | None
    total_qty: int
    reference_number: str | None
    shipped_by: str | None
    notes: str | None
    lines: list[CustomerShipmentLine]


class CustomerShipmentsResponse(BaseModel):
    """One page of shipment events, newest first.

    ``total`` counts EVENTS, not ledger rows, so it matches the rows the client
    actually renders and the pager cannot promise a page that does not exist.
    """

    model_config = ConfigDict(extra="forbid")

    items: list[CustomerShipmentEvent]
    total: int
    total_qty: int
    limit: int
    offset: int
