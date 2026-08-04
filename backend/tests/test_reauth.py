"""Integration tests for ``POST /v1/auth/reauth``.

These hit a real cognito-local instance — same approach as
``test_auth.py``. The whole file is skipped if Cognito isn't configured.

Each test creates a fresh user with a random email so audit rows from
one test can't interfere with another (the per-user rate-limit query
is keyed by ``user_id``).
"""

from __future__ import annotations

import os
from typing import Any

import pytest
from httpx import AsyncClient

# Reuse the same admin-provision helper used by the auth tests so the
# user-creation path stays identical.
from tests.test_auth import (
    _admin_provision_cognito_user,
    _random_email,
    _strong_password,
)

pytestmark = pytest.mark.skipif(
    not os.environ.get("COGNITO_USER_POOL_ID"),
    reason="Cognito not configured; set COGNITO_USER_POOL_ID etc. before running",
)


async def _login(client: AsyncClient, email: str, password: str) -> str:
    """Login + return the access token. Provisioning is the caller's job."""
    resp = await client.post("/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


async def _ensure_db_user(client: AsyncClient, access_token: str) -> None:
    """Hit /me once so the ``app.users`` row exists (reauth needs it for FK)."""
    resp = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert resp.status_code == 200, resp.text


async def _bootstrap_user(client: AsyncClient) -> dict[str, Any]:
    """Provision + login + provision-db-row in one go."""
    email = _random_email()
    password = _strong_password()
    _admin_provision_cognito_user(email=email, password=password)
    access_token = await _login(client, email, password)
    await _ensure_db_user(client, access_token)
    return {"email": email, "password": password, "access_token": access_token}


def _auth_headers(token: str, *, ua: str = "pytest/1.0") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": ua,
        "X-Forwarded-For": "203.0.113.42",  # documentation IP — no real harm if logged
    }


def _body(action: str, password: str, **extra: Any) -> dict[str, Any]:
    """Reauth request body. ``comment`` is required on the wire, so every
    body carries one by default; pass ``comment=...`` (or other keys) via
    ``extra`` to override or add fields."""
    body: dict[str, Any] = {
        "action": action,
        "password": password,
        "comment": "Routine action — test rationale.",
    }
    body.update(extra)
    return body


# ── Tests ──────────────────────────────────────────────────────────────


async def test_reauth_happy_path_returns_evidence_id(client: AsyncClient) -> None:
    """Correct password + valid action → 200 with evidence + future expires_at."""
    user = await _bootstrap_user(client)

    resp = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body(
            "movement.receipt",
            user["password"],
            meaning="I attest the receipt is accurate.",
            comment="Correcting an erroneous transfer.",
        ),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "movement.receipt"
    # Evidence id should be a UUID; cheap check on shape rather than parse.
    assert len(body["evidence_id"]) == 36
    assert "expires_at" in body
    # The mandatory rationale is echoed back so the caller can mirror it
    # into the domain record's notes/reason.
    assert body["comment"] == "Correcting an erroneous transfer."


async def test_reauth_wrong_password_returns_401_and_records_failure(
    client: AsyncClient,
) -> None:
    """Bad password → 401 with ``reauth_failed`` code; correct password
    immediately after still works (failure didn't lock anything)."""
    user = await _bootstrap_user(client)

    bad = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", "Definitely!Wrong1A"),
    )
    assert bad.status_code == 401, bad.text
    body = bad.json()
    assert body["code"] == "reauth_failed"

    ok = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", user["password"]),
    )
    assert ok.status_code == 200, ok.text


async def test_reauth_rate_limit_after_five_failures(client: AsyncClient) -> None:
    """6th failure (and beyond) returns 429, even if the password is right."""
    user = await _bootstrap_user(client)

    for i in range(5):
        resp = await client.post(
            "/v1/auth/reauth",
            headers=_auth_headers(user["access_token"]),
            json=_body("movement.receipt", f"Wrong{i}!1A"),
        )
        assert resp.status_code == 401, f"attempt {i}: {resp.text}"

    # 6th attempt — should be locked
    blocked = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", "Wrong5!1A"),
    )
    assert blocked.status_code == 429, blocked.text
    body = blocked.json()
    assert body["code"] == "reauth_rate_limited"
    assert body["details"]["retry_after_seconds"] > 0

    # Even the right password is locked out while in the window.
    locked = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", user["password"]),
    )
    assert locked.status_code == 429, locked.text


async def test_reauth_requires_session(client: AsyncClient) -> None:
    """Missing bearer token → 401 (we never hit Cognito)."""
    resp = await client.post(
        "/v1/auth/reauth",
        json=_body("movement.receipt", "anything"),
    )
    assert resp.status_code == 401, resp.text
    # The exact code lives in the dependency, not our route.
    assert resp.json()["code"] in {"authentication_required"}


