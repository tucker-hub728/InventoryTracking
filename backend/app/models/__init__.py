"""ORM model registry.

Importing this package re-exports every model that Alembic should know
about. ``alembic/env.py`` does ``from app import models`` so that
``Base.metadata`` is populated by the time ``--autogenerate`` runs.

Week-1 reset (2026-07-06): six tables only — users, locations, items,
inventory_stock, inventory_transactions, inventory_transaction_lines.
"""

from __future__ import annotations

from app.models.identity import ROLES, User
from app.models.inventory import (
    ITEM_TIERS,
    TRANSACTION_TYPES,
    InventoryStock,
    InventoryTransaction,
    InventoryTransactionLine,
    Item,
)
from app.models.invitations import INVITE_STATUSES, Invitation
from app.models.locations import Location

__all__ = [
    "INVITE_STATUSES",
    "ITEM_TIERS",
    "ROLES",
    "TRANSACTION_TYPES",
    "InventoryStock",
    "InventoryTransaction",
    "InventoryTransactionLine",
    "Invitation",
    "Item",
    "Location",
    "User",
]
