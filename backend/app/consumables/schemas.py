"""Request / response schemas for the consumables endpoints."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.bounds import MAX_QTY
from app.kitting.schemas import CellOption
from app.models.consumables import DISPOSITIONS

#: ``ok`` never reaches the API — a row is returned only once it warns or has
#: expired. Kept as a type so the frontend can switch on it exhaustively.
FlagState = Literal["warn", "expired"]

Disposition = Literal["consumed", "reworked", "retested", "discarded"]
assert set(DISPOSITIONS) == set(Disposition.__args__)  # type: ignore[attr-defined]


class ConsumableSourceRead(BaseModel):
    """One issuable source row — a consumable lot at a storage location with its
    available quantity. Powers the issue dialog's source picker."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    lot_number: str | None
    expiration_date: date | None
    node_id: str
    #: Human location path, e.g. "Warehouse One › Shelf B".
    location: str
    qty: int
    #: Grid-bearing (LN2 box) source: the quantity follows the vials picked, and
    #: ``cells`` carries this lot's occupied positions so the dialog can draw the
    #: box. A consumable in a cryo box is unusual but real — CR-004 sits in Tank
    #: 1 (client 2026-08-11) — so the shape mirrors
    #: :class:`app.kitting.schemas.KitLineSourceLot` rather than assuming a shelf.
    is_grid: bool = False
    grid_rows: int | None = None
    grid_cols: int | None = None
    cells: list[CellOption] = Field(default_factory=list)


class ConsumableSourceInput(BaseModel):
    """One source pick — a quantity of one lot at one storage node.

    An issue may draw from SEVERAL lots at once (the operator empties a
    part-used box before opening a fresh one). Each source becomes its own
    register row, because each carries its own expiration date — see
    :class:`app.models.consumables.ConsumableIssue`."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    lot_id: str
    qty: int = Field(gt=0, le=MAX_QTY)
    #: LN2 box source only: the exact vial allocations to empty. When given,
    #: ``qty`` must equal their count — for a box the quantity IS the selection,
    #: never a number typed beside it. Required for a grid node, since walking
    #: the lot FIFO would empty positions the operator did not pull.
    cell_allocation_ids: list[str] = Field(default_factory=list)


class ConsumableIssueRequest(BaseModel):
    """Issue a consumable to a Kanban (TRX-003, TX Spec §4).

    Terminal for quantity: the units leave inventory here and are never
    back-flushed (07-09 TRX-001/004). Their expiration keeps being tracked.

    ``kanban_node_id`` is REQUIRED and must be a Kanban node — never the
    production area itself (client 2026-08-10). E-signed: ``evidence_id``
    (action ``movement.consumable_issue``); the comment is optional.
    """

    model_config = ConfigDict(extra="forbid")

    sources: list[ConsumableSourceInput] = Field(min_length=1)
    kanban_node_id: str
    evidence_id: str
    notes: str | None = Field(default=None, max_length=2048)


class IssuedConsumableRead(BaseModel):
    """One row of the Kanban register — an issued quantity and the expiration
    that is still being tracked against it."""

    model_config = ConfigDict(extra="forbid")

    id: str
    item_id: str
    item_number: str
    item_description: str | None
    lot_number: str | None
    qty: int
    kanban_node_id: str
    kanban_name: str
    #: Full path, e.g. "Clean Room Five › Kanban 1".
    kanban_path: str
    issued_at: datetime
    issued_by: str | None
    expiration_date: date | None
    #: ``None`` while the date is comfortably in the future, or absent entirely.
    flag: FlagState | None
    #: Negative once past the date. ``None`` when there is no date to count to.
    days_to_expiry: int | None
    cleared_at: datetime | None
    cleared_by: str | None
    disposition: Disposition | None
    clear_note: str | None


class IssuedConsumableListResponse(BaseModel):
    """A page of the register / alert feed. Same envelope as the item list, so
    the shared paginator can drive it unchanged."""

    model_config = ConfigDict(extra="forbid")

    items: list[IssuedConsumableRead]
    total: int
    limit: int
    offset: int


class IssueResultLine(BaseModel):
    """One lot an issue drew from."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    lot_number: str | None
    qty: int
    expiration_date: date | None


class ConsumableIssueRead(BaseModel):
    """The result of an issue — what left, and where it went."""

    model_config = ConfigDict(extra="forbid")

    item_id: str
    item_number: str
    total_qty: int
    kanban_node_id: str
    kanban_path: str
    performed_at: datetime
    lines: list[IssueResultLine]


