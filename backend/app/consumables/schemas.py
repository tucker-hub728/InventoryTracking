"""Request / response schemas for the consumables endpoints."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.bounds import MAX_QTY
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

    Not e-signed — 07-09 TRX-006 asks for "a simple acknowledgment", and the
    quantity does not move. It is recorded in the audit trail all the same.

    ``disposition`` is §4.2's outcome: the product was ``consumed`` before its
    date, or it is still in the room and has been ``reworked`` / ``retested`` /
    ``discarded``."""

    model_config = ConfigDict(extra="forbid")

    disposition: Disposition
    note: str | None = Field(default=None, max_length=2048)


class ExpiryPolicyRead(BaseModel):
    """The configured warning lead time (LOC-008 vs TX Spec §4.2 — see
    :data:`app.models.settings.CONSUMABLE_EXPIRY_WARN_DAYS`)."""

    model_config = ConfigDict(extra="forbid")

    warn_days: int


class ExpiryPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    warn_days: int = Field(ge=0, le=3650)
