# CellReady IMS — Backend

FastAPI · SQLAlchemy 2 (async) · Alembic · PostgreSQL 16+ · uv

> Schema contract: [../docs/backend-data-structure.md](../docs/backend-data-structure.md)
> v1 scope: [../docs/backend-data-structure-v1-mvp.md](../docs/backend-data-structure-v1-mvp.md)
> ERD: [../docs/erd.md](../docs/erd.md)

---

## Layout

```
backend/
├── app/
│   ├── main.py                       FastAPI factory + composition root
│   ├── core/
│   │   ├── config.py                 typed settings (pydantic-settings)
│   │   ├── logging.py                structlog config + bridge to stdlib
│   │   ├── exceptions.py             domain exception hierarchy
│   │   └── lifespan.py               startup / shutdown
│   ├── db/
│   │   ├── base.py                   declarative base + naming convention
│   │   └── session.py                async engine + sessionmaker + DI helper
│   ├── api/
│   │   ├── deps.py                   shared FastAPI dependencies (DBSession, ...)
│   │   ├── errors.py                 exception → HTTP handlers
│   │   └── v1/
│   │       ├── router.py             aggregate v1 router
│   │       └── routes/
│   │           └── health.py         /v1/health  /v1/ready
│   └── middlewares/
│       └── request_context.py        request id + access log
├── alembic/                          migrations (none yet)
│   ├── env.py
│   ├── script.py.mako
│   └── versions/
├── tests/
│   ├── conftest.py                   test client fixture, env overrides
│   └── test_health.py                smoke tests
├── pyproject.toml                    runtime + dev deps + ruff + mypy + pytest
├── alembic.ini
├── Dockerfile                        multi-stage: base → deps → dev | prod
├── .dockerignore
└── .env.example                      copy to .env when running natively
```

The project is organised in *layers*, not features. Domain modules will be
added as `app/<module>/` (models, schemas, services) on top of the layout
above — see [../docs/backend-data-structure-v1-mvp.md](../docs/backend-data-structure-v1-mvp.md) §7.

---

## Running

### With Docker (recommended)

From the repo root:

```bash
docker compose up --build backend
# Swagger:  http://localhost:8000/docs
# Health:   http://localhost:8000/v1/health
```

### Native (uv)

```bash
cd backend
uv sync                                    # installs runtime + dev deps
cp .env.example .env                       # then edit
uv run uvicorn app.main:app --reload
```

---

## Common tasks

```bash
# Run the test suite
uv run pytest

# Lint + format (single tool)
uv run ruff check --fix .
uv run ruff format .

# Type-check
uv run mypy app

# Generate a migration (autogenerate)
uv run alembic revision --autogenerate -m "create users"

# Apply migrations
uv run alembic upgrade head

# Roll back one
uv run alembic downgrade -1
```

---

## Conventions

- **Async everywhere.** Sync DB calls are a footgun in an async stack —
  they block the event loop. Alembic is the only sanctioned sync DB caller.
- **Routes are thin.** They validate input, call a service, return a Pydantic
  response model. No business logic, no SQL.
- **Services are framework-agnostic.** They take a session + DTOs, raise
  domain exceptions, return entities or DTOs. They never know about HTTP.
- **Exceptions over `Optional[Result]`.** Raise `NotFoundError(...)`; the
  global handler maps it to a 404 with a stable JSON envelope.
- **Logs are structured.** `log.info("user.invited", user_id=...)`, not
  `log.info(f"Invited user {user_id}")`.
- **One thing per migration.** Squashing destroys the timeline that
  regulated audits care about.
