"""Integration tests for the user-invitation flow.

Like ``test_auth``, these hit a *real* cognito-local instance + the test
database, so the whole file is skipped unless ``COGNITO_USER_POOL_ID`` is set.
Each test uses random emails so repeated runs don't collide (there is no
teardown of cognito-local users).

Covered: the happy path (invite → resolve → accept → login), RBAC (only
super_admin may invite), duplicate/pending conflicts, invalid/expired/used
tokens, weak-password rejection at accept, revoke, and resend.
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


def _random_email(prefix: str = "pytest-inv") -> str:
    return f"{prefix}-{secrets.token_hex(6)}@cellready.local"


def _strong_password() -> str:
    # >=12 chars with upper/lower/digit/symbol — satisfies both the dev
    # cognito-local (min 8) and prod (min 12) password policies.
    return f"Invite{secrets.token_hex(5)}!9Az"


def _provision_cognito_user(*, email: str, password: str, role: str, name: str) -> None:
    """admin-create + permanent-password a Cognito user, the seed-script way."""
    from app.auth.cognito_client import get_cognito_client
    from app.core.config import get_settings

    settings = get_settings()
    client = get_cognito_client()
    pool_id = settings.cognito_user_pool_id
    client.admin_create_user(
        UserPoolId=pool_id,  # type: ignore[arg-type]
        Username=email,
        MessageAction="SUPPRESS",
        UserAttributes=[
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "name", "Value": name},
            {"Name": "custom:role", "Value": role},
        ],
    )
    client.admin_set_user_password(
        UserPoolId=pool_id,  # type: ignore[arg-type]
        Username=email,
        Password=password,
        Permanent=True,
    )


async def _login(client: AsyncClient, email: str, password: str) -> str:
    resp = await client.post("/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return str(resp.json()["access_token"])


async def _actor(client: AsyncClient, *, role: str) -> dict[str, str]:
    """Provision + log in an actor with ``role`` and return an auth header."""
    email = _random_email(f"pytest-{role}")
    password = _strong_password()
    _provision_cognito_user(email=email, password=password, role=role, name=f"{role} Actor")
    token = await _login(client, email, password)
    return {"Authorization": f"Bearer {token}"}


async def _invite(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    email: str | None = None,
    role: str = "operator",
) -> dict[str, Any]:
    email = email or _random_email()
    resp = await client.post(
        "/v1/invitations",
        headers=headers,
        json={
            "email": email,
            "first_name": "New",
            "last_name": "Person",
            "role": role,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    body["_email"] = email
    return body


# ── Tests ──────────────────────────────────────────────────────────────────


async def test_invite_then_resolve_accept_and_login(client: AsyncClient) -> None:
    """End-to-end: super_admin invites → public resolve → accept sets password
    and returns a session → the invitee can then log in and /me is active."""
    admin = await _actor(client, role="super_admin")
    invite = await _invite(client, admin, role="operator")

    assert invite["token"]
    assert invite["accept_path"] == f"/accept-invite/{invite['token']}"
    assert invite["status"] == "pending"

    # Public resolve prefills the accept page (token in the POST body).
    resolved = await client.post("/v1/invitations/resolve", json={"token": invite["token"]})
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["email"] == invite["_email"]
    assert resolved.json()["role"] == "operator"

    # Accept sets the password and returns a full token set (auto-login).
    password = _strong_password()
    accepted = await client.post(
        "/v1/auth/accept-invite",
        json={"token": invite["token"], "password": password},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["access_token"]
    assert accepted.json()["refresh_token"]

    # The invitee can now log in normally.
    token = await _login(client, invite["_email"], password)
    me = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200, me.text
    assert me.json()["email"] == invite["_email"]
    assert me.json()["role"] == "operator"
    assert me.json()["is_active"] is True


async def test_operator_cannot_invite(client: AsyncClient) -> None:
    """RBAC: a non-super-admin is refused with permission_denied (403)."""
    operator = await _actor(client, role="operator")
    resp = await client.post(
        "/v1/invitations",
        headers=operator,
        json={"email": _random_email(), "first_name": "N", "last_name": "P", "role": "operator"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == "permission_denied"


async def test_admin_cannot_invite(client: AsyncClient) -> None:
    """admin has users:view but not users:create — invite is forbidden."""
    admin = await _actor(client, role="admin")
    resp = await client.post(
        "/v1/invitations",
        headers=admin,
        json={"email": _random_email(), "first_name": "N", "last_name": "P", "role": "operator"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == "permission_denied"


async def test_invite_unauthenticated_is_401(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/invitations",
        json={"email": _random_email(), "first_name": "N", "last_name": "P", "role": "operator"},
    )
    assert resp.status_code == 401


async def test_duplicate_pending_invite_is_conflict(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    invite = await _invite(client, admin)
    resp = await client.post(
        "/v1/invitations",
        headers=admin,
        json={"email": invite["_email"], "first_name": "N", "last_name": "P", "role": "operator"},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "invite_pending"


async def test_invite_existing_active_user_is_conflict(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    # Make an active member: provision + login + hit /me (lazy-provisions the row).
    email = _random_email("pytest-member")
    password = _strong_password()
    _provision_cognito_user(email=email, password=password, role="operator", name="Existing Member")
    token = await _login(client, email, password)
    me = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200, me.text

    resp = await client.post(
        "/v1/invitations",
        headers=admin,
        json={"email": email, "first_name": "N", "last_name": "P", "role": "operator"},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "user_exists"


async def test_invalid_role_is_request_invalid(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    resp = await client.post(
        "/v1/invitations",
        headers=admin,
        json={"email": _random_email(), "first_name": "N", "last_name": "P", "role": "wizard"},
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "request_invalid"


async def test_resolve_unknown_token_is_422(client: AsyncClient) -> None:
    resp = await client.post("/v1/invitations/resolve", json={"token": "not-a-real-token"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "invite_invalid"


async def test_accept_unknown_token_is_422(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/auth/accept-invite",
        json={"token": "not-a-real-token", "password": _strong_password()},
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "invite_invalid"


async def test_accept_twice_second_is_422(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    invite = await _invite(client, admin)
    password = _strong_password()

    first = await client.post(
        "/v1/auth/accept-invite", json={"token": invite["token"], "password": password}
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        "/v1/auth/accept-invite", json={"token": invite["token"], "password": _strong_password()}
    )
    assert second.status_code == 422, second.text
    assert second.json()["code"] == "invite_invalid"


def test_admin_set_password_maps_policy_error_to_validation(monkeypatch: Any) -> None:
    """A password-policy failure must surface as a 422 the invitee can act on,
    not a fail-closed 401 — for BOTH real Cognito (typed
    ``InvalidPasswordException``) and cognito-local (HTTP-status Code slot).

    cognito-local doesn't actually enforce the policy on
    ``admin_set_user_password`` (it accepts anything), so we can't drive this
    end-to-end there — this unit-tests the facade's error mapping directly.
    """
    from app.auth import cognito_client
    from app.core.exceptions import ValidationError
    from botocore.exceptions import ClientError

    class _Boom:
        def admin_set_user_password(self, **_kwargs: Any) -> None:
            raise ClientError(
                {
                    "Error": {
                        # cognito-local puts the HTTP status here, not the typed name.
                        "Code": "400",
                        "Message": "Password does not conform to policy: "
                        "Password not long enough",
                    }
                },
                "AdminSetUserPassword",
            )

    monkeypatch.setattr(cognito_client, "get_cognito_client", lambda: _Boom())
    with pytest.raises(ValidationError) as excinfo:
        cognito_client.admin_set_user_password(email="x@y.local", password="weak")
    assert excinfo.value.code == "invalid_password"


async def test_revoked_invite_cannot_be_accepted(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    invite = await _invite(client, admin)

    revoked = await client.post(f"/v1/invitations/{invite['id']}/revoke", headers=admin)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["status"] == "revoked"

    resp = await client.post(
        "/v1/auth/accept-invite", json={"token": invite["token"], "password": _strong_password()}
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "invite_invalid"


async def test_resend_invalidates_old_link(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    invite = await _invite(client, admin)
    old_token = invite["token"]

    resent = await client.post(f"/v1/invitations/{invite['id']}/resend", headers=admin)
    assert resent.status_code == 200, resent.text
    new_token = resent.json()["token"]
    assert new_token != old_token

    # Old link is dead.
    old = await client.post(
        "/v1/auth/accept-invite", json={"token": old_token, "password": _strong_password()}
    )
    assert old.status_code == 422, old.text

    # New link works.
    new = await client.post(
        "/v1/auth/accept-invite", json={"token": new_token, "password": _strong_password()}
    )
    assert new.status_code == 200, new.text


async def test_resend_refuses_when_email_is_active_member(client: AsyncClient) -> None:
    """Guard against re-roling a live account: once an email belongs to an
    active user, a stale (revoked) invite for it can't be resurrected."""
    admin = await _actor(client, role="super_admin")
    email = _random_email("pytest-active")

    # Invite -> revoke (email not yet a member).
    first = await _invite(client, admin, email=email, role="super_admin")
    revoked = await client.post(f"/v1/invitations/{first['id']}/revoke", headers=admin)
    assert revoked.status_code == 200, revoked.text

    # A fresh invite for the same email, accepted -> the email is now an ACTIVE member.
    second = await _invite(client, admin, email=email, role="operator")
    accepted = await client.post(
        "/v1/auth/accept-invite",
        json={"token": second["token"], "password": _strong_password()},
    )
    assert accepted.status_code == 200, accepted.text

    # Resending the stale (revoked) invite must now be refused.
    resp = await client.post(f"/v1/invitations/{first['id']}/resend", headers=admin)
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "user_exists"


