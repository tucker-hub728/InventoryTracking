"""storage_racks_and_positions

Adds the LN2 / Storage grid tables — see ``docs/modules/storage.md``:

* ``meta.storage_racks`` — a ``rows × cols`` grid under a ``meta.locations``
  row. Master-ish data; soft-deleted via ``is_active``.
* ``app.storage_positions`` — one row per slot. Coordinates + row-major
  ``seq`` + human ``label`` are immutable; occupancy (``status`` /
  ``lot_id`` / ``assigned_at``) is mutable. Status is binary
  (``empty`` / ``occupied``).
* ``app.storage_assignment_events`` — append-only history (assign / empty /
  move) backing position history + the audit trail.

Purely additive. Positions are materialised by the application service on
rack creation (not a DB trigger), so this migration only defines structure.

Revision ID: f1a2b3c4d5e6
Revises: d0e1f2a3b4c5
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "d0e1f2a3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Binary slot status + history event kinds. Keep in lock-step with the
# ORM (``app.models.storage``) and the Pydantic ``PositionStatus`` enum.
POSITION_STATUSES: tuple[str, ...] = ("empty", "occupied")
STORAGE_EVENT_KINDS: tuple[str, ...] = ("assign", "move_out", "move_in", "empty")


def upgrade() -> None:
    # ── meta.storage_racks ─────────────────────────────────────────────
    op.create_table(
        "storage_racks",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "location_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.locations.id",
                ondelete="CASCADE",
                name="fk_storage_racks_location_id_locations",
            ),
            nullable=False,
        ),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("rows", sa.Integer(), nullable=False),
        sa.Column("cols", sa.Integer(), nullable=False),
        sa.Column(
            "position_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
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
        sa.UniqueConstraint(
            "location_id", "code", name="uq_storage_racks_location_id_code"
        ),
        sa.CheckConstraint("rows BETWEEN 1 AND 26", name="ck_storage_racks_rows_range"),
        sa.CheckConstraint("cols BETWEEN 1 AND 26", name="ck_storage_racks_cols_range"),
        sa.CheckConstraint(
            "char_length(trim(name)) > 0", name="ck_storage_racks_name_not_blank"
        ),
        schema="meta",
    )
    op.create_index(
        "ix_storage_racks_location_id",
        "storage_racks",
        ["location_id"],
        schema="meta",
    )
    op.execute(
        """
        CREATE TRIGGER tg_storage_racks_touch_updated_at
        BEFORE UPDATE ON meta.storage_racks
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # ── app.storage_positions ──────────────────────────────────────────
    op.create_table(
        "storage_positions",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "rack_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "meta.storage_racks.id",
                ondelete="CASCADE",
                name="fk_storage_positions_rack_id_storage_racks",
            ),
            nullable=False,
        ),
        sa.Column("row_idx", sa.Integer(), nullable=False),
        sa.Column("col_idx", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'empty'"),
        ),
        sa.Column(
            "lot_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.lots.id",
                ondelete="RESTRICT",
                name="fk_storage_positions_lot_id_lots",
            ),
            nullable=True,
        ),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.UniqueConstraint(
            "rack_id",
            "row_idx",
            "col_idx",
            name="uq_storage_positions_rack_id_row_idx_col_idx",
        ),
        sa.UniqueConstraint(
            "rack_id", "seq", name="uq_storage_positions_rack_id_seq"
        ),
        sa.CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in POSITION_STATUSES) + ")",
            name="ck_storage_positions_status",
        ),
        sa.CheckConstraint("row_idx >= 1", name="ck_storage_positions_row_idx_min"),
        sa.CheckConstraint("col_idx >= 1", name="ck_storage_positions_col_idx_min"),
        sa.CheckConstraint("seq >= 1", name="ck_storage_positions_seq_min"),
        sa.CheckConstraint(
            "(status = 'occupied') = (lot_id IS NOT NULL)",
            name="ck_storage_positions_occupancy",
        ),
        schema="app",
    )
    op.create_index(
        "ix_storage_positions_rack_id",
        "storage_positions",
        ["rack_id"],
        schema="app",
    )
    op.create_index(
        "ix_storage_positions_lot_id",
        "storage_positions",
        ["lot_id"],
        schema="app",
    )
    op.create_index(
        "ix_storage_positions_status",
        "storage_positions",
        ["status"],
        schema="app",
    )
    op.execute(
        """
        CREATE TRIGGER tg_storage_positions_touch_updated_at
        BEFORE UPDATE ON app.storage_positions
        FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
        """
    )

    # ── app.storage_assignment_events (append-only) ────────────────────
    op.create_table(
        "storage_assignment_events",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "position_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.storage_positions.id",
                ondelete="CASCADE",
                name="fk_storage_assignment_events_position_id_storage_positions",
            ),
            nullable=False,
        ),
        sa.Column("event_kind", sa.Text(), nullable=False),
        sa.Column("from_status", sa.Text(), nullable=True),
        sa.Column("to_status", sa.Text(), nullable=True),
        sa.Column(
            "lot_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.lots.id",
                ondelete="RESTRICT",
                name="fk_storage_assignment_events_lot_id_lots",
            ),
            nullable=True,
        ),
        sa.Column(
            "counterpart_position_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.storage_positions.id",
                ondelete="SET NULL",
                name="fk_storage_events_counterpart_position",
            ),
            nullable=True,
        ),
        sa.Column(
            "actor_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_storage_assignment_events_actor_id_users",
            ),
            nullable=False,
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "event_kind IN (" + ", ".join(f"'{k}'" for k in STORAGE_EVENT_KINDS) + ")",
            name="ck_storage_assignment_events_event_kind",
        ),
        schema="app",
    )
    op.create_index(
        "ix_storage_assignment_events_position_id_occurred_at",
        "storage_assignment_events",
        ["position_id", "occurred_at"],
        schema="app",
    )


def downgrade() -> None:
    op.drop_table("storage_assignment_events", schema="app")
    op.drop_table("storage_positions", schema="app")
    op.drop_table("storage_racks", schema="meta")
