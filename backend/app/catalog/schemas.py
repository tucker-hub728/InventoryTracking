"""Pydantic schemas for the catalogue API (item categories + BOM).

Category and BOM writes are electronically signed: every create/update/delete
carries an ``evidence_id`` (a fresh reauth ticket) and a ``reason`` recorded on
the audit row, mirroring the lot-update contract.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

CategoryKind = Literal["purchased", "built"]
CategoryTone = Literal["neutral", "accent", "success", "warning", "danger"]


def _trimmed_non_blank(field_name: str):
    def _check(v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        if not stripped:
            raise ValueError(f"{field_name} must not be blank")
        return stripped

    return BeforeValidator(_check)


def _normalise_prefix(v: str | None) -> str | None:
    """Trim + upper-case a category prefix, rejecting the empty result.

    ``None`` passes through so the same validator guards the required Create
    field and the optional Update field. The prefix is the type code (``CR`` /
    ``AY`` / ``FG``) that fronts every SKU, so it is stored upper-case to match
    the free-form item_number normalisation.
    """
    if v is None:
        return None
    stripped = v.strip().upper()
    if not stripped:
        raise ValueError("prefix must not be blank")
    return stripped


Prefix = Annotated[str, BeforeValidator(_normalise_prefix)]


# ── E-signature mixin ──────────────────────────────────────────────────


class _ESignFields(BaseModel):
    """Shared electronic-signature fields for catalogue writes.

    The ``reason`` (e-sign comment) is **optional** — the operator may sign
    without a comment. Whatever is provided is recorded on the audit row.
    """

    evidence_id: str = Field(
        min_length=1, description="Fresh reauth evidence id for the signed action"
    )
    reason: str = Field(
        default="",
        max_length=512,
        description="Optional reason for change, recorded on the audit row",
    )


# ── Categories ─────────────────────────────────────────────────────────


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    # Item-number type prefix (e.g. 'CR'). Fronts every SKU in this category.
    prefix: str
    kind: CategoryKind
    tone: str
    is_seeded: bool
    item_count: int = 0
    created_at: datetime
    updated_at: datetime


class CategoryCreate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=128)
    # Required — the type code that prefixes SKUs in this category.
    prefix: Prefix = Field(max_length=8)
    kind: CategoryKind
    tone: CategoryTone = "neutral"


class CategoryUpdate(_ESignFields):
    """Partial update. ``kind`` is immutable (omitted on purpose)."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=128
    )
    prefix: Prefix | None = Field(default=None, max_length=8)
    tone: CategoryTone | None = None


class CategoryDelete(_ESignFields):
    model_config = ConfigDict(extra="forbid")


# ── BOM lines ──────────────────────────────────────────────────────────


class BomLineRead(BaseModel):
    """One direct BOM line, with the child's stock + category hydrated."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_item_id: str
    child_item_id: str
    child_item_number: str
    child_description: str
    child_category_name: str
    child_category_kind: CategoryKind
    child_category_tone: str
    qty_per_run: Decimal
    # The child's physical on-hand and its available stock (on-hand minus
    # expired) — ``child_qty_available`` is the "Available" column, the same
    # number the inventory list shows.
    child_qty_on_hand: Decimal
    child_qty_available: Decimal
    # The child item's real stock status (same value the inventory list shows),
    # so the tree badge matches the list.
    child_status_code: Literal["available", "low_stock", "out_of_stock"]
    # True when the child itself is a built item with its own BOM (so the UI
    # can offer to expand it).
    child_has_bom: bool
    created_at: datetime
    updated_at: datetime
    # The child's own BOM lines, populated only when the endpoint is called
    # with ``?nested=true`` (the Structure tab pre-expands the whole tree). It
    # stays ``None`` for the flat/direct listing so the default response and the
    # write endpoints are unchanged.
    children: list[BomLineRead] | None = None


# Resolve the self-referential ``children`` forward ref (``from __future__
# import annotations`` makes every annotation a string).
BomLineRead.model_rebuild()


class ItemBomResponse(BaseModel):
    """An item's direct BOM lines."""

    item_id: str
    lines: list[BomLineRead] = Field(default_factory=list)


class BomLineCreate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    child_item_id: str = Field(min_length=1)
    qty_per_run: Decimal = Field(gt=Decimal("0"))


class BomLineUpdate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    qty_per_run: Decimal = Field(gt=Decimal("0"))


class BomLineDelete(_ESignFields):
    model_config = ConfigDict(extra="forbid")


class WhereUsedRead(BaseModel):
    """A parent item that consumes the queried item in its BOM."""

    model_config = ConfigDict(from_attributes=True)

    parent_item_id: str
    parent_item_number: str
    parent_description: str
    parent_category_name: str
    qty_per_run: Decimal