async def test_deactivated_user_is_locked_out(client: AsyncClient) -> None:
    """A user flipped to is_active=false is refused on protected routes even
    with a still-valid token (the DB flag is authoritative)."""
    admin = await _actor(client, role="super_admin")

    email = _random_email("pytest-deact")
    password = _strong_password()
    _provision_cognito_user(email=email, password=password, role="operator", name="Deact User")
    token = await _login(client, email, password)
    headers = {"Authorization": f"Bearer {token}"}

    # Active operator can read inventory.
    me = await client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    user_id = me.json()["id"]
    before = await client.get("/v1/items", headers=headers)
    assert before.status_code == 200, before.text

    # Super-admin deactivates them.
    patched = await client.patch(f"/v1/users/{user_id}", headers=admin, json={"is_active": False})
    assert patched.status_code == 200, patched.text
    assert patched.json()["is_active"] is False

    # The still-valid token is now refused on a protected route.
    after = await client.get("/v1/items", headers=headers)
    assert after.status_code == 403, after.text
    assert after.json()["code"] == "account_inactive"

    # And a fresh login is refused too (valid password isn't enough).
    relogin = await client.post(
        "/v1/auth/login", json={"email": email, "password": password}
    )
    assert relogin.status_code == 401, relogin.text
    assert relogin.json()["code"] == "account_inactive"


