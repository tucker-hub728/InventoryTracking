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
    vendor_id: str | None = None
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal = Field(default=Decimal("0"), ge=Decimal("0"))
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
    vendor_id: str | None = None
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal | None = Field(default=None, ge=Decimal("0"))
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
    vendor_id: str | None
    vendor_name: str | None
    avg_lead_days: int | None
    reorder_threshold: Decimal
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


# ── Locations ──────────────────────────────────────────────────────────


# Single source of truth on the API side. The DB ``CHECK`` and the
# frontend kind picker must mirror this exact list.
LocationKind = Literal[
    "LN2",
    "minus_80",
    "minus_20",
    "fridge",
    "room_temp",
    "cold_room",
    "incubator",
    "other",
]


def _trimmed_non_blank(field_name: str):
    """Strip whitespace and reject the empty result.

    None is passed through (so the same validator can guard required
    fields on Create payloads and optional ``str | None`` fields on
    Update payloads). Empty strings still raise — sending ``""``
    explicitly is treated the same as sending whitespace.

    Pydantic's ``min_length`` counts whitespace as content, so
    ``"  "`` would otherwise pass a ``min_length=1`` check, slip through
    to the DB, and hit a ``CHECK`` that bubbles up as a 500. Doing the
    strip + check in Pydantic keeps the response at a clean 422.
    """

    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        if not stripped:
            raise ValueError(f"{field_name} must not be blank")
        return stripped

    return BeforeValidator(_check)


class LocationUpdate(BaseModel):
    """Payload for ``PATCH /v1/locations/{id}`` — partial update.

    ``code`` is editable but the unique constraint still applies; an
    operator renaming ``LN2-A`` to ``LN2-North`` will hit a 409 if
    another location already holds that code. ``kind`` can be changed
    too — historic movements continue to reference this row by id
    and the column is denormalised on the audit row anyway.
    """

    model_config = ConfigDict(extra="forbid")

    code: Annotated[str | None, _trimmed_non_blank("code")] = Field(
        default=None, max_length=64
    )
    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=128
    )
    kind: LocationKind | None = None
    temperature_c: Decimal | None = Field(
        default=None,
        ge=Decimal("-273"),
        le=Decimal("100"),
    )
    notes: str | None = Field(default=None, max_length=2048)
    is_active: bool | None = None


class LocationCreate(BaseModel):
    """Payload for ``POST /v1/locations``.

    ``code`` is the operator-visible handle (``LN2-A``); we trim it
    before saving so ``" LN2-A "`` and ``"LN2-A"`` collide on the
    case-insensitive unique index.
    """

    model_config = ConfigDict(extra="forbid")

    code: Annotated[str, _trimmed_non_blank("code")] = Field(max_length=64)
    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=128)
    kind: LocationKind
    temperature_c: Decimal | None = Field(
        default=None,
        ge=Decimal("-273"),
        le=Decimal("100"),
    )
    notes: str | None = Field(default=None, max_length=2048)
    is_active: bool = True


class LocationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    code: str
    name: str
    kind: LocationKind
    temperature_c: Decimal | None = None
    notes: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ── Lots ───────────────────────────────────────────────────────────────


LotStatus = Literal["quarantined", "released", "expired", "recalled"]


class LotCreate(BaseModel):
    """Payload for ``POST /v1/items/{item_id}/lots``.

    ``item_id`` is supplied via the URL, not the body — see the route.
    """

    model_config = ConfigDict(extra="forbid")

    lot_number: Annotated[str, _trimmed_non_blank("lot_number")] = Field(max_length=64)
    vendor_id: str | None = None
    manufacture_date: date | None = None
    expiration_date: date | None = None
    coa_url: str | None = Field(default=None, max_length=2048)
    status: LotStatus = "released"
    notes: str | None = Field(default=None, max_length=2048)


