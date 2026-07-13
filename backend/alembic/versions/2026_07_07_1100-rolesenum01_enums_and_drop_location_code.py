"""enums_and_drop_location_code

Two schema changes (week 2, 2026-07-07):

1. Promote three CHECK-constrained TEXT columns to native Postgres enum types
   (all in the ``app`` schema):
       users.role          -> app.user_role         (super_admin/admin/operator)
       items.tier          -> app.item_tier          (CR/AY/FG)
       locations.location_type -> app.location_category (the 6 fixed categories)
   The old CHECK constraints are dropped — the enum type now enforces the domain.

2. Drop ``locations.location_code`` (and its unique index) — codes are no longer
   used; a location is identified by its id + name.

Existing dev data uses only in-domain values, so the ``USING col::enum`` casts
succeed with no cleanup. Prod is greenfield.

Revision ID: rolesenum01
Revises: itemdesc01
Create Date: 2026-07-07 11:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "rolesenum01"
down_revision: str | None = "itemdesc01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("super_admin", "admin", "operator")
TIERS = ("CR", "AY", "FG")
CATEGORIES = (
    "Materials Management",
    "Lab",
    "QC",
    "Engineering",
    "PD Lab One",
    "PD Lab Two",
)


def _enum_values(values: tuple[str, ...]) -> str:
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def upgrade() -> None:
    # 1. users.role -> app.user_role. Drop the CHECK FIRST — otherwise Postgres
    # re-validates it mid-ALTER as ``app.user_role IN (text, …)`` and fails on
    # the missing enum=text operator. (The naming convention doubles the prefix:
    # the constraint is ``ck_users_ck_users_role``.)
    op.execute(
        "ALTER TABLE app.users DROP CONSTRAINT IF EXISTS ck_users_ck_users_role"
    )
    op.execute(f"CREATE TYPE app.user_role AS ENUM ({_enum_values(ROLES)})")
    op.execute(
        "ALTER TABLE app.users ALTER COLUMN role TYPE app.user_role "
        "USING role::app.user_role"
    )

    # 2. items.tier -> app.item_tier (same CHECK-first ordering).
    op.execute(
        "ALTER TABLE app.items DROP CONSTRAINT IF EXISTS ck_items_ck_items_tier"
    )
    op.execute(f"CREATE TYPE app.item_tier AS ENUM ({_enum_values(TIERS)})")
    op.execute(
        "ALTER TABLE app.items ALTER COLUMN tier TYPE app.item_tier "
        "USING tier::app.item_tier"
    )

    # 3. locations.location_type -> app.location_category
    op.execute(
        f"CREATE TYPE app.location_category AS ENUM ({_enum_values(CATEGORIES)})"
    )
    op.execute(
        "ALTER TABLE app.locations ALTER COLUMN location_type "
        "TYPE app.location_category USING location_type::app.location_category"
    )

    # 4. Drop locations.location_code (+ its unique functional index).
    op.execute("DROP INDEX IF EXISTS app.uq_locations_location_code")
    op.drop_column("locations", "location_code", schema="app")


def downgrade() -> None:
    # location_code returns as a nullable TEXT column — prior values are NOT
    # recoverable (data was dropped on upgrade).
    op.add_column(
        "locations",
        sa.Column("location_code", sa.Text(), nullable=True),
        schema="app",
    )

    op.execute(
        "ALTER TABLE app.locations ALTER COLUMN location_type TYPE text "
        "USING location_type::text"
    )
    op.execute("DROP TYPE app.location_category")

    op.execute("ALTER TABLE app.items ALTER COLUMN tier TYPE text USING tier::text")
    op.execute(
        f"ALTER TABLE app.items ADD CONSTRAINT ck_items_tier "
        f"CHECK (tier IN ({_enum_values(TIERS)}))"
    )
    op.execute("DROP TYPE app.item_tier")

    op.execute("ALTER TABLE app.users ALTER COLUMN role TYPE text USING role::text")
    op.execute(
        f"ALTER TABLE app.users ADD CONSTRAINT ck_users_role "
        f"CHECK (role IN ({_enum_values(ROLES)}))"
    )
    op.execute("DROP TYPE app.user_role")
