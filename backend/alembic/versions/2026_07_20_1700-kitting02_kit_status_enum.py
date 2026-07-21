"""kitting02: kits.status → native app.kit_status enum

Client request 2026-07-20: the kit status is a native Postgres enum, not a
TEXT + CHECK column. This is a deliberate exception to the house convention
(movement_type / lot_status / node_type stay TEXT+CHECK).

Forward-only (vs. amending kitting01) because kitting01 is already applied on
the shared dev DB and ``app.stock_movements`` is append-only, so a downgrade
past the kit movements the smoke test created is not possible.

Revision ID: kitting02
Revises: kitting01
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "kitting02"
down_revision: str | None = "kitting01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIT_STATUSES = ("draft", "issued", "in_production", "closed", "cancelled")


def _enum_values(values: tuple[str, ...]) -> str:
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


def upgrade() -> None:
    op.execute(f"CREATE TYPE app.kit_status AS ENUM ({_enum_values(KIT_STATUSES)})")
    # The enum now owns the domain — drop the redundant CHECK (double-prefixed
    # name via the naming convention), then cast the column type.
    op.drop_constraint("ck_kits_status", "kits", schema="app", type_="check")
    op.execute("ALTER TABLE app.kits ALTER COLUMN status DROP DEFAULT")
    op.execute(
        "ALTER TABLE app.kits ALTER COLUMN status TYPE app.kit_status "
        "USING status::app.kit_status"
    )
    op.execute(
        "ALTER TABLE app.kits ALTER COLUMN status SET DEFAULT 'draft'::app.kit_status"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE app.kits ALTER COLUMN status DROP DEFAULT")
    op.execute("ALTER TABLE app.kits ALTER COLUMN status TYPE text USING status::text")
    op.execute("ALTER TABLE app.kits ALTER COLUMN status SET DEFAULT 'draft'")
    op.create_check_constraint(
        "ck_kits_status",
        "kits",
        "status IN (" + _enum_values(KIT_STATUSES) + ")",
        schema="app",
    )
    op.execute("DROP TYPE app.kit_status")
