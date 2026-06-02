"""Health and readiness endpoints.

Two endpoints, two distinct purposes:

- ``GET /v1/health``  — liveness. "Is the process up?" No external calls.
                        Used by container orchestrators to decide whether to
                        kill and restart this pod.
- ``GET /v1/ready``   — readiness. "Can this process serve traffic?" Pings
                        the database. Used by load balancers to decide
                        whether to send requests here.

Keep these cheap. They run on every k8s probe interval.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, status
from pydantic import BaseModel
from sqlalchemy import text

from app import __version__
from app.api.deps import DBSession
from app.core.config import get_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
    env: str


class ReadinessResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "down"]


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness probe",
    status_code=status.HTTP_200_OK,
)
async def health() -> HealthResponse:
    s = get_settings()
    return HealthResponse(
        status="ok",
        service=s.app_name,
        version=__version__,
        env=s.app_env.value,
    )


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Readiness probe (checks DB)",
)
async def ready(db: DBSession) -> ReadinessResponse:
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        return ReadinessResponse(status="degraded", database="down")
    return ReadinessResponse(status="ok", database="ok")