async def test_edit_user_name(client: AsyncClient) -> None:
    """Super admin can rename a user without touching role/active."""
    admin = await _actor(client, role="super_admin")

    email = _random_email("pytest-rename")
    password = _strong_password()
    _provision_cognito_user(email=email, password=password, role="operator", name="Old Name")
    token = await _login(client, email, password)
    me = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200, me.text
    user_id = me.json()["id"]

    resp = await client.patch(
        f"/v1/users/{user_id}",
        headers=admin,
        json={"first_name": "Renamed", "last_name": "Person"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["first_name"] == "Renamed"
    assert body["last_name"] == "Person"
    assert body["full_name"] == "Renamed Person"
    # Role/active untouched.
    assert body["role"] == "operator"
    assert body["is_active"] is True


async def test_list_invitations_requires_view_permission(client: AsyncClient) -> None:
    admin = await _actor(client, role="super_admin")
    await _invite(client, admin)
    listed = await client.get("/v1/invitations", headers=admin)
    assert listed.status_code == 200, listed.text
    assert isinstance(listed.json(), list)
    assert len(listed.json()) >= 1

    # An operator can't view the invitations directory.
    operator = await _actor(client, role="operator")
    denied = await client.get("/v1/invitations", headers=operator)
    assert denied.status_code == 403, denied.text
    assert denied.json()["code"] == "permission_denied"
