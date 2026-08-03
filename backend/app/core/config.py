"""Application configuration.

All settings come from environment variables (12-factor). In development they
can be loaded from a local ``.env`` file; in production the env is the only
source of truth.

The settings object is a singleton accessed via ``get_settings()`` so that the
``.env`` is read exactly once and downstream code never reaches for ``os.environ``
directly.
"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache
from typing import Annotated

from pydantic import (
    AnyHttpUrl,
    BeforeValidator,
    Field,
    PostgresDsn,
    SecretStr,
    model_validator,
)
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Environment(str, Enum):
    development = "development"
    staging = "staging"
    production = "production"
    test = "test"


class LogFormat(str, Enum):
    console = "console"
    json = "json"


def _split_csv(v: str | list[str]) -> list[str]:
    """Allow CORS_ALLOW_ORIGINS to come in as ``a,b,c`` from a single env var."""
    if isinstance(v, list):
        return v
    if not v:
        return []
    return [item.strip().rstrip("/") for item in v.split(",") if item.strip()]


# NoDecode tells pydantic-settings not to JSON-parse the env value; our
# BeforeValidator then turns the raw string into a list of origins.
CommaSeparated = Annotated[list[str], NoDecode, BeforeValidator(_split_csv)]


def _empty_to_none(v: object) -> object:
    """Treat a blank env var as unset for optional fields.

    docker-compose passes ``${VAR:-}`` which arrives as an empty string. For
    optional URL fields that defeats the ``| None`` default — pydantic tries to
    URL-parse ``""`` and fails. Mapping blank → ``None`` restores the intended
    "unset, derive it" behaviour.
    """
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


# Optional URL that tolerates a blank env var (treated as unset → None).
OptionalHttpUrl = Annotated[AnyHttpUrl | None, BeforeValidator(_empty_to_none)]


class Settings(BaseSettings):
    """Strongly-typed application configuration.

    Fields are validated on import; a malformed environment fails fast at
    startup rather than at the first request.
    """

    # ── App identity ────────────────────────────────────────────────────
    app_name: str = "cellready-ims-backend"
    app_env: Environment = Environment.development
    app_debug: bool = False

    # ── HTTP server ─────────────────────────────────────────────────────
    host: str = "0.0.0.0"  # noqa: S104 — intentional inside containers
    port: int = 8000

    # ── Security ────────────────────────────────────────────────────────
    secret_key: SecretStr = Field(..., min_length=32)
    # Cognito issues tokens with TTLs configured on the user pool client.
    # We mirror those values here so the frontend BFF can size cookie
    # max-ages to match without a second round-trip. ``scripts/seed_cognito.sh``
    # is the source-of-truth for applying them to Cognito itself.
    jwt_access_token_ttl_minutes: int = Field(default=60, ge=5, le=24 * 60)
    jwt_id_token_ttl_minutes: int = Field(default=60, ge=5, le=24 * 60)
    jwt_refresh_token_ttl_days: int = Field(default=30, ge=1, le=365)

    # ── Database ────────────────────────────────────────────────────────
    database_url: PostgresDsn

    # ── CORS ────────────────────────────────────────────────────────────
    cors_allow_origins: CommaSeparated = Field(default_factory=list)

    # ── Proxy / client-IP trust ─────────────────────────────────────────
    # How many reverse proxies sit between the internet and this app. The
    # client IP written to Part 11 audit rows is taken from this many hops
    # in on ``X-Forwarded-For``; everything further left in the chain was
    # supplied by the caller and is discarded (see routes/auth.py
    # ``_client_ip``).
    #
    # 0 = trust nothing, use the socket peer. That is the correct default:
    # trusting a header nobody put there is how a browser gets to choose
    # the IP recorded against its own e-signature.
    #
    # Typical deployed value here is 2 (CloudFront → the Next.js BFF).
    # Count the hops for YOUR topology before changing it; too high is as
    # wrong as too low, in the other direction.
    trusted_proxy_count: int = Field(default=0, ge=0, le=8)

    # ── Logging ─────────────────────────────────────────────────────────
    log_level: str = "INFO"
    log_format: LogFormat = LogFormat.console

    # NOTE: there are deliberately no ``superadmin_*`` settings here. The
    # bootstrap account is created by ``scripts/seed_super_admins.py``, which
    # takes ``--email`` and ``--password`` as required arguments — it reads no
    # configuration at all. Nothing at runtime needs them either: the startup
    # check in ``app.core.lifespan`` counts super_admin rows in the database
    # rather than comparing against a configured address.

    # ── AWS / Cognito ───────────────────────────────────────────────────
    # All Cognito fields are optional so the service can boot without auth
    # configured (e.g. early-dev workflows that only exercise /health).
    # Once a token actually hits the wire, the verifier will surface a
    # clear error if these are missing.
    aws_region: str = "us-east-1"
    cognito_user_pool_id: str | None = None
    cognito_client_id: str | None = None
    # Set this ONLY in local dev — it routes boto3 to cognito-local instead
    # of real AWS. Leaving it unset in prod is how we hit real Cognito with
    # zero code changes.
    cognito_endpoint_url: OptionalHttpUrl = None
    # Override of the JWKS URL. If unset we derive it from
    # `cognito_endpoint_url` (local) or the AWS standard host (prod).
    cognito_jwks_url: OptionalHttpUrl = None
    # Override of the expected ``iss`` claim. cognito-local hardcodes
    # ``http://localhost:9229/<pool>`` regardless of which host the backend
    # uses to talk to it, so the URL we *call* and the URL the token *claims
    # to be from* are different. Real Cognito has no such issue. Leave
    # unset in prod; set it in local dev to whatever cognito-local emits.
    cognito_issuer: OptionalHttpUrl = None

    # NOTE: there are deliberately no ``s3_*`` settings here. Object storage
    # existed for exactly one thing — the hand-drawn e-signature image — and
    # that was removed on 2026-08-03. An electronic signature in this system
    # is the password re-authentication plus the audit row it writes; there
    # is no artefact to store. ``extra="ignore"`` below means a leftover
    # ``S3_*`` in someone's stale .env is quietly disregarded rather than
    # failing the boot.

    # ── Invitations ─────────────────────────────────────────────────────
    # Public web origin for the app. Optional; kept for building absolute links
    # in server-rendered contexts. The invite email itself is sent by Cognito
    # (temporary password), delivered via Amazon SES when the pool is configured
    # for it — the backend sends no email of its own.
    frontend_base_url: OptionalHttpUrl = None
    # How long an invite (the Cognito temporary password) stays valid before the
    # admin should resend. Keep aligned with the pool's temp-password expiry.
    invite_ttl_days: int = Field(default=7, ge=1, le=90)

    # ── API metadata ────────────────────────────────────────────────────
    api_v1_prefix: str = "/v1"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        # Reject env values that look intentional but mistyped (e.g. "True" for an int)
        validate_default=True,
    )

    # ── Invariants ──────────────────────────────────────────────────────

    @model_validator(mode="after")
    def _reject_wildcard_cors_with_credentials(self) -> Settings:
        """Refuse ``CORS_ALLOW_ORIGINS=*``.

        The CORS middleware is mounted with ``allow_credentials=True`` (see
        app/main.py), and Starlette handles ``allow_origins=["*"]`` with
        credentials by REFLECTING the caller's Origin and returning
        ``Access-Control-Allow-Credentials: true``. That is
        any-origin-with-credentials: every authenticated endpoint becomes
        readable by any site the user visits.

        Nothing sets ``*`` today — this exists so that setting it later is
        a startup failure with an explanation, rather than a silent hole
        that looks like a working config.
        """
        if any(o.strip() == "*" for o in self.cors_allow_origins):
            raise ValueError(
                "CORS_ALLOW_ORIGINS='*' is refused: the API sends credentials, "
                "and a wildcard with credentials lets any origin read "
                "authenticated responses. List the exact origins instead "
                "(e.g. https://app.example.com,https://staging.example.com)."
            )
        return self

    @model_validator(mode="after")
    def _enforce_production_invariants(self) -> Settings:
        """Fail fast when a production process is holding dev settings.

        Length alone never proved a secret was secret: the committed dev
        ``SECRET_KEY`` is 48 characters and sailed through ``min_length=32``.
        These checks look for the specific values that ship in the repo, so
        booting prod with an example config stops the process instead of
        quietly serving traffic with a public key.
        """
        if self.app_env != Environment.production:
            return self

        problems: list[str] = []

        secret = self.secret_key.get_secret_value()
        # Markers present in the committed .env.example values.
        dev_markers = ("dev-only", "change-in-prod", "changeme", "change-me", "example")
        lowered = secret.lower()
        if any(marker in lowered for marker in dev_markers):
            problems.append(
                "SECRET_KEY looks like the committed example value — generate a "
                "fresh one (python -c 'import secrets; print(secrets.token_urlsafe(48))')"
            )
        if len(set(secret)) < 8:
            problems.append(
                "SECRET_KEY has too little variety to be randomly generated"
            )

        if self.app_debug:
            problems.append("APP_DEBUG must be false in production")

        # Without a pool the app cannot verify a token, so every request
        # would fail anyway — better to say so at boot.
        if not self.cognito_user_pool_id or not self.cognito_client_id:
            problems.append(
                "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required in production"
            )
        # This routes auth at a local emulator; in prod it is always a mistake.
        if self.cognito_endpoint_url:
            problems.append(
                "COGNITO_ENDPOINT_URL must be unset in production "
                "(it points boto3 at cognito-local instead of real Cognito)"
            )

        if problems:
            raise ValueError(
                "Refusing to start with APP_ENV=production:\n  - "
                + "\n  - ".join(problems)
            )
        return self

    # ── Convenience accessors ───────────────────────────────────────────
    @property
    def is_production(self) -> bool:
        return self.app_env == Environment.production

    @property
    def is_development(self) -> bool:
        return self.app_env == Environment.development

    @property
    def database_url_sync(self) -> str:
        """Sync DSN — used by Alembic, which doesn't speak asyncpg."""
        return str(self.database_url).replace("+asyncpg", "+psycopg2")

    @property
    def effective_cognito_issuer(self) -> str | None:
        """The expected ``iss`` claim on tokens this pool issues.

        Priority:
        1. ``COGNITO_ISSUER`` env override (needed locally — see field doc).
        2. Derived from ``cognito_endpoint_url`` + pool id (local without
           override, or production with a custom endpoint).
        3. Standard AWS host (production with no endpoint override).
        """
        if self.cognito_issuer:
            return str(self.cognito_issuer).rstrip("/")
        if not self.cognito_user_pool_id:
            return None
        base = (
            str(self.cognito_endpoint_url).rstrip("/")
            if self.cognito_endpoint_url
            else f"https://cognito-idp.{self.aws_region}.amazonaws.com"
        )
        return f"{base}/{self.cognito_user_pool_id}"

    @property
    def effective_jwks_url(self) -> str | None:
        """JWKS URL to fetch signing keys from.

        Uses the explicit override if set; otherwise derives from the issuer.
        """
        if self.cognito_jwks_url:
            return str(self.cognito_jwks_url)
        iss = self.effective_cognito_issuer
        return f"{iss}/.well-known/jwks.json" if iss else None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings instance.

    Cached so that the ``.env`` file is read once. Tests can override by
    calling ``get_settings.cache_clear()`` after patching the environment.
    """
    return Settings()  # type: ignore[call-arg]
