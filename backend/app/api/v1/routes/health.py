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

from app.api.deps import DBSession
from app.core.config import get_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Public liveness payload.

    Deliberately minimal. This endpoint is unauthenticated (the container
    healthcheck and the load balancer both hit it), and it used to return
    the exact build version and the environment name to anyone who asked —
    which is a free lookup of "which published CVEs apply to this host"
    for someone deciding whether to bother attacking it.

    A liveness probe only needs to answer "am I up": the healthchecks in
    docker-compose.yml and deploy/docker-compose.yml assert on the HTTP
    status, not the body. Version and environment are still available to
    operators through the deploy metadata and structured logs.
    """

    status: Literal["ok"]
    service: str


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
    return HealthResponse(status="ok", service=s.app_name)


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
