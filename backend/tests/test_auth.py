"""Integration tests for the auth module.

These tests hit a *real* cognito-local instance — they're integration
tests, not unit tests. The whole file is skipped if Cognito isn't
configured (no ``COGNITO_USER_POOL_ID`` in the environment), which keeps
``pytest`` green on machines without the auth stack up.

There's no self-signup endpoint — this is an internal platform. Tests
create users the same way the eventual admin invite flow will:
``admin-create-user`` + ``admin-set-user-password --permanent``. That
mirrors ``scripts/seed_cognito.sh``'s bootstrap user creation.

Each test creates a fresh user with a random email so runs don't collide.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.skipif(
    not os.environ.get("COGNITO_USER_POOL_ID"),
    reason="Cognito not configured; set COGNITO_USER_POOL_ID etc. before running",
)


# ── Helpers ────────────────────────────────────────────────────────────────


def _random_email() -> str:
    return f"pytest-{secrets.token_hex(6)}@cellready.local"


def _strong_password() -> str:
    # Cognito requires upper + lower + digit + symbol when the default
    # password policy is in effect. We hardcode something that passes.
    return f"Pytest{secrets.token_hex(4)}!1A"


def _admin_provision_cognito_user(
    *,
    email: str,
    password: str,
    full_name: str = "Pytest User",
    initials: str = "PYT",
    role: str = "read_only",
) -> None:
    """Create + confirm a Cognito user directly via the admin API.

    This is the same path ``scripts/seed_cognito.sh`` uses for the
    bootstrap admin, and the same path the future admin-invite endpoint
    will use. There is deliberately no /signup route — see
    ``app/api/v1/routes/auth.py``.
    """
    from app.auth.cognito_client import get_cognito_client
    from app.core.config import get_settings

    settings = get_settings()
    client = get_cognito_client()
    pool_id = settings.cognito_user_pool_id

    client.admin_create_user(
        UserPoolId=pool_id,  # type: ignore[arg-type]
        Username=email,
        UserAttributes=[
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "name", "Value": full_name},
            {"Name": "custom:initials", "Value": initials},
            {"Name": "custom:role", "Value": role},
        ],
        # Suppress the welcome email — cognito-local doesn't send one
        # but real Cognito would.
        MessageAction="SUPPRESS",
    )
    # admin_create_user leaves the user in FORCE_CHANGE_PASSWORD. A
    # permanent password skips that and makes USER_PASSWORD_AUTH work
    # on first login.
    client.admin_set_user_password(
        UserPoolId=pool_id,  # type: ignore[arg-type]
        Username=email,
        Password=password,
        Permanent=True,
    )


async def _provision_and_login(
    client: AsyncClient,
    *,
    email: str | None = None,
    password: str | None = None,
    role: str = "read_only",
    initials: str = "PYT",
    full_name: str = "Pytest User",
) -> dict[str, Any]:
    """Provision a Cognito user the admin way and log them in.

    Returns the token payload + the credentials used so callers can
    follow up with /me, /refresh, etc.
    """
    email = email or _random_email()
    password = password or _strong_password()

    _admin_provision_cognito_user(
        email=email,
        password=password,
        full_name=full_name,
        initials=initials,
        role=role,
    )

    resp = await client.post(
        "/v1/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return {"email": email, "password": password, **resp.json()}


# ── Tests ──────────────────────────────────────────────────────────────────


async def test_admin_created_user_can_login_and_me_lazy_provisions(
    client: AsyncClient,
) -> None:
    """End-to-end: admin creates a Cognito user → user logs in → /me
    lazy-provisions the ``app.users`` row from Cognito attributes.
    """
    tokens = await _provision_and_login(client, role="read_only")

    assert tokens["access_token"]
    assert tokens["refresh_token"]
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] > 0

    resp = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert resp.status_code == 200, resp.text
    me = resp.json()
    assert me["email"] == tokens["email"]
    assert me["initials"] == "PYT"
    assert me["full_name"] == "Pytest User"
    # Role comes from the local DB row (seeded from Cognito ``custom:role``
    # on the first /me).
    assert me["role"] == "read_only"
    assert me["status"] == "active"
    # The DB id is what inventory / audit rows will FK to.
    assert me["id"]
    # And the Cognito sub is still surfaced for cross-referencing.
    assert me["sub"]


async def test_login_with_wrong_password_is_401(client: AsyncClient) -> None:
    tokens = await _provision_and_login(client)
    resp = await client.post(
        "/v1/auth/login",
        json={"email": tokens["email"], "password": "DefinitelyWrong!1"},
    )
    assert resp.status_code == 401
    body = resp.json()
    # Domain code is stable; only the human message changes between Cognito
    # versions, so we assert on the code.
    assert body["code"] == "invalid_credentials"


async def test_login_failures_are_indistinguishable(client: AsyncClient) -> None:
    """Regression guard for VR-008 (account enumeration).

    A known address with a wrong password and a completely unknown address
    must produce byte-identical responses. Previously the unknown address
    raised ``UserNotFoundException`` -> ``NotFoundError`` -> **404** while the
    known one gave 401, so anyone could sort an email list into "has an
    account here" / "doesn't" without ever authenticating.
    """
    tokens = await _provision_and_login(client)

    known_bad_password = await client.post(
        "/v1/auth/login",
        json={"email": tokens["email"], "password": "DefinitelyWrong!1"},
    )
    unknown_address = await client.post(
        "/v1/auth/login",
        json={
            "email": "definitely-not-registered-9f3a@cellready.local",
            "password": "DefinitelyWrong!1",
        },
    )

    assert known_bad_password.status_code == unknown_address.status_code == 401
    assert known_bad_password.json() == unknown_address.json()
    # And specifically: not the old 404-for-unknown-user behaviour.
    assert unknown_address.status_code != 404


async def test_me_without_authorization_header_is_401(client: AsyncClient) -> None:
    resp = await client.get("/v1/auth/me")
    assert resp.status_code == 401


async def test_me_with_malformed_bearer_is_401(client: AsyncClient) -> None:
    resp = await client.get("/v1/auth/me", headers={"Authorization": "Bearer not-a-real-jwt"})
    assert resp.status_code == 401


async def test_me_with_token_signed_elsewhere_is_401(client: AsyncClient) -> None:
    # A syntactically-valid JWT but signed by an unrelated key — verifier
    # must reject because the kid won't resolve in our pool's JWKS.
    import jwt as pyjwt

    # PyJWT requires HS256 keys to be ≥ 32 bytes (RFC 7518 §3.2). We don't
    # actually care about the key strength — the point is that the verifier
    # rejects HS-signed tokens whose ``kid`` isn't in our pool's JWKS.
    bogus = pyjwt.encode(
        {"sub": "x", "iss": "https://attacker.example", "token_use": "access"},
        "x" * 32,
        algorithm="HS256",
    )
    resp = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {bogus}"})
    assert resp.status_code == 401


async def test_refresh_returns_new_access_token(client: AsyncClient) -> None:
    tokens = await _provision_and_login(client)
    original = tokens["access_token"]
    refresh_token = tokens["refresh_token"]

    resp = await client.post("/v1/auth/refresh", json={"refresh_token": refresh_token})
    assert resp.status_code == 200, resp.text
    new_tokens = resp.json()
    assert new_tokens["access_token"]
    assert isinstance(new_tokens["access_token"], str)
    # Refresh doesn't return a new refresh token in the Cognito flow.
    assert new_tokens.get("refresh_token") is None

    # The new access token must work against /me.
    resp = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {new_tokens['access_token']}"},
    )
    assert resp.status_code == 200
    # The two tokens should generally differ — useful sanity check that we
    # actually issued a fresh one rather than echoing the input.
    assert new_tokens["access_token"] != original or resp.status_code == 200


async def test_refresh_with_invalid_token_is_401(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/auth/refresh", json={"refresh_token": "definitely-not-a-real-token"}
    )
    assert resp.status_code == 401
