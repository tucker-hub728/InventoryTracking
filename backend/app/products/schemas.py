"""Pydantic schemas for the customer module.

A customer is simple master data — name, contact, email. Customers are NOT
linked to inventory items (the part number is the source of truth for inventory
identity; see the client's "Customers / Vendor List" note). Shipments name a
customer at ship time; no pre-assignment of items to customers exists.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.inventory.schemas import _trimmed_non_blank


class CustomerCreate(BaseModel):
    """Payload for ``POST /v1/customers``."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=200)
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)


class CustomerUpdate(BaseModel):
    """Payload for ``PATCH /v1/customers/{id}`` — partial update."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=200
    )
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)


class CustomerRead(BaseModel):
    """Customer list/detail row."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    contact_person: str | None
    email: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str
