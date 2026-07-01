"""Pydantic schemas for the customer module.

Under the unified catalogue, customers link to **finished-good items** (built
items) rather than a separate products table. ``item_ids`` carry those links.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.inventory.schemas import _trimmed_non_blank


class LinkedRef(BaseModel):
    """Lightweight ``{id, name}`` reference for list badges / chips."""

    id: str
    name: str


class CustomerCreate(BaseModel):
    """Payload for ``POST /v1/customers`` — details + linked finished-good ids."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=200)
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    item_ids: list[str] = Field(default_factory=list)


class CustomerUpdate(BaseModel):
    """Payload for ``PATCH /v1/customers/{id}`` — partial update.

    ``item_ids``, when present, REPLACES the linked finished-good set. Omit it
    to leave the links unchanged; send ``[]`` to clear them.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=200
    )
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    item_ids: list[str] | None = None


class CustomerRead(BaseModel):
    """Customer list/detail row with its linked finished-good items."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    contact_person: str | None
    email: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str

    items: list[LinkedRef] = Field(default_factory=list)