async def test_reauth_rejects_bad_action_pattern(client: AsyncClient) -> None:
    """Action must match ``^[a-z][a-z0-9_.-]+$`` — uppercase / spaces are 422."""
    user = await _bootstrap_user(client)
    resp = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("MOVEMENT RECEIPT", user["password"]),
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["code"] == "request_invalid"


async def test_reauth_comment_is_optional(client: AsyncClient) -> None:
    """The rationale is optional — omitting it still mints evidence.

    This asserted the opposite until 2026-08-03. The mandatory-comment rule
    was dropped on the client's request back on 2026-06-29 and the backend
    was relaxed then (see the note on ``ReauthRequest.comment``), but this
    test was never updated, so it had been failing on every run since.

    What makes the signature a Part 11 signature is the re-authenticated
    identity, the timestamp and the attested ``meaning`` — not the free-text
    reason. Individual domain endpoints may still demand their own reason;
    that is enforced at those endpoints, not here.
    """
    user = await _bootstrap_user(client)

    # Omitted entirely.
    missing = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json={"action": "movement.receipt", "password": user["password"]},
    )
    assert missing.status_code == 200, missing.text
    assert missing.json()["evidence_id"]
    assert missing.json()["comment"] is None

    # Whitespace-only is normalised rather than rejected.
    blank = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", user["password"], comment="   "),
    )
    assert blank.status_code == 200, blank.text
    assert blank.json()["evidence_id"]


async def test_reauth_response_carries_no_signature_image(
    client: AsyncClient,
) -> None:
    """The e-signature is the password — there is no image field any more.

    Guard for the 2026-08-03 removal: ``signature_image_s3_key`` is gone from
    the request schema, the response and the ``audit.reauth_events`` table
    (migration ``esignimg01``).
    """
    user = await _bootstrap_user(client)

    resp = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("movement.receipt", user["password"], comment="why"),
    )
    assert resp.status_code == 200, resp.text
    assert "signature_image_s3_key" not in resp.json()

    # And an old client still sending the field is told plainly, rather than
    # having it silently ignored (``extra="forbid"`` on ReauthRequest).
    stale_client = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json={
            "action": "movement.receipt",
            "password": user["password"],
            "signature_image_s3_key": "signatures/whatever.png",
        },
    )
    assert stale_client.status_code == 422, stale_client.text


async def test_reauth_isolated_per_user(client: AsyncClient) -> None:
    """User A's failures can't lock user B out — rate limit is per-user."""
    user_a = await _bootstrap_user(client)
    user_b = await _bootstrap_user(client)

    # Burn 5 failures on A → A is locked.
    for i in range(5):
        await client.post(
            "/v1/auth/reauth",
            headers=_auth_headers(user_a["access_token"]),
            json=_body("movement.receipt", f"Wrong{i}!1A"),
        )
    locked_a = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user_a["access_token"]),
        json=_body("movement.receipt", user_a["password"]),
    )
    assert locked_a.status_code == 429

    # B should be completely unaffected.
    ok_b = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user_b["access_token"]),
        json=_body("movement.receipt", user_b["password"]),
    )
    assert ok_b.status_code == 200, ok_b.text


async def test_subject_binding_persists_over_http(client: AsyncClient) -> None:
    """End-to-end HTTP proof that the subject reaches the database (VR-006).

    The unit tests in ``test_esign_subject_binding.py`` call the consume
    function directly. This one goes through the real endpoint — schema,
    route, service, ORM — because a break anywhere in that chain shows up as
    a silently NULL subject rather than an error, which is exactly the
    failure mode that is hard to notice.
    """
    import uuid as _uuid

    from app.db.session import get_sessionmaker
    from app.models.audit import ReauthEvent as _RE
    from sqlalchemy import select as _select

    user = await _bootstrap_user(client)
    lot_id = str(_uuid.uuid4())

    resp = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body(
            "lot.update",
            user["password"],
            record_table="app.lots",
            record_id=lot_id,
        ),
    )
    assert resp.status_code == 200, resp.text
    evidence_id = resp.json()["evidence_id"]

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as s:
        row = (
            await s.execute(_select(_RE).where(_RE.id == _uuid.UUID(evidence_id)))
        ).scalar_one()
        assert row.record_table == "app.lots", "record_table did not persist"
        assert str(row.record_id) == lot_id, "record_id did not persist"


async def test_reauth_without_subject_leaves_it_null(client: AsyncClient) -> None:
    """Omitting the subject is still allowed (create flows, forecast grid)."""
    import uuid as _uuid

    from app.db.session import get_sessionmaker
    from app.models.audit import ReauthEvent as _RE
    from sqlalchemy import select as _select

    user = await _bootstrap_user(client)
    resp = await client.post(
        "/v1/auth/reauth",
        headers=_auth_headers(user["access_token"]),
        json=_body("tier.create", user["password"]),
    )
    assert resp.status_code == 200, resp.text

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as s:
        row = (
            await s.execute(
                _select(_RE).where(_RE.id == _uuid.UUID(resp.json()["evidence_id"]))
            )
        ).scalar_one()
        assert row.record_table is None
        assert row.record_id is None
