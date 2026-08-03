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

from app.core.bounds import MAX_MONEY, MAX_QTY, MAX_QTY_DECIMAL

# ``sku_suffix`` is the tail of the SKU (e.g. ``001``) — the item's number is
# derived as ``<prefix code>-<suffix>``, so only the suffix is user-supplied.
# The only backend rule is uniqueness within the prefix (the partial-unique
# index ``uq_items_prefix_suffix``); no format CHECK. We trim, upper-case
# (so case-variants can't masquerade as distinct items), and reject blank /
# over-long values.
SKU_SUFFIX_MAX_LEN = 64


def _validate_sku_suffix(v: str) -> str:
    v = v.strip().upper()
    if not v:
        raise ValueError("sku_suffix must not be blank")
    if len(v) > SKU_SUFFIX_MAX_LEN:
        raise ValueError(
            f"sku_suffix must be at most {SKU_SUFFIX_MAX_LEN} characters"
        )
    return v


SkuSuffix = Annotated[str, BeforeValidator(_validate_sku_suffix)]


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

    The client supplies ``prefix_id`` + ``sku_suffix``; the full number is
    derived as ``<prefix code>-<suffix>`` and must be unique within the prefix.

    ``supplier_ids`` is the item's assigned-supplier list (zero-or-more). These
    are the only suppliers the item can later be received against. Optional —
    an item may start with no suppliers and have them added later.
    """

    model_config = ConfigDict(extra="forbid")

    # The SKU tail only (e.g. ``001``). The full number is derived as
    # ``<prefix code>-<suffix>``.
    sku_suffix: SkuSuffix
    description: str = Field(min_length=1, max_length=512)
    # Required: every item is assigned exactly one prefix (REQ-2026-07-09-ITM-001).
    # The tier is derived from the prefix (a prefix lives inside one tier), and the
    # tier's type (raw_material/sub_assembly/finished_good) decides BOM eligibility.
    prefix_id: str = Field(min_length=1)
    # Free-text unit of measure (each, mL, box …). Optional.
    uom: Annotated[str | None, _trimmed_non_blank("uom")] = Field(
        default=None, max_length=32
    )
    # Consumables are blind-consumed with no per-lot traceability
    # (REQ-2026-07-01-TRX-003). Defaults to a traceable, one-for-one material.
    is_consumable: bool = False
    supplier_ids: list[str] = Field(default_factory=list, max_length=100)
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal = Field(
        default=Decimal("0"), ge=Decimal("0"), le=MAX_QTY_DECIMAL
    )
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
    uom: Annotated[str | None, _trimmed_non_blank("uom")] = Field(
        default=None, max_length=32
    )
    is_consumable: bool | None = None
    # Re-assign an item to another prefix. The prefix's tier (derived server-side)
    # still governs BOM eligibility — the route blocks moving a BOM-bearing item
    # to a raw-material prefix, and a stocked item to a built prefix.
    prefix_id: str | None = Field(default=None, min_length=1)
    supplier_ids: list[str] | None = Field(default=None, max_length=100)
    avg_lead_days: int | None = Field(default=None, ge=0, le=3650)
    reorder_threshold: Decimal | None = Field(
        default=None, ge=Decimal("0"), le=MAX_QTY_DECIMAL
    )
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
    # Derived full SKU (``<prefix code>-<suffix>``) + the stored tail.
    item_number: str
    sku_suffix: str
    description: str
    # Free-text unit of measure (each, mL, box …). ``None`` when unset.
    uom: str | None = None
    # Blind-consumed (no per-lot traceability) when true.
    is_consumable: bool = False
    # Tier (requirements v2 §6). ``tier_type`` drives the UI "Type"
    # column: sub_assembly/finished_good may have a BOM; raw_material is bought as-is.
    tier_id: str
    tier_name: str
    tier_type: Literal["raw_material", "sub_assembly", "finished_good"]
    tier_tone: str
    # The item's type prefix (REQ-2026-07-09-ITM-001) — the tab/filter criterion.
    prefix_id: str
    prefix_code: str
    prefix_label: str | None = None
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
    # Direct BOM components. Always 0 for a raw material (it's bought, not
    # assembled); on a built tier, 0 means the recipe hasn't been defined yet.
    bom_line_count: int = 0


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
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"), le=MAX_MONEY)
    # Received quantity for this lot (whole units). Editable post-receipt as a
    # correction, but never below what is already physically placed in
    # locations — the route returns ``qty_below_placed`` and asks the operator
    # to unplace first. Editing it re-syncs the Order line's received /
    # outstanding totals and re-derives the Order status.
    ordered_qty: int | None = Field(default=None, gt=0, le=MAX_QTY)
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


class LotNumberAvailability(BaseModel):
    """Whether an operator-typed lot number is still free.

    Lets the kitting close-out screen tell the operator their produced-batch lot
    number is taken **while they are typing it**, instead of after they have
    composed the batch and signed. The authority stays server-side
    (``_resolve_output_lot_number`` → 422 ``output_lot_number_taken``): this is
    advisory, and a number free at check time can still be claimed by someone
    else before the produce lands.
    """

    lot_number: str
    available: bool


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
    # Kitting / back-flush. These already exist in the DB CHECK and in
    # ``app.models.inventory.MOVEMENT_TYPES``; omitting them here made the
    # ledger endpoint fail to serialise any item that had been kitted
    # (ValidationError on MovementRead). Keep this list in lock-step with
    # MOVEMENT_TYPES.
    "kit_issue",
    "kit_additional_issue",
    "production_output",
    # Three distinct return events — see MOVEMENT_TYPES (kitting05).
    "backflush",
    "kit_return",
    "kit_cancel_return",
    # Terminal customer shipment (CUST-001 / TRX-005) — see MOVEMENT_TYPES (ship01).
    "customer_shipment",
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

    # The kit that caused this row, when there is one (kit_issue /
    # kit_additional_issue / production_output / backflush). Drives the
    # AY/FG ledger's Transaction column ("Made KIT-0034"). A transaction
    # reference only — SRS §7 excludes finished-good → component-lot tracing.
    kit_id: str | None = None
    kit_number: str | None = None
    # Where the kit was BUILT. Not a movement end: ``production_output`` mints a
    # new lot, so those units never moved from anywhere and
    # ``ck_movements_locations`` requires ``from_location_node_id IS NULL`` —
    # same as a receipt. The floor is still the answer to "where was this made",
    # so it travels beside the movement rather than being forced into ``from``,
    # which would assert stock left the floor and mislead any location-based
    # report.
    kit_production_location_node_id: str | None = None
    kit_production_location_name: str | None = None

    # Customer shipment (CUST-001 / TRX-005). Set only on ``customer_shipment``
    # rows: the named customer the finished good left inventory to (null = a
    # catalog / unassigned shipment, TRX-007), and the free-text reference /
    # tracking / sales-order number. Drives the ledger's "to the named customer"
    # display CUST-001 requires.
    customer_id: str | None = None
    customer_name: str | None = None
    reference_number: str | None = None

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
    ordered_qty: int = Field(gt=0, le=MAX_QTY)
    unit_price: Decimal | None = Field(default=None, ge=Decimal("0"), le=MAX_MONEY)


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


class PlacementCell(BaseModel):
    """One box-grid cell (1-based) targeted by a placement (one unit each)."""

    model_config = ConfigDict(extra="forbid")

    grid_row: int = Field(ge=1, le=400)
    grid_col: int = Field(ge=1, le=400)


class ReceivePlacement(BaseModel):
    """Where a received lot is placed (unit-in) — the destination for this draw.

    Single destination, exactly ``qty_received`` units:

    * **Box** (LN2 grid): ``cells`` lists exactly ``qty_received`` distinct empty
      cells, one unit each.
    * **Free leaf** (freezer sub-location / warehouse shelf): ``cells`` is empty;
      all ``qty_received`` units land on the node.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    cells: list[PlacementCell] = Field(default_factory=list, max_length=400)

    @model_validator(mode="after")
    def _distinct_cells(self) -> ReceivePlacement:
        seen = {(c.grid_row, c.grid_col) for c in self.cells}
        if len(seen) != len(self.cells):
            raise ValueError("Placement cells must be distinct")
        return self


class ReceiveEventLineInput(BaseModel):
    """The quantity received for one Order line in a receive event.

    Creates one lot — ``lot_number`` is required and unique per item. Dates /
    price are captured here (at receive). Over-receipt (``qty_received`` beyond
    the line's outstanding quantity) is allowed and needs no reason.

    ``placement`` puts the received units into a location in the same signed
    step (unit-in happens only here, from Receipt Admin).
    """

    model_config = ConfigDict(extra="forbid")

    line_id: str
    qty_received: int = Field(gt=0, le=MAX_QTY)
    lot_number: Annotated[str, _trimmed_non_blank("lot_number")] = Field(max_length=64)
    manufacture_date: date | None = None
    expiration_date: date | None = None
    # Optional override of the line's unit price for this lot.
    unit_price_amount: Decimal | None = Field(default=None, ge=Decimal("0"), le=MAX_MONEY)
    # Destination for the received units (unit-in), placed under the receive's
    # single e-signature.
    placement: ReceivePlacement


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
