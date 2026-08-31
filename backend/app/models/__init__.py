"""ORM model registry.

Importing this package re-exports every model that Alembic should know
about. ``alembic/env.py`` does ``from app import models`` so that
``Base.metadata`` is populated by the time ``--autogenerate`` runs.

Add new modules here as they ship — Alembic won't see a model that
nothing imports.
"""

from __future__ import annotations

from app.models.audit import AuditEvent, ReauthConsumption, ReauthEvent
from app.models.consumables import ConsumableIssue
from app.models.forecast import ForecastEntry
from app.models.identity import Role, User
from app.models.inventory import (
    BomLine,
    Item,
    ItemStock,
    ItemSupplier,
    ItemTier,
    Lot,
    ReceiptEvent,
    ReceiptEventLine,
    ReceiptTransaction,
    ReceiptTransactionLine,
    StockMovement,
    Supplier,
)
from app.models.invitations import Invitation
from app.models.kitting import Kit, KitBatchConsumption, KitLine, KitProductionBatch
from app.models.locations import (
    LocationNode,
    LotAllocation,
)
from app.models.notifications import NotificationAlertState, NotificationDelivery
from app.models.products import Customer

__all__ = [
    "AuditEvent",
    "BomLine",
    "ConsumableIssue",
    "Customer",
    "ForecastEntry",
    "Invitation",
    "Item",
    "ItemStock",
    "ItemSupplier",
    "ItemTier",
    "Kit",
    "KitBatchConsumption",
    "KitLine",
    "KitProductionBatch",
    "LocationNode",
    "Lot",
    "LotAllocation",
    "NotificationAlertState",
    "NotificationDelivery",
    "ReauthConsumption",
    "ReauthEvent",
    "ReceiptEvent",
    "ReceiptEventLine",
    "ReceiptTransaction",
    "ReceiptTransactionLine",
    "Role",
    "StockMovement",
    "Supplier",
    "User",
]
