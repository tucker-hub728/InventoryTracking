"""Pydantic schemas for the Kitting / back-flush API.

Implements ``docs/modules/kitting.md``. Reads use ``from_attributes``; writes
use ``extra='forbid'``. Only **close-out** is electronically signed (client
2026-07-20) — it carries the ``_ESignFields``; issue / additional issue /
cancel are unsigned.
"""

from __future__ import annotations

from datetime import datetime
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


class KitLineSourceOption(BaseModel):
    """A location that currently holds the component, with its available qty."""

    node_id: str
    name: str
    path: str
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
    # Derived = issued + additional − used (null until used is entered).
    returned_qty: int | None = None
    source_location_node_id: str | None = None
    return_location_node_id: str | None = None
    # Location-System stock for this component (from lot_allocations).
    on_hand: int = 0
    source_options: list[KitLineSourceOption] = Field(default_factory=list)
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
    good_qty: int | None = None
    scrap_qty: int | None = None
    line_count: int = 0
    created_at: datetime


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


class KitActivityResponse(BaseModel):
    items: list[KitActivityRow] = Field(default_factory=list)


# ── Writes ──────────────────────────────────────────────────────────────


class KitCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(description="The sub-assembly or finished good to build")
    target_qty: int = Field(gt=0, description="How many to build")
    production_location_node_id: str = Field(
        description="Advisory production floor (a real location node)"
    )
    notes: str | None = Field(default=None, max_length=2048)


class KitLineUpdateRequest(BaseModel):
    """Edit a draft line's issued quantity and/or source location."""

    model_config = ConfigDict(extra="forbid")

    issued_qty: int | None = Field(default=None, ge=0)
    source_location_node_id: str | None = None


class IssueLineInput(BaseModel):
    """A line's final issued qty + source, committed with the Issue action."""

    model_config = ConfigDict(extra="forbid")

    line_id: str
    issued_qty: int = Field(ge=0)
    source_location_node_id: str | None = None


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
    model_config = ConfigDict(extra="forbid")

    qty: int = Field(gt=0, description="Extra quantity to issue mid-production")


class CloseOutLineInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line_id: str
    used_qty: int = Field(ge=0, description="Actual quantity consumed (from the traveler)")
    return_location_node_id: str | None = Field(
        default=None, description="Where leftover returns; defaults to the source"
    )


class CloseOutRequest(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    good_qty: int = Field(ge=0, description="Good finished units produced")
    scrap_qty: int = Field(ge=0, description="Units scrapped in production")
    output_location_node_id: str = Field(description="Where the finished quantity is stocked")
    lines: list[CloseOutLineInput] = Field(
        min_length=1, description="Actual used quantity per component line"
    )


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=512)
