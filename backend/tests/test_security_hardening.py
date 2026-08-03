"""Regression guards for the 2026-08-03 security hardening pass.

Each test names the finding it defends so a future change that reopens one
fails here with the reason attached, rather than silently reverting a
control nobody remembers adding.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from app.auth.provisioning import _safe_role
from app.core.bounds import MAX_MONEY, MAX_QTY
from app.core.logging import _redact_sensitive
from app.core.search import escape_like, like_contains
from pydantic import ValidationError as PydanticValidationError

# ── VR-007: privilege escalation via a self-assertable Cognito attribute ────


def test_super_admin_is_never_provisioned_from_a_token_claim() -> None:
    """``custom:role`` is user-writable on a misconfigured app client.

    If it can be self-asserted, provisioning it verbatim turns a claim the
    holder controls into the role that bypasses every permission check.
    """
    assert _safe_role("super_admin") == "read_only"


@pytest.mark.parametrize("role", ["admin", "operator", "read_only"])
def test_ordinary_roles_still_provision(role: str) -> None:
    assert _safe_role(role) == role


@pytest.mark.parametrize("junk", [None, "", "root", "Super_Admin", "administrator"])
def test_unknown_roles_fall_back_to_least_privilege(junk: str | None) -> None:
    assert _safe_role(junk) == "read_only"


# ── VR-005 / VR-013: eliminated by removal, not by mitigation ───────────────
#
# Both findings lived on the signature-image endpoints:
#   VR-005 — any authenticated user could fetch any operator's signature
#   VR-013 — the upload trusted the caller's Content-Type
# They were fixed on 2026-08-03 and then the whole feature was removed later
# the same day (client decision: an e-signature is the password
# re-authentication). ``app/api/v1/routes/uploads.py`` and ``app/storage/``
# no longer exist, so the magic-byte and IDOR tests that used to sit here
# have gone with them — there is no code path left to guard.
#
# The surviving guard is in tests/test_reauth.py:
# ``test_reauth_response_carries_no_signature_image``.


# ── VR-025: LIKE wildcard injection into search ─────────────────────────────


def test_escapes_like_wildcards() -> None:
    """``%`` alone matched every row and forced a full scan."""
    assert escape_like("100%") == "100\\%"
    assert escape_like("a_b") == "a\\_b"
    # Backslash is escaped FIRST, otherwise it would escape the escapes.
    assert escape_like("a\\b") == "a\\\\b"
    assert like_contains("100%") == "%100\\%%"


def test_ordinary_text_is_untouched() -> None:
    assert like_contains("lot-42") == "%lot-42%"


# ── VR-012: unbounded numerics ──────────────────────────────────────────────


def test_quantity_upper_bound_rejects_int4_overflow() -> None:
    """2**31 passed ``gt=0`` and blew up as a DataError at flush time.

    DataError isn't IntegrityError, so the handlers that wrap writes didn't
    catch it and it surfaced as an unhandled 500.
    """
    from app.shipments.schemas import ShipSourceInput

    with pytest.raises(PydanticValidationError):
        ShipSourceInput(node_id="n", lot_id="l", qty=2**31)

    # A realistic value still works.
    assert ShipSourceInput(node_id="n", lot_id="l", qty=5).qty == 5
    assert MAX_QTY < 2**31


def test_money_bound_stays_inside_the_column() -> None:
    """Numeric(14,2) holds 12 integer digits; the bound sits below that."""
    assert Decimal("10") ** 12 > MAX_MONEY


# ── VR-028: credential leakage into logs ────────────────────────────────────


def test_redacts_credentials() -> None:
    event = {
        "event": "auth.thing",
        "password": "hunter2",
        "refresh_token": "eyJ...",
        "Authorization": "Bearer abc",
        "api_key": "k",
        "session": "s",
    }
    out = _redact_sensitive(None, "", dict(event))
    for key in ("password", "refresh_token", "Authorization", "api_key", "session"):
        assert out[key] == "[redacted]", key


def test_masks_email_but_keeps_it_useful() -> None:
    out = _redact_sensitive(None, "", {"email": "alice@example.com"})
    assert out["email"] == "a***@example.com"


def test_leaves_ordinary_fields_alone() -> None:
    out = _redact_sensitive(None, "", {"user_id": "u-1", "count": 3, "event": "x"})
    assert out == {"user_id": "u-1", "count": 3, "event": "x"}


# ── VR-014 / VR-030: configuration invariants ───────────────────────────────


# Settings reads the ambient environment and .env by default. Inside the dev
# container both are populated (APP_DEBUG, COGNITO_ENDPOINT_URL, …), which
# would leak into these cases and make them assert against the wrong config.
# Build each Settings from ONLY what the test passes.
_CONFIG_ENV_KEYS = (
    "APP_ENV",
    "APP_DEBUG",
    "SECRET_KEY",
    "DATABASE_URL",
    "CORS_ALLOW_ORIGINS",
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_ENDPOINT_URL",
    "COGNITO_ISSUER",
    "TRUSTED_PROXY_COUNT",
)


@pytest.fixture(autouse=True)
def _isolate_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _CONFIG_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _settings(**overrides: object):
    from app.core.config import Settings

    base: dict[str, object] = {
        "secret_key": "s" * 20 + "ecure-random-value-not-an-example-42",
        "database_url": "postgresql+asyncpg://u:p@h:5432/d",
    }
    base.update(overrides)
    # ``_env_file=None`` stops the .env on disk from supplying anything.
    return Settings(_env_file=None, **base)  # type: ignore[arg-type]


def test_wildcard_cors_is_refused() -> None:
    """``*`` with allow_credentials=True is any-origin-with-credentials."""
    with pytest.raises(PydanticValidationError, match="CORS_ALLOW_ORIGINS"):
        _settings(cors_allow_origins=["*"])


def test_explicit_cors_origins_are_fine() -> None:
    s = _settings(cors_allow_origins=["https://app.example.com"])
    assert s.cors_allow_origins == ["https://app.example.com"]


def test_production_rejects_the_committed_example_secret() -> None:
    """Length alone never proved a secret was secret.

    The committed dev value is 48 characters and passed ``min_length=32``.
    """
    with pytest.raises(PydanticValidationError, match="SECRET_KEY"):
        _settings(
            app_env="production",
            secret_key="dev-only-change-in-prod-32-chars-min-aaaaaaaa",
            cognito_user_pool_id="us-east-1_ABC",
            cognito_client_id="cid",
        )


def test_production_rejects_debug_mode() -> None:
    with pytest.raises(PydanticValidationError, match="APP_DEBUG"):
        _settings(
            app_env="production",
            app_debug=True,
            cognito_user_pool_id="us-east-1_ABC",
            cognito_client_id="cid",
        )


def test_production_requires_cognito() -> None:
    with pytest.raises(PydanticValidationError, match="COGNITO_USER_POOL_ID"):
        _settings(app_env="production")


def test_development_is_not_subject_to_production_invariants() -> None:
    """Dev must stay convenient — the guard is production-only."""
    s = _settings(
        app_env="development",
        secret_key="dev-only-change-in-prod-32-chars-min-aaaaaaaa",
        app_debug=True,
    )
    assert s.app_debug is True