class LotUpdate(BaseModel):
    """Payload for ``PATCH /v1/lots/{id}`` — partial, e-signed update.

    ``lot_number`` and ``item_id`` are immutable for the same reason
    item_number is — they're the identity of the lot. Editable fields:
    status (released → quarantined → recalled lifecycle), dates,
    vendor, CoA URL, notes. The DB CHECK on date ordering still
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
    coa_url: str | None = Field(default=None, max_length=2048)
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
    coa_url: str | None
    status: LotStatus
    notes: str | None
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

    from_location_id: str | None
    from_location_code: str | None = None
    from_location_name: str | None = None

    to_location_id: str | None
    to_location_code: str | None = None
    to_location_name: str | None = None

    movement_type: MovementType
    qty_delta: Decimal
    qty_abs: Decimal

    reason_code: str | None
    notes: str | None
    reference: str | None
    destination_text: str | None = None

    reversal_of_id: str | None
    # FK into ``audit.reauth_events``. The audit viewer hydrates the
    # canvas signature image via ``GET /v1/uploads/signature/{evidence}``.
    # Nullable for the Chunk 2 smoke rows that pre-date e-sign capture.
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


# ── Receipt (write) ────────────────────────────────────────────────────


class NewLotInput(BaseModel):
    """Inline lot creation as part of a first receipt.

    Used when the vendor delivery introduces a batch that doesn't
    exist yet in ``app.lots``. Subsequent receipts of the same batch
    pass ``lot_id`` instead.
    """

    model_config = ConfigDict(extra="forbid")

    lot_number: str = Field(min_length=1, max_length=64)
    expiration_date: date | None = None
    manufacture_date: date | None = None
    vendor_id: str | None = None
    coa_url: str | None = Field(default=None, max_length=2048)
    notes: str | None = Field(default=None, max_length=2048)


class ReceiptRequest(BaseModel):
    """Body for ``POST /v1/movements/receipt``.

    The receipt either references an existing lot (``lot_id``) or
    creates one inline (``new_lot``) — exactly one of the two must be
    set. ``evidence_id`` is the UUID returned by ``POST /v1/auth/reauth``
    for ``action='movement.receipt'``. It's single-use and bound to
    the authenticated user.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str  # UUID
    location_id: str  # UUID
    qty: Decimal = Field(gt=Decimal("0"))

    # Lot — exactly one of these must be set; validated below.
    lot_id: str | None = None
    new_lot: NewLotInput | None = None

    # E-signature evidence.
    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.receipt)

    @model_validator(mode="after")
    def _check_lot_xor(self) -> ReceiptRequest:
        if (self.lot_id is None) == (self.new_lot is None):
            raise ValueError(
                "exactly one of 'lot_id' or 'new_lot' must be provided"
            )
        return self


# ── Dispense (write) ───────────────────────────────────────────────────


class DispenseRequest(BaseModel):
    """Body for ``POST /v1/movements/dispense``.

    Stock leaves the system — either consumed (patient, QC, research)
    or removed (expired, damaged, lost). Either way the row reduces
    the (lot, location) balance and the API rejects overdraws with a
    structured ``dispense_exceeds_available`` 422.

    ``lot_id`` is required: you can't dispense something that doesn't
    have a lot on record. ``evidence_id`` mints from
    ``POST /v1/auth/reauth`` with ``action='movement.dispense'``.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str  # UUID
    location_id: str  # UUID — physical source of stock
    lot_id: str  # UUID — required for dispense
    qty: Decimal = Field(gt=Decimal("0"))

    # Free-text "where did it go" (lab, patient, shipment, …). Required.
    destination: Annotated[str, _trimmed_non_blank("destination")] = Field(
        max_length=256
    )

    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.dispense)


# ── Discard (write) ────────────────────────────────────────────────────


class DiscardRequest(BaseModel):
    """Body for ``POST /v1/movements/discard``.

    Stock is removed because it's no longer fit for use — expired,
    damaged, contaminated, recalled. Same wire shape as
    ``DispenseRequest`` but produces ``movement_type='discard'`` so
    audit reports can distinguish "consumed for purpose" from "thrown
    away" without parsing reason_code strings.

    ``lot_id`` is required (you can't discard what isn't in a lot) and
    the API rejects overdraws with ``discard_exceeds_available`` 422.
    ``evidence_id`` mints from ``POST /v1/auth/reauth`` with
    ``action='movement.discard'``.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    location_id: str
    lot_id: str
    qty: Decimal = Field(gt=Decimal("0"))

    reason_code: str = Field(min_length=1, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)
    reference: str | None = Field(default=None, max_length=256)

    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.discard)


