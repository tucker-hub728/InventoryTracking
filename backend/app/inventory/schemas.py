"""Pydantic schemas for the inventory API.

Reads are deliberately verbose — every column the UI list view needs is
explicit on the response model so route consumers don't reach into the
ORM. Writes accept only what the user can legitimately supply (no
``id``, no audit columns).

Quantity / status fields are *derived* — they always default to
zero / out_of_stock until the movements module ships, then become
populated from ``app.item_balances``.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

# ``item_number`` is free-form and user-supplied. Per
# docs/modules/inventory.md §3.1 / §4.1 / §9.2 the *only* backend rule is
# uniqueness (the partial-unique index ``uq_items_item_number``); there is
# deliberately **no format CHECK**. We trim, upper-case (preserving the
# existing normalisation so case-variants can't masquerade as distinct
# items), and reject blank / over-long values — everything else the user
# types is accepted, so custom alphanumeric codes like ``CM-0001A``,
# ``REF-017`` or ``WIDGET-12`` all go through.
ITEM_NUMBER_MAX_LEN = 64


def _validate_item_number(v: str) -> str:
    v = v.strip().upper()
    if not v:
        raise ValueError("item_number must not be blank")
    if len(v) > ITEM_NUMBER_MAX_LEN:
        raise ValueError(
            f"item_number must be at most {ITEM_NUMBER_MAX_LEN} characters"
        )
    return v


ItemNumber = Annotated[str, BeforeValidator(_validate_item_number)]


def _trimmed_non_blank(field_name: str):
    """Strip whitespace and reject the empty result.

    None passes through (so the same validator guards required Create
    fields and optional ``str | None`` Update fields). Empty / whitespace
    strings raise a clean 422 instead of slipping to a DB CHECK 500.
    """

    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        if not stripped:
            raise ValueError(f"{field_name} must not be blank")
        return stripped

    return BeforeValidator(_check)


# ── Suppliers ────────────────────────────────────────────────────────────


class SupplierRead(BaseModel):
    """Minimal supplier surface used by the items list + create dropdown."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    contact_email: str | None = None
    phone: str | None = None
    is_active: bool
    notes: str | None = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_orm_row(cls, supplier: object) -> SupplierRead:
        return cls.model_validate(supplier, from_attributes=True)


class SupplierCreate(BaseModel):
    """Payload for ``POST /v1/suppliers`` — admin master-data write.

    Only ``name`` is required; the workbook only carries names for the
    74 seeded rows so every other field is optional and editable later.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    contact_email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)
    is_active: bool = True


class SupplierUpdate(BaseModel):
    """Payload for ``PATCH /v1/suppliers/{id}`` — partial update.

    Every field is optional. Omitted fields stay unchanged; sending an
    explicit ``null`` clears a nullable field. The audit log records
    only fields that actually moved (no-op patches still write a row
    with an empty diff — useful for "user touched this but changed
    nothing" forensics, though the route may also skip the write).
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=128)
    contact_email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)
    is_active: bool | None = None


# ── Items ──────────────────────────────────────────────────────────────


class ItemSupplierRead(BaseModel):
    """One supplier assigned to an item (part of ``ItemRead.suppliers``)."""

    model_config = ConfigDict(from_attributes=True)

    supplier_id: str
    supplier_name: str


class ItemCreate(BaseModel):
    """Payload for ``POST /v1/items``.

    ``item_number`` is a single free-form field supplied by the client.
    The only server-side rule is uniqueness — there is no prefix /
    category constraint on what can be created.

    ``supplier_ids`` is the item's assigned-supplier list (zero-or-more). These
    are the only suppliers the item can later be received against. Optional —
    an item may start with no suppliers and have them added later.
    """

    model_config = ConfigDict(extra="forbid")

    item_number: ItemNumber
    description: str = Field(min_length=1, max_length=512)
    # Required: every item is categorised (requirements v2 §6). The category's
    # kind (purchased/built) decides whether the item may carry a BOM.
    category_id: str = Field(min_length=1)
    supplier_ids: list[str] = Field(default_factory=list, max_length=100)
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal = Field(default=Decimal("0"), ge=Decimal("0"))
    near_expiry_threshold_days: int = Field(default=30, ge=0, le=3650)


