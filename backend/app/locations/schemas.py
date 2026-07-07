"""Pydantic schemas for the locations API.

Week-1 reset (2026-07-06): a location is a single self-referencing row —
a top-level location (``parent_location_id IS NULL``) or a shelf
sub-location under one. ``location_type`` is free text.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

# The six fixed location categories, mirrored from the ``app.location_category``
# enum. Kept as a Literal so the API rejects an out-of-domain value with a 422
# instead of a raw DB error.
LocationCategory = Literal[
    "Materials Management",
    "Lab",
    "QC",
    "Engineering",
    "PD Lab One",
    "PD Lab Two",
]


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


LocationName = Annotated[
    str, BeforeValidator(_trim_non_blank("location_name")), Field(max_length=200)
]
OptionalName = Annotated[
    str | None, BeforeValidator(_trim_optional("location_name")), Field(max_length=200)
]


class LocationCreate(BaseModel):
    """The form collects name, category, and (optional) parent. Location codes
    are no longer used; a location is identified by its id + name."""

    model_config = ConfigDict(extra="forbid")

    location_name: LocationName
    location_type: LocationCategory
    parent_location_id: str | None = None
    is_active: bool = True


class LocationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    location_name: OptionalName = None
    location_type: LocationCategory | None = None
    parent_location_id: str | None = None
    is_active: bool | None = None


class LocationRead(BaseModel):
    id: str
    location_name: str
    location_type: str
    parent_location_id: str | None = None
    parent_name: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ── By-category overview (nested: location → shelves, with rolled-up stock) ──


class ShelfOverview(BaseModel):
    id: str
    location_name: str
    location_type: str
    parent_location_id: str | None = None
    is_active: bool
    on_hand: Decimal
    distinct_lots: int


class LocationOverview(BaseModel):
    id: str
    location_name: str
    location_type: str
    is_active: bool
    # Rolled up = stock at this location PLUS all its shelves.
    on_hand: Decimal
    distinct_lots: int
    children: list[ShelfOverview] = Field(default_factory=list)
