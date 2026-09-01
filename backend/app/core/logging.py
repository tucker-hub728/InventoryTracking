"""Structured logging setup.

Uses ``structlog`` for application logs and routes stdlib ``logging`` (used by
uvicorn, SQLAlchemy, etc.) through the same pipeline so every log line is
either pretty-printed console output (dev) or single-line JSON (prod).

Conventions:
- One log line per event, key=value pairs, no f-string interpolation.
- ``request_id`` is bound by middleware so it appears on every line for the
  request's lifetime.
- ``logger.info("user.invited", user_id=...)`` — event names are dotted and
  read as nouns, not sentences.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog
from structlog.types import EventDict, Processor

from app.core.config import LogFormat, Settings


def _drop_color_message_key(_logger: Any, _name: str, event_dict: EventDict) -> EventDict:
    """uvicorn duplicates ``color_message`` — drop it from structured output."""
    event_dict.pop("color_message", None)
    return event_dict


# ── Redaction ───────────────────────────────────────────────────────────────
# Keys whose VALUE must never reach a log sink. Matched case-insensitively on
# a substring, so ``refresh_token``, ``TOKEN`` and ``id_token`` all hit the
# ``token`` entry.
#
# No password or token is logged anywhere today. This exists so that the
# first `log.info("...", token=tok)` someone writes in a hurry is neutralised
# by default rather than discovered in a log aggregator later — the pipeline
# had no redaction at all, so anything added flowed straight through.
_SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "api_key",
    "apikey",
    "access_key",
    "private_key",
    "session",
    "cookie",
)

# Keys that are personal data rather than credentials. GDPR-relevant and not
# needed to debug: the user id or Cognito sub identifies the actor precisely
# and is already on the line in most cases.
_PII_KEY_PARTS: tuple[str, ...] = ("email",)

_REDACTED = "[redacted]"


def _mask_email(value: object) -> str:
    """``alice@example.com`` -> ``a***@example.com``.

    Keeps the log useful for correlating "same user, repeated failures"
    and for spotting the wrong domain, without storing the address.
    """
    if not isinstance(value, str) or "@" not in value:
        return _REDACTED
    local, _, domain = value.partition("@")
    head = local[0] if local else ""
    return f"{head}***@{domain}"


def _redact_sensitive(_logger: Any, _name: str, event_dict: EventDict) -> EventDict:
    """Strip credentials and mask PII before rendering.

    Runs last in the shared chain so it also covers keys contributed by
    contextvars and by foreign (stdlib) log records.
    """
    for key in list(event_dict.keys()):
        if not isinstance(key, str):
            continue
        lowered = key.lower()
        if any(part in lowered for part in _SENSITIVE_KEY_PARTS):
            event_dict[key] = _REDACTED
        elif any(part in lowered for part in _PII_KEY_PARTS):
            event_dict[key] = _mask_email(event_dict[key])
    return event_dict


def configure_logging(settings: Settings) -> None:
    """Configure structlog + stdlib logging.

    Idempotent: safe to call from tests after a reset.
    """
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    shared_processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        timestamper,
        _drop_color_message_key,
        structlog.processors.StackInfoRenderer(),
        # Last: everything above may have ADDED keys, and redaction has to
        # see the final set.
        _redact_sensitive,
    ]

    if settings.log_format == LogFormat.json:
        renderer: Processor = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())

    # structlog → stdlib bridge
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Replace the root handler with one that goes through structlog
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level.upper())

    # Quiet down noisy libraries
    for noisy in ("uvicorn.access",):
        # Access logs are handled by our own middleware; turn them off here so
        # we don't get the same request logged twice.
        logging.getLogger(noisy).handlers = []
        logging.getLogger(noisy).propagate = False

    # SQL statement logging is opt-in via SQL_ECHO, NOT via APP_DEBUG. It used
    # to follow app_debug, which meant every dev machine logged every statement
    # forever — the dominant cost on an otherwise idle backend once the SSE
    # notification streams were added.
    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.INFO if settings.sql_echo else logging.WARNING
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a bound logger. Call once per module: ``log = get_logger(__name__)``."""
    return structlog.stdlib.get_logger(name)
