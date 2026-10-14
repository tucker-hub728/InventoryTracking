# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# CellReady IMS backend — multi-stage Dockerfile.
#
#   stage `base`   : python + uv, no app code, no deps — just the runtime.
#   stage `deps`   : installs Python deps from pyproject.toml + uv.lock.
#   stage `dev`    : adds dev deps; bind-mount source for hot reload via
#                    `docker compose up backend`. Runs uvicorn --reload.
#   stage `prod`   : minimal, runtime deps only, non-root, gunicorn.
#
# Local dev target is `dev`. Production target is `prod`.
# ─────────────────────────────────────────────────────────────────────────────

ARG PYTHON_VERSION=3.12

# ── Stage: uv binary (pinned) ────────────────────────────────────────────────
# Versions are bumped deliberately. `COPY --from` resolves stage names at
# parse time and does NOT expand global ARGs, so the tag is inlined.
FROM ghcr.io/astral-sh/uv:0.13.1 AS uvbin

# ── Stage: base ──────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    # uv settings: write a project-local venv at /app/.venv
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

# OS deps:
#   libpq-dev — psycopg2 build (used by Alembic in sync mode)
#   build-essential — wheels that need a compiler (rare with modern wheels)
#   curl — healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        build-essential \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install uv from the official image (stage `uvbin` declared above).
COPY --from=uvbin /uv /uvx /usr/local/bin/

WORKDIR /app


# ── Stage: deps ──────────────────────────────────────────────────────────────
# Cache-friendly dependency layer. Only invalidates when pyproject/uv.lock change.
FROM base AS deps

COPY pyproject.toml uv.lock* ./

# Cache uv's downloads between builds via BuildKit cache mount.
# `--no-install-project` installs deps without our package, which doesn't exist
# in this layer yet.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-install-project --no-dev


# ── Stage: dev ───────────────────────────────────────────────────────────────
# Used by docker-compose for local development. Source is bind-mounted at
# runtime so we don't need to COPY it in here.
FROM base AS dev

COPY pyproject.toml uv.lock* ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-install-project

# Source will be bind-mounted; this COPY is here so a `docker build --target=dev`
# (without compose) still produces a runnable image.
COPY . .

EXPOSE 8000

# Hot-reload server. `--reload-dir app` keeps the watcher from spinning on
# .venv / .pytest_cache / alembic versions.
CMD ["uv", "run", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--reload", "--reload-dir", "app", "--reload-dir", "alembic"]


# ── Stage: prod ──────────────────────────────────────────────────────────────
FROM base AS prod

# Copy the resolved venv from the deps layer. Saves us re-installing.
COPY --from=deps /app/.venv /app/.venv

# Copy app code last so it's the most-frequently-invalidated layer.
COPY . .

# Drop privileges. UID 10001 is arbitrary but stable; matches no host user.
RUN groupadd --system --gid 10001 app \
    && useradd  --system --uid 10001 --gid app --no-create-home --shell /sbin/nologin app \
    && chown -R app:app /app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD curl --fail --silent http://localhost:8000/v1/health || exit 1

# 2 workers per CPU is a starting point; revisit once we have load data.
CMD ["gunicorn", \
     "app.main:app", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "2", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "--log-level", "info"]
