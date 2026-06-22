"""Aggregate router for API v1.

Each module (auth, items, ledger, …) lives in ``routes/`` and exports its
own ``router`` object. They're mounted here so ``app.main`` only has to know
about one v1 entry point.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.routes import auth, health, uploads
from app.audit.routes import audit_router
from app.forecast.routes import forecasts_router
from app.inventory.routes import (
    items_router,
    lots_router,
    movements_router,
    receiving_router,
    uoms_router,
    vendors_router,
)
from app.locations.routes import alloc_router, nodes_router
from app.products.routes import (
    customers_router,
    item_products_router,
    materials_router,
    products_router,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(uploads.router)
api_router.include_router(items_router)
api_router.include_router(vendors_router)
api_router.include_router(uoms_router)
api_router.include_router(lots_router)
api_router.include_router(movements_router)
api_router.include_router(receiving_router)
api_router.include_router(nodes_router)
api_router.include_router(alloc_router)
api_router.include_router(products_router)
api_router.include_router(materials_router)
api_router.include_router(customers_router)
api_router.include_router(item_products_router)
api_router.include_router(forecasts_router)
api_router.include_router(audit_router)
