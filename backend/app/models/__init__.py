"""ORM model registry.

Importing this package re-exports every model that Alembic should know
about. ``alembic/env.py`` does ``from app import models`` so that
``Base.metadata`` is populated by the time ``--autogenerate`` runs.

Add new modules here as they ship — Alembic won't see a model that
nothing imports.
"""

from __future__ import annotations

from app.models.audit import AuditEvent, ReauthConsumption, ReauthEvent
from app.models.forecast import ForecastEntry
from app.models.identity import Role, User
from app.models.inventory import (
    BomLine,
    Item,
    ItemCategory,
    ItemStock,
    ItemVendor,
    Lot,
    ReceiptEvent,
    ReceiptEventLine,
    ReceiptTransaction,
    ReceiptTransactionLine,
    StockMovement,
    Vendor,
)
from app.models.locations import (
    LocationNode,
    LotAllocation,
)
from app.models.products import Customer, CustomerItem

__all__ = [
    "AuditEvent",
    "BomLine",
    "Customer",
    "CustomerItem",
    "ForecastEntry",
    "Item",
    "ItemCategory",
    "ItemStock",
    "ItemVendor",
    "LocationNode",
    "Lot",
    "LotAllocation",
    "ReauthConsumption",
    "ReauthEvent",
    "ReceiptEvent",
    "ReceiptEventLine",
    "ReceiptTransaction",
    "ReceiptTransactionLine",
    "Role",
    "StockMovement",
    "User",
    "Vendor",
]
