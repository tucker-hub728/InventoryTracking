"""Aggregate router for API v1.

Each module (auth, items, ledger, …) lives in ``routes/`` and exports its
own ``router`` object. They're mounted here so ``app.main`` only has to know
about one v1 entry point.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.routes import auth, health, uploads
from app.audit.routes import audit_router
from app.catalog.routes import bom_router, categories_router
from app.forecast.routes import forecasts_router
from app.inventory.routes import (
    items_router,
    lots_router,
    movements_router,
    receiving_router,
    suppliers_router,
)
from app.invitations.routes import router as invitations_router
from app.locations.routes import alloc_router, nodes_router
from app.products.routes import customers_router
from app.users.routes import router as users_router

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(invitations_router)
api_router.include_router(users_router)
api_router.include_router(uploads.router)
api_router.include_router(items_router)
api_router.include_router(suppliers_router)
api_router.include_router(lots_router)
api_router.include_router(movements_router)
api_router.include_router(receiving_router)
api_router.include_router(nodes_router)
api_router.include_router(alloc_router)
api_router.include_router(categories_router)
api_router.include_router(bom_router)
api_router.include_router(customers_router)
api_router.include_router(forecasts_router)
api_router.include_router(audit_router)
