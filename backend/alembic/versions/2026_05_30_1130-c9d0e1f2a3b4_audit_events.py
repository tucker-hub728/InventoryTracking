"""audit_events

Single-table version of ``audit.audit_events`` per the v1 MVP doc §2.
Captures every meaningful change to entities the app cares about —
master-data edits, soft-deletes, role changes, and (later) the
inventory movement events that have their own dedicated journal.

Schema-wise this is a trimmed shape of the long-spec §10.1 table:

  * NOT partitioned — single table for v1. The MVP doc explicitly
    allows this and the additive v2 migration that partitions only
    touches storage layout, not columns.
  * No hash chain (``prev_hash`` / ``hash``) yet — that lands with
    the optional tamper-evidence module and would just be dead-NULL
    columns now.
  * ``before_state`` / ``after_state`` / ``diff`` are JSONB, like the
    spec. Caller is responsible for trimming to business-relevant
    fields (don't dump whole rows).

Append-only invariant is enforced by trigger (same shape as
``app.stock_movements`` and ``audit.reauth_events``): UPDATE / DELETE /
TRUNCATE all raise an exception. Even the migration role respects
this — once a row lands, it can't be erased; only schema migrations
that drop the table can remove data.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "c9d0e1f2a3b4"
down_revision: str | None = "b8c9d0e1f2a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Allowed values mirrored on the app side as Python constants. Kept
# narrow because the variance / dashboards layer keys off them.
ACTORS = ("user", "system", "integration")
SEVERITIES = ("info", "warning", "danger")


def upgrade() -> None:
    # Immutability trigger function — shared shape across audit tables,
    # but we declare a per-table one to keep error messages targeted.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit.tg_audit_events_immutable()
        RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
            RAISE EXCEPTION
                'audit.audit_events is append-only; UPDATE/DELETE forbidden';
        END;
        $fn$;
        """
    )

    op.create_table(
        "audit_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # ``actor_user_id`` is nullable for ``system`` events (bootstrap,
        # background jobs).
        sa.Column(
            "actor_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app.users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("actor_kind", sa.Text(), nullable=False),
        # Dotted event type — ``inventory.vendor.updated``, ``inventory.
        # location.deactivated``, ``inventory.item.deleted``, etc. The
        # app constructs this from (subject_table, action).
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        # ``subject_*`` describes what changed. ``subject_label`` is a
        # denorm for cheap display ("CM-0237 · anti-CD3") so the audit
        # viewer doesn't need to follow a stale FK.
        sa.Column("subject_table", sa.Text(), nullable=False),
        sa.Column("subject_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("subject_label", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        # Only meaningful fields. Caller is responsible for trimming.
        # Both nullable because a ``create`` has no before-state, a
        # hard-delete event has no after-state.
        sa.Column("before_state", postgresql.JSONB(), nullable=True),
        sa.Column("after_state", postgresql.JSONB(), nullable=True),
        # Precomputed delta — saves the audit viewer from diffing on
        # render. ``diff[col] = {before, after}`` for changed fields.
        sa.Column("diff", postgresql.JSONB(), nullable=True),
        # Request-scoped context — request_id, ip, user_agent. The
        # middleware fills this in from the bound logger context.
        sa.Column(
            "context",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        # Optional link to a signed-action evidence row. NULL for
        # master-data edits; populated by the future movement-audit
        # bridge (Chunk B).
        sa.Column(
            "signature_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "actor_kind IN (" + ", ".join(f"'{a}'" for a in ACTORS) + ")",
            name="ck_audit_events_actor_kind",
        ),
        sa.CheckConstraint(
            "severity IN (" + ", ".join(f"'{s}'" for s in SEVERITIES) + ")",
            name="ck_audit_events_severity",
        ),
        # ``user`` actor must have an actor_user_id; ``system`` /
        # ``integration`` may have one but don't have to.
        sa.CheckConstraint(
            "(actor_kind = 'user' AND actor_user_id IS NOT NULL)"
            " OR (actor_kind IN ('system', 'integration'))",
            name="ck_audit_events_user_actor_has_id",
        ),
        schema="audit",
    )

    # Indexes for hot paths.
    # 1) "show me everything that happened to entity X" — the audit
    #    viewer's primary timeline query.
    op.create_index(
        "ix_audit_events_subject",
        "audit_events",
        ["subject_table", "subject_id", sa.text("occurred_at DESC")],
        schema="audit",
    )
    # 2) Per-user activity feed.
    op.create_index(
        "ix_audit_events_actor",
        "audit_events",
        ["actor_user_id", sa.text("occurred_at DESC")],
        postgresql_where=sa.text("actor_user_id IS NOT NULL"),
        schema="audit",
    )
    # 3) Per-event-type dashboards and alert rules.
    op.create_index(
        "ix_audit_events_event_type",
        "audit_events",
        ["event_type", sa.text("occurred_at DESC")],
        schema="audit",
    )
    # 4) Global newest-first.
    op.create_index(
        "ix_audit_events_occurred_at",
        "audit_events",
        [sa.text("occurred_at DESC")],
        schema="audit",
    )

    # Immutability triggers — same pattern as stock_movements + reauth_events.
    op.execute(
        """
        CREATE TRIGGER tg_audit_events_no_update
        BEFORE UPDATE ON audit.audit_events
        FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_events_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_audit_events_no_delete
        BEFORE DELETE ON audit.audit_events
        FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_events_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_audit_events_no_truncate
        BEFORE TRUNCATE ON audit.audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit.tg_audit_events_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tg_audit_events_no_truncate ON audit.audit_events;")
    op.execute("DROP TRIGGER IF EXISTS tg_audit_events_no_delete ON audit.audit_events;")
    op.execute("DROP TRIGGER IF EXISTS tg_audit_events_no_update ON audit.audit_events;")
    op.drop_index(
        "ix_audit_events_occurred_at", table_name="audit_events", schema="audit"
    )
    op.drop_index(
        "ix_audit_events_event_type", table_name="audit_events", schema="audit"
    )
    op.drop_index("ix_audit_events_actor", table_name="audit_events", schema="audit")
    op.drop_index("ix_audit_events_subject", table_name="audit_events", schema="audit")
    op.drop_table("audit_events", schema="audit")
    op.execute("DROP FUNCTION IF EXISTS audit.tg_audit_events_immutable();")
