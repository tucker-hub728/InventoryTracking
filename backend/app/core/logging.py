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

    # Let SQLAlchemy stay at WARNING unless explicitly raised
    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.INFO if settings.app_debug else logging.WARNING
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a bound logger. Call once per module: ``log = get_logger(__name__)``."""
    return structlog.stdlib.get_logger(name)
