"""add_freezer_location_categories

Extend the native ``app.location_category`` enum with the departments from the
freezer import (temp/Freezer List.xlsx): ``Analytical Lab``, ``Sterility Lab``,
and ``PD``. These are needed before ``scripts/seed_locations.py`` can insert the
freezer locations under those categories.

``ALTER TYPE ... ADD VALUE`` cannot run inside a transaction block, so each add
runs in an autocommit block. ``IF NOT EXISTS`` makes it idempotent.

Keep in lock-step with ``app.models.locations.LOCATION_CATEGORIES``, the
``LocationCategory`` Literal, and the frontend ``LOCATION_CATEGORIES``.

Revision ID: loccat01
Revises: invites01
Create Date: 2026-07-08 11:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "loccat01"
down_revision: str | None = "invites01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_CATEGORIES = ("Analytical Lab", "Sterility Lab", "PD")


def upgrade() -> None:
    # ADD VALUE must be outside a transaction; autocommit_block handles that.
    with op.get_context().autocommit_block():
        for value in NEW_CATEGORIES:
            escaped = value.replace("'", "''")
            op.execute(f"ALTER TYPE app.location_category ADD VALUE IF NOT EXISTS '{escaped}'")


def downgrade() -> None:
    # Postgres cannot drop a value from an enum type; reversing would require
    # recreating app.location_category and rewriting every column that uses it.
    # This addition is one-way by design.
    raise NotImplementedError("app.location_category value additions are not reversible.")