# ── Adjustment (write) ─────────────────────────────────────────────────


class AdjustmentRequest(BaseModel):
    """Body for ``POST /v1/movements/adjustment``.

    Signed correction to the (lot, location) balance — used after a
    physical count, to back-fill opening balances, or to write down
    a system error. ``qty_delta`` is the **signed** change applied to
    the balance:

      * ``+5`` adds 5 units (operator found 5 extra during a count)
      * ``-2`` removes 2 units (operator found 2 fewer)

    Zero is rejected (``qty_abs > 0`` enforced at the DB and here).
    Negative deltas can't exceed available balance —
    ``adjustment_exceeds_available`` 422.

    Reason code is required (Part 11 mandates a stated reason for any
    inventory variance); the audit row carries the operator-typed
    free-text plus the structured code.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    location_id: str
    lot_id: str
    # NOTE: signed, not gt=0. The route handler enforces non-zero so
    # the DB CHECK ``qty_abs > 0`` doesn't surface as a 500.
    qty_delta: Decimal

    reason_code: str = Field(min_length=1, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)
    reference: str | None = Field(default=None, max_length=256)

    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.adjustment)


# ── Transfer (write) ───────────────────────────────────────────────────


class TransferRequest(BaseModel):
    """Body for ``POST /v1/movements/transfer``.

    Move stock between two locations within the same org. Writes two
    rows atomically — a ``transfer_out`` from the source location and a
    ``transfer_in`` into the destination — linked through
    ``paired_movement_id`` on the ``transfer_in`` row. One e-signature
    covers both legs (``action='movement.transfer'``).

    Source and destination must be distinct; same-location transfers
    are rejected (``transfer_same_location``). Overdraws on the source
    rejected with ``transfer_exceeds_available``.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str
    lot_id: str
    from_location_id: str
    to_location_id: str
    qty: Decimal = Field(gt=Decimal("0"))

    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.transfer)
    # Same-location is rejected at the route layer with a structured
    # ``transfer_same_location`` code (consistent with how the other
    # write endpoints flag domain-invariant failures).


class TransferResponse(BaseModel):
    """Two-row response for ``POST /v1/movements/transfer``.

    Returns both legs so the UI can show the pair without a follow-up
    fetch. ``transfer_out`` reduces the source balance; ``transfer_in``
    bumps the destination balance.
    """

    transfer_out: MovementRead
    transfer_in: MovementRead


# ── Reverse (write) ────────────────────────────────────────────────────


class ReverseRequest(BaseModel):
    """Body for ``POST /v1/movements/{movement_id}/reverse``.

    Posts a counter-movement that cancels out an earlier ledger entry —
    the original row stays untouched (the ledger is append-only) but
    the new row carries ``reversal_of_id=<original>`` so audit reports
    can pair them. The counter's ``movement_type`` is derived from the
    original:

      * receipt        → dispense  (− from original.to_location)
      * dispense       → receipt   (+ into original.from_location)
      * discard        → receipt   (+ into original.from_location)
      * adjustment     → adjustment with negated qty_delta
      * transfer_out / transfer_in → both legs reversed atomically

    Originals can only be reversed once; a second attempt returns
    ``movement_already_reversed``. ``evidence_id`` mints from
    ``POST /v1/auth/reauth`` with ``action='movement.reverse'``.
    """

    model_config = ConfigDict(extra="forbid")

    reason_code: str = Field(min_length=1, max_length=64)
    notes: str | None = Field(default=None, max_length=2048)

    evidence_id: str  # UUID from /v1/auth/reauth (action=movement.reverse)


