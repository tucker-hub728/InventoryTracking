# CellReady IMS backend — common task runner.
# Native shortcuts (no Docker). For Docker-based dev, use the root README.

.DEFAULT_GOAL := help
.PHONY: help install dev test lint fmt typecheck check migrate makemigration downgrade clean

help:  ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install:  ## Install runtime + dev deps with uv
	uv sync

dev:  ## Run the API locally with hot reload
	uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

test:  ## Run pytest with coverage
	uv run pytest

lint:  ## Lint with ruff
	uv run ruff check .

fmt:  ## Format with ruff
	uv run ruff format .
	uv run ruff check --fix .

typecheck:  ## Type-check with mypy
	uv run mypy app

check: lint typecheck test  ## Run lint + typecheck + tests

migrate:  ## Apply all pending migrations
	uv run alembic upgrade head

makemigration:  ## Generate a new migration. Usage: make makemigration m="add users table"
	uv run alembic revision --autogenerate -m "$(m)"

downgrade:  ## Roll back the most recent migration
	uv run alembic downgrade -1

clean:  ## Remove caches and build artifacts
	rm -rf .pytest_cache .mypy_cache .ruff_cache htmlcov .coverage coverage.xml
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
