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

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

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


# ── Vendors ────────────────────────────────────────────────────────────


class VendorRead(BaseModel):
    """Minimal vendor surface used by the items list + create dropdown."""

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
    def from_orm_row(cls, vendor: object) -> VendorRead:
        return cls.model_validate(vendor, from_attributes=True)


class UnitOfMeasureRead(BaseModel):
    """Read-only unit-of-measure lookup row.

    There's no CREATE endpoint for these — units are added by migration
    only, since downstream item rows reference them by ``code`` and
    arbitrary new codes break that contract. If a new unit is needed,
    write a migration.
    """

    model_config = ConfigDict(from_attributes=True)

    code: str
    label: str
    is_discrete: bool


class VendorCreate(BaseModel):
    """Payload for ``POST /v1/vendors`` — admin master-data write.

    Only ``name`` is required; the workbook only carries names for the
    74 seeded rows so every other field is optional and editable later.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    contact_email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)
    is_active: bool = True


class VendorUpdate(BaseModel):
    """Payload for ``PATCH /v1/vendors/{id}`` — partial update.

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


class ItemCreate(BaseModel):
    """Payload for ``POST /v1/items``.

    ``item_number`` is a single free-form field supplied by the client.
    The only server-side rule is uniqueness — there is no prefix /
    category constraint on what can be created.
    """

    model_config = ConfigDict(extra="forbid")

    item_number: ItemNumber
    description: str = Field(min_length=1, max_length=512)
    # Free-form, optional grouping label (Requirements v2). No lookup table,
    # no format rule — mirrors the free-form ``item_number`` decision.
    category: str | None = Field(default=None, max_length=128)
    vendor_id: str | None = None
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal = Field(default=Decimal("0"), ge=Decimal("0"))
    near_expiry_threshold_days: int = Field(default=30, ge=0, le=3650)
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"))
    units_per_package: int | None = Field(default=None, ge=1)
    uom_code: str = Field(default="unit", min_length=1, max_length=16)
    po_note: str | None = Field(default=None, max_length=1024)
    notes: str | None = Field(default=None, max_length=2048)


class ItemUpdate(BaseModel):
    """Payload for ``PATCH /v1/items/{id}`` — partial update.

    Notable omissions:

    * ``item_number`` is **not editable**. Items can be soft-deleted
      and re-created with a new prefix, but the human-readable handle
      is immutable so the audit trail and lot relationships stay
      coherent.
    * ``created_by_user_id`` / ``created_at`` are never editable —
      they're audit columns.
    * ``uom_code`` is technically a FK but changing it after stock has
      moved would corrupt qty interpretation. Patching it through this
      endpoint is allowed only while the item has zero ledger rows;
      the route enforces this.
    """

    model_config = ConfigDict(extra="forbid")

    description: str | None = Field(default=None, min_length=1, max_length=512)
    category: str | None = Field(default=None, max_length=128)
    vendor_id: str | None = None
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal | None = Field(default=None, ge=Decimal("0"))
    near_expiry_threshold_days: int | None = Field(default=None, ge=0, le=3650)
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"))
    units_per_package: int | None = Field(default=None, ge=1)
    uom_code: str | None = Field(default=None, min_length=1, max_length=16)
    po_note: str | None = Field(default=None, max_length=1024)
    notes: str | None = Field(default=None, max_length=2048)
    must_order_flag: bool | None = None


