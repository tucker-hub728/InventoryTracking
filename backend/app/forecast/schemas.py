"""Pydantic schemas for the forecast module.

A forecast entry is one planning cell: product (optionally a customer) × year ×
month → runs. The grid is saved as a *batch* of changes; ``runs = 0`` deletes
the cell. The save carries an e-signature ``evidence_id`` (from
``POST /v1/auth/reauth`` for ``action='forecast.save'``).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ForecastEntryRead(BaseModel):
    """One forecast cell, with its product/customer labels for the grid."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    product_id: str
    product_sku: str
    product_name: str
    # NULL when this is a product-level ("Unassigned") forecast.
    customer_id: str | None = None
    customer_name: str | None = None
    year: int
    month: int  # 1..12
    runs: int


class ForecastChange(BaseModel):
    """One upsert/delete in a batch save. ``runs = 0`` deletes the cell."""

    model_config = ConfigDict(extra="forbid")

    product_id: str
    customer_id: str | None = None  # null = "Unassigned" / product-level
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    runs: int = Field(ge=0, le=100_000)


class ForecastSaveRequest(BaseModel):
    """Body for ``PUT /v1/forecasts`` — a signed batch of cell changes."""

    model_config = ConfigDict(extra="forbid")

    changes: list[ForecastChange] = Field(min_length=1, max_length=2000)
    # UUID from POST /v1/auth/reauth (action='forecast.save'). Single-use.
    evidence_id: str


class ForecastSaveResult(BaseModel):
    """Summary returned after a successful signed save."""

    upserted: int
    deleted: int
