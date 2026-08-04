"""Smoke tests for the liveness endpoint.

These tests must NOT require a database — they should run on a developer's
laptop with nothing else set up. The readiness endpoint (which does hit the
DB) gets its own integration tests in the auth module's PR.
"""

from __future__ import annotations

from httpx import AsyncClient


async def test_health_ok(client: AsyncClient) -> None:
    resp = await client.get("/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "cellready-ims-backend"


async def test_health_does_not_disclose_version_or_env(client: AsyncClient) -> None:
    """The probe is unauthenticated, so it must not fingerprint the build.

    Regression guard for VR-027: `version` and `env` were returned to any
    anonymous caller, handing over exactly what's needed to match the host
    against version-specific advisories.
    """
    body = (await client.get("/v1/health")).json()
    assert "version" not in body
    assert "env" not in body


async def test_health_sets_request_id_header(client: AsyncClient) -> None:
    resp = await client.get("/v1/health")
    assert "x-request-id" in {k.lower() for k in resp.headers}


async def test_health_honours_inbound_request_id(client: AsyncClient) -> None:
    incoming = "11111111-2222-3333-4444-555555555555"
    resp = await client.get("/v1/health", headers={"X-Request-Id": incoming})
    assert resp.headers.get("x-request-id") == incoming


async def test_unknown_route_returns_404(client: AsyncClient) -> None:
    resp = await client.get("/v1/does-not-exist")
    assert resp.status_code == 404