class ItemRead(BaseModel):
    """Full item detail. Used by the detail page + list rows.

    Derived fields (``qty_on_hand``, ``status_code``, ``last_movement_at``)
    are present on the response even before the ledger ships — they
    default to safe zero / out-of-stock values so the UI doesn't need
    two shapes.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    item_number: str
    description: str
    category: str | None = None
    vendor_id: str | None
    vendor_name: str | None
    avg_lead_days: int | None
    reorder_threshold: Decimal
    near_expiry_threshold_days: int
    unit_price_amount: Decimal | None
    units_per_package: int | None
    price_per_package_amount: Decimal | None
    uom_code: str
    po_note: str | None
    po_due_text: str | None
    must_order_flag: bool
    last_updated_on: date | None
    notes: str | None
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
    vendor_id: str | None = None
    manufacture_date: date | None = None
    expiration_date: date | None = None
    status: LotStatus = "available"
    notes: str | None = Field(default=None, max_length=2048)


class LotUpdate(BaseModel):
    """Payload for ``PATCH /v1/lots/{id}`` — partial, e-signed update.

    ``lot_number`` and ``item_id`` are immutable for the same reason
    item_number is — they're the identity of the lot. Editable fields:
    status (released → quarantined → recalled lifecycle), dates,
    vendor, notes. The DB CHECK on date ordering still
    applies; the route surfaces the structured error.

    Editing a lot after entry is a GxP-significant correction (e.g.
    fixing a wrong expiration date), so every edit is signed: the body
    carries a fresh ``evidence_id`` minted for action='lot.update' and a
    mandatory ``reason`` for the change. Both ride on the same payload
    but are *not* lot columns — the route pops them before patching.
    """

    model_config = ConfigDict(extra="forbid")

    vendor_id: str | None = None
    manufacture_date: date | None = None
    expiration_date: date | None = None
    status: LotStatus | None = None
    notes: str | None = Field(default=None, max_length=2048)
    # ── E-signature (21 CFR Part 11) ──────────────────────────────────
    # Required on every edit — there is no un-signed lot-update path.
    evidence_id: str = Field(
        min_length=1,
        description="Fresh reauth evidence id for action='lot.update'",
    )
    reason: Annotated[str, _trimmed_non_blank("reason")] = Field(
        max_length=512,
        description="Reason for change, recorded on the audit row",
    )


class LotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    item_id: str
    lot_number: str
    vendor_id: str | None
    vendor_name: str | None = None
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


VendorApprovalStatus = Literal["approved", "pending"]


class ApprovedVendorRead(BaseModel):
    """One approved/pending vendor mapping for an item."""

    model_config = ConfigDict(from_attributes=True)

    item_id: str
    vendor_id: str
    vendor_name: str
    approval_status: VendorApprovalStatus
    created_at: datetime


class ApprovedVendorCreate(BaseModel):
    """Add a vendor to an item's approved list.

    Provide an existing ``vendor_id`` OR a free-text ``vendor_name`` (a
    matching active vendor is reused; otherwise one is created). Exactly
    one of the two must be set.
    """

    model_config = ConfigDict(extra="forbid")

    vendor_id: str | None = None
    vendor_name: Annotated[str | None, _trimmed_non_blank("vendor_name")] = Field(
        default=None, max_length=128
    )
    approval_status: VendorApprovalStatus = "approved"

    @model_validator(mode="after")
    def _check_vendor_xor(self) -> ApprovedVendorCreate:
        if (self.vendor_id is None) == (self.vendor_name is None):
            raise ValueError(
                "exactly one of 'vendor_id' or 'vendor_name' must be provided"
            )
        return self


class ReceiptIntakeLotInput(BaseModel):
    """One lot line in a receipt intake (Requirements v2 §4).

    Resolves a **mandatory** vendor — by id or free-text name. ``quantity``
    is the *ordered* quantity (planning data); it is stored in the lot's
    ``ordered_qty`` column and does NOT post a ledger movement. The received
    quantity is recorded at physical receipt (§5).
    """

    model_config = ConfigDict(extra="forbid")

    lot_number: Annotated[str, _trimmed_non_blank("lot_number")] = Field(max_length=64)
    # Ordered quantity — whole units only (stored on the lot as ordered_qty).
    quantity: int = Field(gt=0)

    # Vendor resolution — exactly one of id / name (vendor is mandatory).
    # Any vendor used here is automatically attached to the item's vendor
    # list (the item's vendors ARE its approved vendors). No separate
    # approval step.
    vendor_id: str | None = None
    vendor_name: Annotated[str | None, _trimmed_non_blank("vendor_name")] = Field(
        default=None, max_length=128
    )

    unit_price: Decimal | None = Field(default=None, ge=Decimal("0"))
    po_reference: str | None = Field(default=None, max_length=128)
    manufacture_date: date | None = None
    expiration_date: date | None = None
    notes: str | None = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _check_vendor_xor(self) -> ReceiptIntakeLotInput:
        if (self.vendor_id is None) == (self.vendor_name is None):
            raise ValueError(
                "exactly one of 'vendor_id' or 'vendor_name' must be provided "
                "(vendor is mandatory for every lot)"
            )
        return self


class ReceiptIntakeRequest(BaseModel):
    """Body for ``POST /v1/receiving/transactions`` — create ON_ORDER lots.

    Not e-signed: no stock moves yet. One item per transaction; multiple
    vendors / lots allowed (edge case 3).
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    po_reference: str | None = Field(default=None, max_length=128)
    notes: str | None = Field(default=None, max_length=2048)
    lots: list[ReceiptIntakeLotInput] = Field(min_length=1, max_length=50)


class ReceiveSplitInput(BaseModel):
    """One portion of an ON_ORDER lot being received (§5).

    The first split with no ``lot_number`` is received into the original lot
    (flip → AVAILABLE); any split carrying a ``lot_number`` (and/or a different
    vendor) creates a child supplier lot linked via ``parent_lot_id``.

    Receive captures **no quantity and no placement** — it only adjusts lot
    details and lifecycle. Quantity arrives later as a unit-IN (place) in the
    Location System.
    """

    model_config = ConfigDict(extra="forbid")

    # Optional vendor override; defaults to the original lot's vendor.
    vendor_id: str | None = None
    vendor_name: Annotated[str | None, _trimmed_non_blank("vendor_name")] = Field(
        default=None, max_length=128
    )
    unit_price: Decimal | None = Field(default=None, ge=Decimal("0"))
    po_reference: str | None = Field(default=None, max_length=128)
    # New lot identity for a child split. Omit to receive into the original.
    lot_number: Annotated[str | None, _trimmed_non_blank("lot_number")] = Field(
        default=None, max_length=64
    )
    manufacture_date: date | None = None
    expiration_date: date | None = None
    notes: str | None = Field(default=None, max_length=2048)


class ReceiveLineInput(BaseModel):
    """Receive instructions for one ON_ORDER lot in the transaction."""

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    splits: list[ReceiveSplitInput] = Field(min_length=1, max_length=20)


class ReceiveRequest(BaseModel):
    """Body for ``POST /v1/receiving/transactions/{id}/receive`` (§5).

    E-signed: one ``evidence_id`` minted for ``action='receipt.confirm'``
    covers the whole receipt (consumed once against the transaction).
    """

    model_config = ConfigDict(extra="forbid")

    lines: list[ReceiveLineInput] = Field(min_length=1, max_length=50)
    evidence_id: str  # UUID from /v1/auth/reauth (action=receipt.confirm)


class ReceiptTransactionRead(BaseModel):
    """A receipt transaction header plus the lots it created."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    item_id: str
    item_number: str | None = None
    item_description: str | None = None
    status: Literal["open", "received", "cancelled"]
    po_reference: str | None = None
    notes: str | None = None
    created_by_user_id: str
    received_by_user_id: str | None = None
    received_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    lots: list[LotRead] = Field(default_factory=list)


class ReceiptTransactionListResponse(BaseModel):
    """Paged receipt-transaction list."""

    items: list[ReceiptTransactionRead]
    total: int
    limit: int
    offset: int
