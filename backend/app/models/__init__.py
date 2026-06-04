"""ORM model registry.

Importing this package re-exports every model that Alembic should know
about. ``alembic/env.py`` does ``from app import models`` so that
``Base.metadata`` is populated by the time ``--autogenerate`` runs.

Add new modules here as they ship — Alembic won't see a model that
nothing imports.
"""

from __future__ import annotations

from app.models.audit import AuditEvent, ReauthConsumption, ReauthEvent
from app.models.identity import Role, User
from app.models.inventory import (
    Item,
    ItemStock,
    Location,
    Lot,
    StockMovement,
    UnitOfMeasure,
    Vendor,
)
from app.models.storage import (
    StorageAssignmentEvent,
    StoragePosition,
    StorageRack,
)

__all__ = [
    "AuditEvent",
    "Item",
    "ItemStock",
    "Location",
    "Lot",
    "ReauthConsumption",
    "ReauthEvent",
    "Role",
    "StockMovement",
    "StorageAssignmentEvent",
    "StoragePosition",
    "StorageRack",
    "UnitOfMeasure",
    "User",
    "Vendor",
]