# ── Stock by lot (read) ────────────────────────────────────────────────


class StockByLotEntry(BaseModel):
    """One row of ``GET /v1/items/{id}/stock-by-lot`` — the per-lot,
    per-location available quantity used to build the dispense picker."""

    model_config = ConfigDict(from_attributes=True)

    lot_id: str
    lot_number: str
    lot_status: LotStatus
    expiration_date: date | None = None

    location_id: str
    location_code: str
    location_name: str

    qty_available: Decimal
    last_movement_at: datetime | None = None


# ── Storage (racks + positions) ────────────────────────────────────────
#
# The LN2 / Storage grid: Location → Rack(rows×cols) → Position. See
# ``docs/modules/storage.md``. Position status is binary (empty/occupied).


PositionStatus = Literal["empty", "occupied"]


class RackInput(BaseModel):
    """One rack defined while creating a location (or added later)."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=64)
    rows: int = Field(ge=1, le=26)
    cols: int = Field(ge=1, le=26)


class StorageLocationCreate(BaseModel):
    """Payload for ``POST /v1/storage/locations``.

    Storage locations are created from name + racks only. ``kind`` /
    ``temperature_c`` / ``notes`` are not collected here — the backend stores a
    default ``kind`` to satisfy the (shared) locations table; those columns are
    still managed by the locations-admin CRUD.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=128)
    racks: list[RackInput] = Field(min_length=1)


class PositionRead(BaseModel):
    """One slot, hydrated with its occupant (lot → item) for the grid."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    # Row-major 1-based number within the rack (the user-facing slot no.).
    index: int
    row_idx: int
    col_idx: int
    label: str
    status: PositionStatus
    lot_id: str | None = None
    lot_number: str | None = None
    # ``item_id`` is the human item_number (what ``/inventory/{id}`` keys on);
    # ``item_uuid`` is the backend UUID.
    item_id: str | None = None
    item_uuid: str | None = None
    item_description: str | None = None
    vendor_name: str | None = None
    assigned_at: datetime | None = None


class RackRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    rows: int
    cols: int
    position_order: int
    positions: list[PositionRead]


class StorageLocationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: LocationKind
    detail: str
    racks: list[RackRead]


class AssignPositionRequest(BaseModel):
    """Assign a lot (one vial) to a single empty slot.

    A grid assign places a new vial and posts a ``+1`` receipt to the ledger,
    so it carries an e-signature like the unit-in flow. ``evidence_id`` is the
    UUID from ``POST /v1/auth/reauth`` (action ``movement.receipt``).
    """

    model_config = ConfigDict(extra="forbid")

    lot_id: str
    evidence_id: str


class EmptyPositionRequest(BaseModel):
    """Empty a single slot (one vial out).

    Posts a ``-1`` dispense to the ledger, so it carries an e-signature and a
    free-text destination (like any unit-out). ``evidence_id`` is the UUID from
    ``POST /v1/auth/reauth`` (action ``movement.dispense``).
    """

    model_config = ConfigDict(extra="forbid")

    destination: Annotated[str, _trimmed_non_blank("destination")] = Field(
        max_length=256
    )
    evidence_id: str


class MovePositionRequest(BaseModel):
    """Move the occupant to another free slot (may be in another location)."""

    model_config = ConfigDict(extra="forbid")

    dest_position_id: str


class MovePositionResult(BaseModel):
    source: PositionRead
    dest: PositionRead


class PositionEventRead(BaseModel):
    """One row of a position's history — unit in / out / move."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    event_kind: str  # assign | empty | move_in | move_out
    from_status: str | None = None
    to_status: str | None = None
    lot_number: str | None = None
    actor_name: str | None = None
    # For moves: the other position + its location.
    counterpart_label: str | None = None
    counterpart_location: str | None = None
    occurred_at: datetime
