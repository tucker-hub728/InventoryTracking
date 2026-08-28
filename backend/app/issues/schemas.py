"""Request / response schemas for the material-issue endpoint.

Deliberately the same shape as ``app.shipments.schemas`` — an issue and a
shipment are the same transaction from inventory's point of view (draw from N
sources, sign once, stock leaves) and differ only in where it went. Keeping the
shapes aligned is what lets the ship and issue dialogs share the source picker.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.bounds import MAX_QTY


class IssuedSummaryRow(BaseModel):
    """What one debit-and-gone location has consumed, for the Storage cards.

    A card for such a location cannot show "units held" — it holds none by
    definition — so it shows what it has TAKEN instead: how much, over how many
    transactions, and when last. Those are the only facts about it that change.
    """

    node_id: str
    issue_count: int
    total_qty: int
    last_issued_at: datetime | None = None


class IssueDestinationRead(BaseModel):
    """One location material may be issued to — a scrap location.

    ``path`` is the full breadcrumb ("Storage › QC 1 Analytical Lab") so the
    picker can tell two similarly-named labs apart, exactly as the Kanban
    destination list does.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    name: str
    code: str
    path: str


class IssueCell(BaseModel):
    """One occupied vial position in an LN2 box — exactly one unit of one lot.
    The operator taps these to choose *which* vials leave; the recorded source
    location stays the box."""

    model_config = ConfigDict(extra="forbid")

    allocation_id: str
    grid_row: int
    grid_col: int
    lot_id: str
    lot_number: str | None = None
    expiration_date: date | None = None


class IssueSourceRead(BaseModel):
    """One issuable source row — a lot at a storage location with its available
    quantity. Powers the issue dialog's source picker.

    For an LN2 box the row is a grid: ``is_grid`` is true, ``grid_rows`` /
    ``grid_cols`` give the geometry, and ``cells`` are this lot's occupied vials
    so the dialog can draw the box and the operator taps the exact vials. A
    consumable CAN sit in an LN2 box (client 2026-08-11), so this is carried
    through for every item rather than assumed away."""

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
    cells: list[IssueCell] = []


class IssueSourceInput(BaseModel):
    """One source pick — a quantity of one lot at one storage node. An issue may
    draw from SEVERAL sources when the item is spread across locations. For an
    LN2 box, ``cell_allocation_ids`` names the exact vials and ``qty`` must equal
    their count; for a bulk shelf / freezer lot the quantity drains FIFO."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    lot_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    cell_allocation_ids: list[str] | None = None


class IssueRequest(BaseModel):
    """Issue material to a scrap location — debit-and-gone (TRX-001/002).

    ``destination_node_id`` is the LOCATION (PD, R&D, QC 1), not a shelf or a
    freezer inside it. A sub-location is rejected: storing the material there
    would contradict the very thing this transaction records.

    E-signed — ``evidence_id`` (action ``movement.material_issue``) is required;
    a comment is optional, as it is for every other flow.
    """

    model_config = ConfigDict(extra="forbid")

    sources: list[IssueSourceInput] = Field(min_length=1)
    destination_node_id: str
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class IssuedRow(BaseModel):
    """One thing that was issued to a location — a row of the disposition log.

    Deliberately NOT an allocation shape. There is no ``location_node`` field to
    drill into, no ``is_active``, and no running balance, because none of those
    exist: the material left inventory when this row was written. It is history,
    and the only questions it answers are what, how much, from where, by whom and
    when.

    Everything is read off the ``material_issue`` movement — the ledger is
    append-only, so a copy could only drift, and the same reasoning already keeps
    ``app.consumable_issues`` down to six columns.
    """

    model_config = ConfigDict(extra="forbid")

    movement_id: str
    item_id: str
    item_number: str
    item_description: str | None = None
    lot_id: str | None = None
    lot_number: str | None = None
    qty: int
    # Where it was drawn FROM — the shelf / freezer / box that lost the stock.
    # A disposition log without this cannot answer "where did it go from".
    source_path: str | None = None
    #: The source shelf itself, so the log can link back to the place the material
    #: came FROM. This is not the drill-into-a-holding field the docstring rules
    #: out — that would be the destination, which holds nothing. The source is a
    #: real location that still exists and still has a page.
    source_node_id: str | None = None
    issued_at: datetime
    issued_by: str | None = None
    notes: str | None = None


class IssuedListResponse(BaseModel):
    """A page of the disposition log, plus the totals for the whole log.

    ``total_qty`` counts every unit ever issued here, not just this page — a
    "units issued" figure that changed when you turned the page would be worse
    than no figure at all.
    """

    model_config = ConfigDict(extra="forbid")

    items: list[IssuedRow]
    total: int
    total_qty: int
    limit: int
    offset: int


class IssueLine(BaseModel):
    """One lot that an issue drew from."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    lot_number: str | None
    qty: int


class IssueRead(BaseModel):
    """The result of an issue — where it went and the per-lot breakdown of what
    left inventory."""

    model_config = ConfigDict(extra="forbid")

    item_id: str
    item_number: str
    total_qty: int
    destination_node_id: str
    destination_name: str
    destination_path: str
    performed_at: datetime
    lines: list[IssueLine]
