"""Pydantic schemas for the inventory API — items, stock, transactions.

Week-1 reset (2026-07-06). Six-table model: items carry a plain-string
``unit_of_measure`` and a ``tier`` (only CR is created now); stock is a flat
per-(item, location, lot) balance; transactions are Receipt / Transfer
headers with lines that also drive the stock upsert.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

# ── Field validators ────────────────────────────────────────────────────

ITEM_CODE_MAX_LEN = 64


def _upper_non_blank(field: str):
    def _check(v: str) -> str:
        if not isinstance(v, str):
            raise ValueError(f"{field} must be a string")
        v = v.strip().upper()
        if not v:
            raise ValueError(f"{field} must not be blank")
        return v

    return _check


def _trim_non_blank(field: str):
    def _check(v: str) -> str:
        if not isinstance(v, str):
            raise ValueError(f"{field} must be a string")
        v = v.strip()
        if not v:
            raise ValueError(f"{field} must not be blank")
        return v

    return _check


def _trim_optional(field: str):
    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str):
            raise ValueError(f"{field} must be a string")
        v = v.strip()
        if not v:
            raise ValueError(f"{field} must not be blank")
        return v

    return _check


def _blank_to_none(field: str, *, max_length: int | None = None):
    """Like ``_trim_optional`` but folds an empty string to ``None`` rather
    than rejecting it — for free-text fields (description) where clearing is
    a valid edit. Length is enforced here (not via ``Field``) so the ``None``
    branch never hits a string constraint."""

    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str):
            raise ValueError(f"{field} must be a string")
        v = v.strip()
        if not v:
            return None
        if max_length is not None and len(v) > max_length:
            raise ValueError(f"{field} must be at most {max_length} characters")
        return v

    return _check


ItemCode = Annotated[
    str, BeforeValidator(_upper_non_blank("item_code")), Field(max_length=ITEM_CODE_MAX_LEN)
]
ItemName = Annotated[
    str, BeforeValidator(_trim_non_blank("item_name")), Field(max_length=200)
]
UnitOfMeasure = Annotated[
    str, BeforeValidator(_trim_non_blank("unit_of_measure")), Field(max_length=32)
]
OptionalItemName = Annotated[
    str | None, BeforeValidator(_trim_optional("item_name")), Field(max_length=200)
]
OptionalUnitOfMeasure = Annotated[
    str | None, BeforeValidator(_trim_optional("unit_of_measure")), Field(max_length=32)
]
Description = Annotated[
    str | None, BeforeValidator(_blank_to_none("description", max_length=2000))
]
LotNumber = Annotated[
    str | None, BeforeValidator(_trim_optional("lot_number")), Field(max_length=64)
]
Quantity = Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=3)]


# ── Items ───────────────────────────────────────────────────────────────


class ItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_code: ItemCode
    item_name: ItemName
    description: Description = None
    tier: Literal["CR", "AY", "FG"] = "CR"
    is_consumable: bool = False
    unit_of_measure: UnitOfMeasure
    default_location_id: str | None = None
    track_expiry: bool = False


class ItemUpdate(BaseModel):
    """``item_code`` and ``tier`` are immutable — not accepted here."""

    model_config = ConfigDict(extra="forbid")

    item_name: OptionalItemName = None
    description: Description = None
    is_consumable: bool | None = None
    unit_of_measure: OptionalUnitOfMeasure = None
    default_location_id: str | None = None
    track_expiry: bool | None = None
    is_active: bool | None = None


class ItemListRead(BaseModel):
    id: str
    item_code: str
    item_name: str
    description: str | None = None
    tier: str
    is_consumable: bool
    unit_of_measure: str
    default_location_id: str | None = None
    track_expiry: bool
    is_active: bool
    on_hand: Decimal
    location_count: int
    created_at: datetime
    updated_at: datetime


class ItemStockRow(BaseModel):
    location_id: str
    location_name: str | None = None
    lot_number: str | None = None
    expiry_date: date | None = None
    quantity_available: Decimal
    unit_of_measure: str


class ItemDetailRead(ItemListRead):
    stock: list[ItemStockRow] = Field(default_factory=list)


class ItemLedgerEntry(BaseModel):
    """One transaction as it touched a single item — the item's Recent-
    transactions row (quantity + direction + lots for THIS item)."""

    transaction_id: str
    transaction_no: str
    transaction_type: str
    transaction_date: datetime
    created_by_name: str | None = None
    quantity: Decimal
    unit_of_measure: str
    from_location_name: str | None = None
    to_location_name: str | None = None
    lot_numbers: list[str] = Field(default_factory=list)
    reference_no: str | None = None
    notes: str | None = None


# ── Stock ───────────────────────────────────────────────────────────────


class StockRead(BaseModel):
    id: str
    item_id: str
    item_code: str | None = None
    item_name: str | None = None
    location_id: str
    location_name: str | None = None
    lot_number: str | None = None
    expiry_date: date | None = None
    quantity_available: Decimal
    unit_of_measure: str


# ── Transactions ────────────────────────────────────────────────────────


class TransactionLineRead(BaseModel):
    id: str
    item_id: str
    item_code: str | None = None
    item_name: str | None = None
    from_location_id: str | None = None
    from_location_name: str | None = None
    to_location_id: str | None = None
    to_location_name: str | None = None
    lot_number: str | None = None
    expiry_date: date | None = None
    quantity: Decimal
    unit_of_measure: str


class TransactionListRead(BaseModel):
    id: str
    transaction_no: str
    transaction_type: str
    transaction_date: datetime
    reference_no: str | None = None
    notes: str | None = None
    created_by: str
    created_by_name: str | None = None
    line_count: int
    created_at: datetime


class TransactionDetailRead(BaseModel):
    id: str
    transaction_no: str
    transaction_type: str
    transaction_date: datetime
    reference_no: str | None = None
    notes: str | None = None
    created_by: str
    created_by_name: str | None = None
    created_at: datetime
    lines: list[TransactionLineRead] = Field(default_factory=list)


class ReceiptLineCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str
    to_location_id: str
    quantity: Quantity
    lot_number: LotNumber = None
    expiry_date: date | None = None


class ReceiptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference_no: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=1000)
    lines: list[ReceiptLineCreate] = Field(min_length=1)


class TransferLineCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: str
    from_location_id: str
    to_location_id: str
    quantity: Quantity
    lot_number: LotNumber = None


class TransferCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference_no: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=1000)
    lines: list[TransferLineCreate] = Field(min_length=1)
