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

from pydantic import AnyHttpUrl, BeforeValidator, Field, PostgresDsn, SecretStr
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

    # ── S3 / object storage ─────────────────────────────────────────────
    # In dev these point at the MinIO container. In prod, ``s3_endpoint_url``
    # is left unset so boto3 hits real AWS S3, and the access key / secret
    # come from the deploy account's IAM role (the env-var path is a
    # convenience fallback for non-EC2 hosts).
    s3_endpoint_url: OptionalHttpUrl = None
    s3_region: str = "us-east-1"
    s3_access_key_id: SecretStr | None = None
    s3_secret_access_key: SecretStr | None = None
    # Bucket that holds e-signature images. Must be created out-of-band
    # in prod; the dev lifespan auto-creates it against MinIO.
    s3_signatures_bucket: str = "cellready-signatures"
    # Required for MinIO (and accepted by AWS S3). Without this, boto3
    # tries virtual-hosted-style URLs which only work for real S3
    # buckets — MinIO 404s on them.
    s3_force_path_style: bool = True

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
