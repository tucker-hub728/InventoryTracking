"""free_form_item_number

Drop the ``app.items`` item-number format CHECK so the column is fully
free-form, matching the inventory-module contract
(docs/modules/inventory.md §3.1 / §4.1 / §9.2): uniqueness is the *only*
backend rule on ``item_number``.

The CHECK being removed (``ck_items_item_number_format``) required a 2–8
character, letter-led prefix, a dash, then digits only —
``^[A-Z][A-Z0-9]{1,7}-[0-9]+$`` — which rejected legitimately-issued
numbers (alphanumeric suffixes like ``CM-0001A``, single-character
prefixes, non-dash codes, …). The partial-unique index
``uq_items_item_number`` (``WHERE deleted_at IS NULL``) is unchanged and
remains the authoritative guard.

Reversible: ``downgrade`` re-creates the CHECK exactly as it stood
immediately before this migration (the relaxed shape introduced by
``b2c3d4e5f6a7``). It will fail if any item carrying a non-conforming
number exists at that point — expected; you cannot un-ring the bell once
free-form numbers are in use (a dev-only concern).

Revision ID: c1d2e3f4a5b6
Revises: f6a7b8c9d0e1
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "c1d2e3f4a5b6"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The real constraint name carries a doubled ``ck_items_`` prefix: the
# metadata naming convention (``ck_%(table_name)s_%(constraint_name)s`` in
# app/db/base.py) wraps the explicit name the model passed
# (``ck_items_item_number_format``) → ``ck_items_ck_items_item_number_format``.
_REAL_NAME = "ck_items_ck_items_item_number_format"
# The un-prefixed name, dropped defensively in case an environment created
# the constraint without the naming convention applied.
_LEGACY_NAME = "ck_items_item_number_format"
# The shape in force immediately before this migration (added by
# ``b2c3d4e5f6a7``). Restored on downgrade under the convention-correct name.
_PRIOR_FORMAT = "item_number ~ '^[A-Z][A-Z0-9]{1,7}-[0-9]+$'"


def upgrade() -> None:
    # Free-form item_number: uniqueness only, no format CHECK (§3.1). Drop by
    # literal name with IF EXISTS so it's deterministic (independent of whether
    # Alembic re-applies the naming convention to drop_constraint) and idempotent.
    op.execute(f"ALTER TABLE app.items DROP CONSTRAINT IF EXISTS {_REAL_NAME}")
    op.execute(f"ALTER TABLE app.items DROP CONSTRAINT IF EXISTS {_LEGACY_NAME}")


def downgrade() -> None:
    op.execute(
        f"ALTER TABLE app.items ADD CONSTRAINT {_REAL_NAME} CHECK ({_PRIOR_FORMAT})"
    )
