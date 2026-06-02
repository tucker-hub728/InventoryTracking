# CellReady IMS — Monorepo

Production-grade inventory management system for cell-therapy operations:
master inventory ledger, LN2 cryogenic tank mapping, Kanban procurement
workflow, RBAC, and 21 CFR Part 11 electronic signatures.

```
.
├── frontend/    Next.js 14 + TypeScript app
├── backend/     FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL
├── docs/        Schema spec, ERD, MVP scope
├── scripts/     One-off utilities (Excel sync, etc.)
└── docker-compose.yml
```

See [docs/backend-data-structure.md](docs/backend-data-structure.md) for the
long-term schema contract, [docs/backend-data-structure-v1-mvp.md](docs/backend-data-structure-v1-mvp.md)
for the v1 scope, and [docs/erd.md](docs/erd.md) for the ERD.

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Docker | 24+ | with Compose v2 (`docker compose`, not `docker-compose`) |
| Node.js | 20+ | only if you run the frontend natively |
| Python | 3.12+ | only if you run the backend natively |

Everything else (Postgres, uv, pnpm/npm) is provided by the containers.

---

## Quick start

```bash
cp .env.example .env                 # one-time
docker compose up --build            # all services
```

Then:

| Service | URL |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend (FastAPI) | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |
| API docs (ReDoc) | http://localhost:8000/redoc |
| Health check | http://localhost:8000/v1/health |
| Postgres | localhost:5432 (`cellready` / see `.env`) |

To run only some services:

```bash
docker compose up postgres backend          # backend dev, run frontend natively
docker compose up postgres                  # DB only
```

To rebuild after a dependency change:

```bash
docker compose build backend                # or frontend
```

---

## Native development (without Docker)

### Backend

```bash
cd backend
uv sync                                # installs deps into .venv
uv run alembic upgrade head            # apply migrations (none yet)
uv run uvicorn app.main:app --reload   # http://localhost:8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev                            # http://localhost:3000
```

---

## Repo conventions

- **Each subproject owns its own tooling**: `frontend/package.json`,
  `backend/pyproject.toml`. The root holds only repo-wide concerns
  (compose, docs, scripts).
- **No cross-project imports**. The frontend talks to the backend via HTTP
  only.
- **Schema is the contract** ([docs/backend-data-structure-v1-mvp.md](docs/backend-data-structure-v1-mvp.md)).
  Migrations and ORM models are derived from it.

---

## Useful commands

```bash
# Tear everything down (preserves DB volume)
docker compose down

# Tear everything down INCLUDING the database
docker compose down -v

# Tail logs for one service
docker compose logs -f backend

# Open a shell in the backend container
docker compose exec backend bash

# Open a psql shell
docker compose exec postgres psql -U cellready -d cellready_ims
```