class AcknowledgeRequest(BaseModel):
    """Clear an expiration flag after the physical check (LOC-008, TX Spec §4.2).

    **E-signed** (client 2026-08-12): ``evidence_id``, action
    ``consumable.expiry_check``, comment optional as everywhere else. 07-09
    TRX-006 calls this "a simple acknowledgment" and no quantity moves, but the
    disposition it records is a GxP statement about material — that a lot was
    discarded, or consumed before its date — so it is attributed under Part 11
    §11.200 like every other such statement. "Simple" is read as *one step, no
    quantities to reconcile*, which the dialog still is.

    ``disposition`` is §4.2's outcome: the product was ``consumed`` before its
    date, or it is still in the room and has been ``reworked`` / ``retested`` /
    ``discarded``."""

    model_config = ConfigDict(extra="forbid")

    disposition: Disposition
    note: str | None = Field(default=None, max_length=2048)
    evidence_id: str


class ExpiryPolicyRead(BaseModel):
    """The configured warning lead time (LOC-008 vs TX Spec §4.2 — see
    :data:`app.models.settings.CONSUMABLE_EXPIRY_WARN_DAYS`)."""

    model_config = ConfigDict(extra="forbid")

    warn_days: int


class ExpiryPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    warn_days: int = Field(ge=0, le=3650)


# ── Kanban balance + restock (KAN-001) ──────────────────────────────────

RequestState = Literal["open", "fulfilled", "cancelled"]


class RestockRequestCreate(BaseModel):
    """"We are low on this in this bin." (KAN-001's "on a restock request".)

    Not e-signed: asking for more moves no stock and states nothing about
    material. The two acts that DO — acknowledging what was consumed, and
    issuing the replenishment — are both signed.
    """

    model_config = ConfigDict(extra="forbid")

    kanban_node_id: str
    item_id: str
    #: Optional — "we're low" is a legitimate request. See the column comment in
    #: ``app/models/consumables.py``.
    requested_qty: int | None = Field(default=None, gt=0, le=MAX_QTY)
    note: str | None = Field(default=None, max_length=2048)


class RestockRequestRead(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kanban_node_id: str
    kanban_path: str
    item_id: str
    item_number: str
    description: str | None = None
    requested_qty: int | None
    note: str | None
    state: RequestState
    requested_at: datetime
    requested_by: str | None = None
    closed_at: datetime | None = None
    closed_by: str | None = None
    #: What the operator confirmed was used, recorded when the request was
    #: fulfilled. Null while open or cancelled. Stored on the row: no stock
    #: moves at acknowledgment, so no ledger row carries this figure.
    consumed_qty: int | None = None
    #: How much has been issued INTO this Kanban since the request was raised —
    #: "has my restock arrived yet". Not a bin balance: a Kanban holds none.
    issued_since_qty: int = 0


class RestockRequestListResponse(BaseModel):
    """A page of requests. Same envelope as every other paged list here, so the
    shared paginator drives it unchanged."""

    model_config = ConfigDict(extra="forbid")

    items: list[RestockRequestRead]
    #: Rows matching the FILTERS, not rows on this page.
    total: int
    limit: int = 50
    offset: int = 0


class AcknowledgeConsumptionRequest(BaseModel):
    """Close a restock request (KAN-001), e-signed.

    **The signature IS the acknowledgment.** No quantity is asked for, and
    that is a decision worth recording rather than an omission.

    It was collected at first, reading KAN-001's "marks the depleted quantity
    consumed" as wanting a figure. Two things undid that. The stock was already
    debited at issue (07-09 ``TRX-001``), so no balance, report or
    reconciliation anywhere consumes the number — it is written and never read.
    And a request may legitimately carry no quantity at all ("we're low"), so
    the attestation above the signature came out as "I confirm that 0 of CR-001
    was used", which is a false sentence over a Part 11 signature. A signature
    is worth exactly what the sentence above it says.

    So what is signed is what actually happened: this request has been actioned
    and is closed, by a named person, at a known time.

    ``qty`` remains OPTIONAL on the wire rather than being deleted — an
    integration with a real consumption figure (a floor scale, a scanner) has
    somewhere to put it, and ``consumed_qty`` is nullable precisely so its
    absence is a legible state rather than a zero nobody meant.

    E-signed under its own verb ``consumable.consumption`` — deliberately not
    the issue verb and not the expiry-check verb. A signature minted to issue
    stock to a bin must not be spendable on closing out the request for it.
    """

    model_config = ConfigDict(extra="forbid")

    qty: int | None = Field(default=None, ge=0, le=MAX_QTY)
    note: str | None = Field(default=None, max_length=2048)
    evidence_id: str


