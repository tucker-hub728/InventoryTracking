"""Pydantic schemas for the catalogue API (item tiers + BOM).

Tier and BOM writes are electronically signed: every create/update/delete
carries an ``evidence_id`` (a fresh reauth ticket) and a ``reason`` recorded on
the audit row, mirroring the lot-update contract.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

# The three tiers, fixed by REQ-2026-07-15-ITM-001. Admin-added prefixes live
# inside one of these and never constitute a fourth tier.
TierType = Literal["raw_material", "sub_assembly", "finished_good"]
TierTone = Literal["neutral", "accent", "success", "warning", "danger"]


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
    """Trim + upper-case a tier prefix, rejecting the empty result.

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


# ── Tiers ─────────────────────────────────────────────────────────


class PrefixRead(BaseModel):
    """One admin-managed prefix living inside a tier."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    tier_id: str
    # Item-number type code (e.g. 'CR', 'DR'). Stored upper-case.
    code: str
    label: str | None = None
    # The prefix pre-filled when this tier is chosen on the item-create form.
    is_default: bool = False
    is_seeded: bool = False
    # Colour inherited from the owning tier (a prefix has no colour of its own).
    tone: str = "neutral"
    # Live items carrying this prefix — drives the "in use" delete guard.
    item_count: int = 0
    created_at: datetime
    updated_at: datetime


class TierRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    type: TierType
    tone: str
    is_seeded: bool
    item_count: int = 0
    # The tier's admin-managed prefixes (many per tier, REQ-2026-07-15-ITM-002),
    # seeded-first then A-Z. One is ``is_default`` (the create-form pre-fill).
    prefixes: list[PrefixRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class TierCreate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=128)
    type: TierType
    tone: TierTone = "neutral"


class TierUpdate(_ESignFields):
    """Partial update. ``type`` is immutable (omitted on purpose)."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=128
    )
    tone: TierTone | None = None


class TierDelete(_ESignFields):
    model_config = ConfigDict(extra="forbid")


# ── Prefixes (nested under a tier) ──────────────────────────────────────


class PrefixCreate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    # Required — the type code (upper-cased, non-blank).
    code: Prefix = Field(max_length=8)
    label: Annotated[str | None, _trimmed_non_blank("label")] = Field(
        default=None, max_length=128
    )
    # When true this becomes the tier's default (clearing any previous default).
    is_default: bool = False


class PrefixUpdate(_ESignFields):
    """Partial update of a prefix. ``tier_id`` is immutable (a prefix never
    moves between tiers — that would let it cross a category boundary). The
    colour is inherited from the tier, so there is no ``tone`` here."""

    model_config = ConfigDict(extra="forbid")

    code: Prefix | None = Field(default=None, max_length=8)
    label: Annotated[str | None, _trimmed_non_blank("label")] = Field(
        default=None, max_length=128
    )
    is_default: bool | None = None


class PrefixDelete(_ESignFields):
    model_config = ConfigDict(extra="forbid")


# ── BOM lines ──────────────────────────────────────────────────────────


class BomLineRead(BaseModel):
    """One direct BOM line, with the child's stock + tier hydrated."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    parent_item_id: str
    child_item_id: str
    child_item_number: str
    child_description: str
    child_tier_name: str
    child_tier_type: TierType
    child_tier_tone: str
    qty_per_unit: Decimal
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
    qty_per_unit: Decimal = Field(gt=Decimal("0"))


class BomLineUpdate(_ESignFields):
    model_config = ConfigDict(extra="forbid")

    qty_per_unit: Decimal = Field(gt=Decimal("0"))


class BomLineDelete(_ESignFields):
    model_config = ConfigDict(extra="forbid")


class WhereUsedRead(BaseModel):
    """A parent item that consumes the queried item in its BOM."""

    model_config = ConfigDict(from_attributes=True)

    parent_item_id: str
    parent_item_number: str
    parent_description: str
    parent_tier_name: str
    qty_per_unit: Decimal
