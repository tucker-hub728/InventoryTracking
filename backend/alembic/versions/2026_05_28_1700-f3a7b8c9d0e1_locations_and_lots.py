"""locations_and_lots

Adds the two master-data tables that the stock movements module will FK
to:

* ``meta.locations`` — storage positions (freezers, LN2 tanks, fridges,
  bench, etc.). Each location has a ``kind`` (so the UI can colour-code
  cold-chain temperatures) and a free-form ``code`` that operators
  recognise (``LN2-A``, ``FRZ-80-B1``). No audit columns: matches the
  existing ``meta.vendors`` pattern — master data is rarely changed and
  attribution will come with the audit module.

* ``app.lots`` — manufacturer batches, scoped per ``items`` row. Lots
  are first-class so recalls are queryable (``"every dispense from lot
  X"``) rather than a fuzzy LIKE over a free-text column. Status starts
  at ``released`` for v1 (admin records cleared lots manually); the
  ``quarantined`` / ``recalled`` paths land when the QA module ships.

Neither table is referenced by any other table yet — the FKs come in
the movements migration. This migration is purely additive and safe to
run on a populated database.

Revision ID: f3a7b8c9d0e1
Revises: e052b2ffa00b
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "f3a7b8c9d0e1"
down_revision: str | None = "e052b2ffa00b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Storage-environment categories. Keep this list in lock-step with the
# Pydantic ``LocationKind`` enum + the frontend ``LOCATION_KIND_OPTIONS``;
# adding a value here requires a migration.
LOCATION_KINDS: tuple[str, ...] = (
    "LN2",
    "minus_80",
    "minus_20",
    "fridge",
    "room_temp",
    "cold_room",
    "incubator",
    "other",
)

# Lot lifecycle. ``released`` is the default v1 since admins only record
# already-cleared lots; ``quarantined`` / ``recalled`` are reachable via
# future status-change endpoints (gated on the audit module).
LOT_STATUSES: tuple[str, ...] = (
    "quarantined",
    "released",
    "expired",
    "recalled",
)


def upgrade() -> None:
    # ── meta.locations ─────────────────────────────────────────────────
    op.create_table(
        "locations",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("temperature_c", sa.Numeric(6, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("TRUE"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "kind IN (" + ", ".join(f"'{k}'" for k in LOCATION_KINDS) + ")",
            name="ck_locations_kind",
        ),
        sa.CheckConstraint(
            "char_length(trim(code)) > 0",
            name="ck_locations_code_not_blank",
        ),
        sa.CheckConstraint(
            "char_length(trim(name)) > 0",
            name="ck_locations_name_not_blank",
        ),
        schema="meta",
    )
    # Case-insensitive uniqueness on ``code``. Operators type these by
    # hand, so ``ln2-a`` and ``LN2-A`` must collide.
    op.create_index(
        "uq_locations_code",
        "locations",
        [sa.text("lower(code)")],
        unique=True,
        schema="meta",
    )
    op.create_index("ix_locations_active", "locations", ["is_active"], schema="meta")
    op.create_index("ix_locations_kind", "locations", ["kind"], schema="meta")
    op.execute(
        """
        CREATE TRIGGER tg_locations_touch_updated_at
        BEFORE UPDATE ON meta.locations
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # ── app.lots ───────────────────────────────────────────────────────
    op.create_table(
        "lots",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "item_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.items.id",
                ondelete="RESTRICT",
                name="fk_lots_item_id_items",
            ),
            nullable=False,
        ),
        sa.Column("lot_number", sa.Text(), nullable=False),
        sa.Column(
            "vendor_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.vendors.id",
                ondelete="RESTRICT",
                name="fk_lots_vendor_id_vendors",
            ),
            nullable=True,
        ),
        sa.Column("manufacture_date", sa.Date(), nullable=True),
        sa.Column("expiration_date", sa.Date(), nullable=True),
        sa.Column("coa_url", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'released'"),
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_lots_created_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_lots_updated_by_user_id_users",
            ),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in LOT_STATUSES) + ")",
            name="ck_lots_status",
        ),
        sa.CheckConstraint(
            "char_length(trim(lot_number)) > 0",
            name="ck_lots_lot_number_not_blank",
        ),
        # If both dates are present, expiration must come after manufacture.
        # NULLable so legacy / partial records still load.
        sa.CheckConstraint(
            "expiration_date IS NULL OR manufacture_date IS NULL "
            "OR expiration_date >= manufacture_date",
            name="ck_lots_dates_ordered",
        ),
        schema="app",
    )
    # Lot numbers are unique *within an item* — two different items can
    # legitimately share a supplier's lot number. Partial-unique skips
    # soft-deleted rows so we can recreate after archive.
    op.create_index(
        "uq_lots_item_lot_number",
        "lots",
        ["item_id", "lot_number"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )
    # Hot reads:
    op.create_index("ix_lots_item_id", "lots", ["item_id"], schema="app")
    op.create_index("ix_lots_vendor_id", "lots", ["vendor_id"], schema="app")
    op.create_index("ix_lots_status", "lots", ["status"], schema="app")
    # ``expiring soon`` queries hit this with a date range; partial index
    # cuts out the rows we don't care about (expired / recalled).
    op.create_index(
        "ix_lots_expiration_date",
        "lots",
        ["expiration_date"],
        postgresql_where=sa.text("status IN ('released', 'quarantined')"),
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_lots_touch_updated_at
        BEFORE UPDATE ON app.lots
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tg_lots_touch_updated_at ON app.lots;")
    op.drop_index("ix_lots_expiration_date", table_name="lots", schema="app")
    op.drop_index("ix_lots_status", table_name="lots", schema="app")
    op.drop_index("ix_lots_vendor_id", table_name="lots", schema="app")
    op.drop_index("ix_lots_item_id", table_name="lots", schema="app")
    op.drop_index("uq_lots_item_lot_number", table_name="lots", schema="app")
    op.drop_table("lots", schema="app")

    op.execute("DROP TRIGGER IF EXISTS tg_locations_touch_updated_at ON meta.locations;")
    op.drop_index("ix_locations_kind", table_name="locations", schema="meta")
    op.drop_index("ix_locations_active", table_name="locations", schema="meta")
    op.drop_index("uq_locations_code", table_name="locations", schema="meta")
    op.drop_table("locations", schema="meta")
