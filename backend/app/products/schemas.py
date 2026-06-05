"""Pydantic schemas for the product module — products, materials, customers.

A product is just a name + a bill of materials (inventory items × qty per
run). Customers link to products many-to-many. Materials read models carry
the inventory item's live stock so the UI can show Available + Stock Status
without extra round-trips.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# Reuse the inventory trim-and-reject-blank validator so names behave like
# vendor / location names (clean 422, not a 500 from the DB CHECK).
from app.inventory.schemas import _trimmed_non_blank

# Computed stock status carried through from ``app.v_item_stock``.
StockStatus = Literal["available", "low_stock", "out_of_stock"]


class LinkedRef(BaseModel):
    """Lightweight ``{id, name}`` reference for list badges / chips."""

    id: str
    name: str


# ── Products ───────────────────────────────────────────────────────────


class ProductMaterialInput(BaseModel):
    """One material line supplied inline when creating a product."""

    model_config = ConfigDict(extra="forbid")

    item_id: str  # UUID of the inventory item
    qty_per_run: Decimal = Field(gt=Decimal("0"), le=Decimal("5000"))


class ProductCreate(BaseModel):
    """Payload for ``POST /v1/products`` — name, SKU + the material array.

    ``sku`` is supplied by the user at creation and is **immutable**
    afterwards (no ``sku`` on ``ProductUpdate``). It's unique
    (case-insensitive) among live products.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=200)
    sku: Annotated[str, _trimmed_non_blank("sku")] = Field(max_length=64)
    materials: list[ProductMaterialInput] = Field(default_factory=list)


class ProductUpdate(BaseModel):
    """Payload for ``PATCH /v1/products/{id}`` — name only.

    ``sku`` is intentionally absent: it's the immutable product handle, set
    at creation. Materials are managed via the ``/products/{id}/materials``
    endpoints, not here.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=200
    )


class ProductRead(BaseModel):
    """Product list/detail row. ``customers`` + ``material_count`` are
    filled from grouped queries by the route."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    sku: str
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str

    material_count: int = 0
    customers: list[LinkedRef] = Field(default_factory=list)
    # Only set by the inverse "products using this item" view — the quantity
    # of that one inventory item consumed per production run of this product.
    qty_per_run: Decimal | None = None


class ProductMaterialRead(BaseModel):
    """A BOM line joined to its inventory item's live stock.

    Backs the "Required Materials per Production Run" table: qty needed per
    run, what's on hand (Available), and the item's stock status badge.
    """

    id: str  # product_material id
    item_id: str
    item_number: str
    item_name: str
    uom_code: str
    qty_per_run: Decimal
    qty_on_hand: Decimal
    status_code: StockStatus


class MaterialCreate(BaseModel):
    """Payload for ``POST /v1/products/{id}/materials``."""

    model_config = ConfigDict(extra="forbid")

    item_id: str
    qty_per_run: Decimal = Field(gt=Decimal("0"), le=Decimal("5000"))


class MaterialUpdate(BaseModel):
    """Payload for ``PATCH /v1/product-materials/{id}`` — qty only."""

    model_config = ConfigDict(extra="forbid")

    qty_per_run: Decimal = Field(gt=Decimal("0"), le=Decimal("5000"))


# ── Customers ──────────────────────────────────────────────────────────


class CustomerCreate(BaseModel):
    """Payload for ``POST /v1/customers`` — details + linked product ids."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, _trimmed_non_blank("name")] = Field(max_length=200)
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    product_ids: list[str] = Field(default_factory=list)


class CustomerUpdate(BaseModel):
    """Payload for ``PATCH /v1/customers/{id}`` — partial update.

    ``product_ids``, when present, REPLACES the linked product set. Omit it
    to leave the links unchanged; send ``[]`` to clear them.
    """

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, _trimmed_non_blank("name")] = Field(
        default=None, max_length=200
    )
    contact_person: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    product_ids: list[str] | None = None


class CustomerRead(BaseModel):
    """Customer list/detail row with its linked products."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    contact_person: str | None
    email: str | None
    created_at: datetime
    updated_at: datetime
    created_by_user_id: str
    updated_by_user_id: str

    products: list[LinkedRef] = Field(default_factory=list)
