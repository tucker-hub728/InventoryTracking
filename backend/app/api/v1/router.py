"""Aggregate router for API v1.

Each module (auth, locations, items, stock, transactions) exports its own
router object; they're mounted here so ``app.main`` only has to know about
one v1 entry point.

Week-1 reset (2026-07-06): health, auth (no reauth), locations, items,
stock, transactions.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.routes import auth, health
from app.inventory.routes import items_router, stock_router, transactions_router
from app.invitations.routes import router as invitations_router
from app.locations.routes import router as locations_router
from app.users.routes import router as users_router

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(locations_router)
api_router.include_router(items_router)
api_router.include_router(stock_router)
api_router.include_router(transactions_router)
api_router.include_router(users_router)
api_router.include_router(invitations_router)