class ItemUpdate(BaseModel):
    """Payload for ``PATCH /v1/items/{id}`` — partial update.

    Notable omissions:

    * ``item_number`` is **not editable**. Items can be soft-deleted
      and re-created with a new number, but the human-readable handle
      is immutable so the audit trail and lot relationships stay
      coherent.
    * ``created_by_user_id`` / ``created_at`` are never editable —
      they're audit columns.

    ``supplier_ids``, when provided, **replaces** the item's whole assigned-supplier
    list. Omit it to leave the suppliers unchanged; send ``[]`` to clear them.
    """

    model_config = ConfigDict(extra="forbid")

    description: str | None = Field(default=None, min_length=1, max_length=512)
    # Re-categorise an item. The new category's kind still governs BOM
    # eligibility (the route blocks moving a BOM-bearing item to a purchased
    # category).
    category_id: str | None = Field(default=None, min_length=1)
    supplier_ids: list[str] | None = Field(default=None, max_length=100)
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal | None = Field(default=None, ge=Decimal("0"))
    near_expiry_threshold_days: int | None = Field(default=None, ge=0, le=3650)
    must_order_flag: bool | None = None


class ItemRead(BaseModel):
    """Full item detail. Used by the detail page + list rows.

    Derived fields (``qty_on_hand``, ``status_code``, ``last_movement_at``,
    ``inv_value_amount``, ``po_value_amount``) are computed — valuation now
    comes from the lots' unit prices, not the item.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    item_number: str
    description: str
    # Category (requirements v2 §6). ``category_kind`` drives the UI "Type"
    # column: built → "Product" (may have a BOM), purchased → bought as-is.
    category_id: str
    category_name: str
    category_kind: Literal["purchased", "built"]
    category_tone: str
    # Assigned suppliers (the list an item can be received against).
    suppliers: list[ItemSupplierRead] = Field(default_factory=list)
    avg_lead_days: int | None
    reorder_threshold: Decimal
    near_expiry_threshold_days: int
    must_order_flag: bool
    last_updated_on: date | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str

    # Derived placeholders — populated by the movements module later.
    qty_on_hand: Decimal = Decimal("0")
    # Available = on-hand minus units in date-expired lots (the count used
    # for reorder + forecasting). ``qty_on_hand`` stays for visibility.
    qty_available: Decimal = Decimal("0")
    qty_on_order: Decimal = Decimal("0")
    inv_value_amount: Decimal = Decimal("0")
    po_value_amount: Decimal = Decimal("0")
    status_code: Literal["available", "low_stock", "out_of_stock"] = "out_of_stock"
    last_movement_at: datetime | None = None


class ItemListResponse(BaseModel):
    """Pageable item list response."""

    items: list[ItemRead]
    total: int
    limit: int
    offset: int


LotStatus = Literal["on_order", "available"]


class LotCreate(BaseModel):
    """Payload for ``POST /v1/items/{item_id}/lots``.

    ``item_id`` is supplied via the URL, not the body — see the route.
    """

    model_config = ConfigDict(extra="forbid")

    lot_number: Annotated[str, _trimmed_non_blank("lot_number")] = Field(max_length=64)
    supplier_id: str | None = None
    manufacture_date: date | None = None
    expiration_date: date | None = None
    status: LotStatus = "available"
    notes: str | None = Field(default=None, max_length=2048)


class LotUpdate(BaseModel):
    """Payload for ``PATCH /v1/lots/{id}`` — partial, e-signed update.

    ``lot_number`` and ``item_id`` are immutable for the same reason
    item_number is — they're the identity of the lot. Editable fields:
    status (released → quarantined → recalled lifecycle), dates,
    supplier, notes. The DB CHECK on date ordering still
    applies; the route surfaces the structured error.

    Editing a lot after entry is a GxP-significant correction (e.g.
    fixing a wrong expiration date), so every edit is signed: the body
    carries a fresh ``evidence_id`` minted for action='lot.update' and an
    optional ``reason`` for the change (the e-signature comment — no
    e-sign requires a comment, per the 2026-07-01 client directive). Both
    ride on the same payload but are *not* lot columns — the route pops
    them before patching.
    """

    model_config = ConfigDict(extra="forbid")

    supplier_id: str | None = None
    manufacture_date: date | None = None
    expiration_date: date | None = None
    status: LotStatus | None = None
    notes: str | None = Field(default=None, max_length=2048)
    # Price paid — editable post-entry under the same e-signature (e.g.
    # correcting what was keyed at receipt).
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"))
    # Received quantity for this lot (whole units). Editable post-receipt as a
    # correction, but never below what is already physically placed in
    # locations — the route returns ``qty_below_placed`` and asks the operator
    # to unplace first. Editing it re-syncs the Order line's received /
    # outstanding totals and re-derives the Order status.
    ordered_qty: int | None = Field(default=None, gt=0)
    # ── E-signature (21 CFR Part 11) ──────────────────────────────────
    # Required on every edit — there is no un-signed lot-update path.
    evidence_id: str = Field(
        min_length=1,
        description="Fresh reauth evidence id for action='lot.update'",
    )
    reason: str | None = Field(
        default=None,
        max_length=512,
        description="Optional reason for change, recorded on the audit row",
    )


class LotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    item_id: str
    lot_number: str
    supplier_id: str | None
    supplier_name: str | None = None
    item_number: str | None = None
    item_description: str | None = None
    manufacture_date: date | None
    expiration_date: date | None
    status: LotStatus
    notes: str | None
    # ── Receipt Admin v2 ──────────────────────────────────────────────
    unit_price_amount: Decimal | None = None
    po_reference: str | None = None
    receipt_transaction_id: str | None = None
    receipt_transaction_line_id: str | None = None
    parent_lot_id: str | None = None
    # Ordered quantity captured at intake (planning data; the received
    # quantity stays ledger-derived, not this). Whole units only.
    ordered_qty: int | None = None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str


# ── Stock movements / ledger ───────────────────────────────────────────


# Movement types. Per-type values must match the DB CHECK + the
# frontend client. Reversal isn't a type — it's any of these with
# ``reversal_of_id`` set.
MovementType = Literal[
    "receipt",
    "dispense",
    "adjustment",
    "discard",
    "transfer_out",
    "transfer_in",
]


class MovementRead(BaseModel):
    """One row in the stock ledger.

    Convenience fields (``item_number``, ``lot_number``,
    ``from_location_code`` …) come from joined relationships so the UI
    doesn't have to round-trip per lookup. Empty strings are NOT
    substituted for missing values — JSON ``null`` is the truthful
    representation and the UI handles it.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    item_id: str
    item_number: str | None = None
    item_description: str | None = None

    lot_id: str | None
    lot_number: str | None = None
    lot_expiration_date: date | None = None

    # Location System node references. For consume, ``to_location_node_id`` is
    # the Flat location that consumed the unit. ``*_name`` / ``*_path`` are
    # resolved for the ledger's Location column (name + breadcrumb tooltip).
    from_location_node_id: str | None = None
    from_location_node_name: str | None = None
    from_location_node_path: str | None = None
    to_location_node_id: str | None = None
    to_location_node_name: str | None = None
    to_location_node_path: str | None = None

    movement_type: MovementType
    qty_delta: int
    qty_abs: int

    # Mandatory §3 comment captured on every e-signed movement.
    notes: str | None

    # FK into ``audit.reauth_events``. The audit viewer hydrates the
    # signature via ``GET /v1/uploads/signature/{evidence}``.
    reauth_evidence_id: str | None = None

    performed_by_user_id: str
    # Joined from ``app.users`` so the ledger and audit timeline can show
    # the operator's name without a second fetch. ``None`` only for legacy
    # rows whose performer was hard-deleted (not expected in v1 MVP).
    performed_by_user_name: str | None = None
    performed_by_user_email: str | None = None
    performed_at: datetime
    created_at: datetime


class MovementListResponse(BaseModel):
    """Paged ledger list."""

    items: list[MovementRead]
    total: int
    limit: int
    offset: int


# ── Orders (Receipt Admin v3 — multi-item / partial / blanket) ─────────
#
# An "Order" is the ``app.receipt_transactions`` header with one-or-more item
# lines and zero-or-more dated receive events. Lots are created at receive,
# never at intake. See docs/modules/receipt-admin.md (v3).

OrderStatus = Literal["open", "partially_received", "received", "cancelled"]


class OrderLineInput(BaseModel):
    """One item line on an Order (intake / edit).

    Supplier is **mandatory** and must be one of the item's assigned suppliers
    (``meta.item_suppliers``). No lot / manufacture / expiry here — those are
    captured at receive. ``ordered_qty`` is planning data (whole units).
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    supplier_id: str
    ordered_qty: int = Field(gt=0)
    unit_price: Decimal | None = Field(default=None, ge=Decimal("0"))


class OrderCreateRequest(BaseModel):
    """Body for ``POST /v1/receiving/transactions`` — create an Order.

    Not e-signed: no stock moves yet. Multiple items allowed; the same item
    may appear on several lines (split sourcing).
    """

    model_config = ConfigDict(extra="forbid")

    po_reference: Annotated[str, _trimmed_non_blank("po_reference")] = Field(
        max_length=128
    )
    is_blanket: bool = False
    valid_from: date | None = None
    valid_to: date | None = None
    notes: str | None = Field(default=None, max_length=2048)
    lines: list[OrderLineInput] = Field(min_length=1, max_length=100)


class OrderUpdateRequest(BaseModel):
    """Body for ``PATCH /v1/receiving/transactions/{id}`` — edit an Order.

    Only allowed while the Order is un-received (``open``); not e-signed.
    Header fields are partial; ``lines``, when provided, **replaces** the
    whole line set.
    """

    model_config = ConfigDict(extra="forbid")

    po_reference: Annotated[str | None, _trimmed_non_blank("po_reference")] = Field(
        default=None, max_length=128
    )
    is_blanket: bool | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    notes: str | None = Field(default=None, max_length=2048)
    lines: list[OrderLineInput] | None = Field(default=None, max_length=100)


class OrderActionRequest(BaseModel):
    """Body for an e-signed Order action (cancel / delete).

    Carries one ``evidence_id`` minted for the action (``order.cancel`` /
    ``order.delete``) and consumed once against the Order. The mandatory reason
    rides on the reauth ticket's comment.
    """

    model_config = ConfigDict(extra="forbid")

    evidence_id: str


class ReceiveEventLineInput(BaseModel):
    """The quantity received for one Order line in a receive event.

    Creates one lot — ``lot_number`` is required and unique per item. Dates /
    price are captured here (at receive). Over-receipt (``qty_received`` beyond
    the line's outstanding quantity) is allowed and needs no reason.
    """

    model_config = ConfigDict(extra="forbid")

    line_id: str
    qty_received: int = Field(gt=0)
    lot_number: Annotated[str, _trimmed_non_blank("lot_number")] = Field(max_length=64)
    manufacture_date: date | None = None
    expiration_date: date | None = None
    # Optional override of the line's unit price for this lot.
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"))


class ReceiveEventRequest(BaseModel):
    """Body for ``POST /v1/receiving/transactions/{id}/receive`` — one dated,
    e-signed receive event (partial / blanket).

    One ``evidence_id`` minted for ``action='receipt.confirm'`` covers the
    whole event (consumed once against the Order).
    """

    model_config = ConfigDict(extra="forbid")

    received_at: date
    lines: list[ReceiveEventLineInput] = Field(min_length=1, max_length=100)
    notes: str | None = Field(default=None, max_length=2048)
    evidence_id: str  # UUID from /v1/auth/reauth (action=receipt.confirm)


class OrderLineRead(BaseModel):
    """One item line with its derived received / outstanding quantities."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    line_no: int
    item_id: str
    item_number: str | None = None
    item_description: str | None = None
    supplier_id: str
    supplier_name: str | None = None
    ordered_qty: int
    unit_price_amount: Decimal | None = None
    # Derived (summed from receipt_event_lines) — never stored on the line.
    received_qty: int = 0
    outstanding_qty: int = 0


class ReceiptEventLineRead(BaseModel):
    """One per-line draw within a receive event."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    line_id: str
    qty_received: int
    over_receipt_reason: str | None = None
    lot_id: str
    lot_number: str | None = None


class ReceiptEventRead(BaseModel):
    """One dated receive event plus its per-line draws."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    received_at: date
    received_by_user_id: str
    # Resolved from the receiver's User row (via ReceiptEvent.received_by) so the
    # UI can show a name rather than a raw id. None only if the user is missing.
    received_by_user_name: str | None = None
    notes: str | None = None
    created_at: datetime
    lines: list[ReceiptEventLineRead] = Field(default_factory=list)


class ReceiptTransactionRead(BaseModel):
    """An Order: header + item lines + dated receive events."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    po_reference: str
    status: OrderStatus
    is_blanket: bool = False
    valid_from: date | None = None
    valid_to: date | None = None
    notes: str | None = None
    created_by_user_id: str
    received_by_user_id: str | None = None
    received_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    lines: list[OrderLineRead] = Field(default_factory=list)
    events: list[ReceiptEventRead] = Field(default_factory=list)
    # Derived rollups across lines.
    total_ordered_qty: int = 0
    total_received_qty: int = 0


class ReceiptTransactionListResponse(BaseModel):
    """Paged Order list."""

    items: list[ReceiptTransactionRead]
    total: int
    limit: int
    offset: int
