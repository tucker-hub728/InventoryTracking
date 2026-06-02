"""audit_reauth_events

E-signature backbone. Adds ``audit.reauth_events`` — an append-only
table that records every password re-authentication attempt the system
issues, whether it succeeded or failed. Write endpoints that need
e-signatures (movement.receipt, item.update, etc., from Chunk 4
onwards) will require a fresh successful event id before they commit.

Why a table and not a JWT:
  * Auditors need to see attempted-and-failed attempts too, not just
    successful ones — brute-force attempts are forensic evidence.
  * The table doubles as the rate-limit source (count recent failures
    per user — no separate counter store).
  * Storage is cheap and Part 11 expects every "user identity moment"
    to be on disk, immutable, queryable.

Consumption (marking a row "used by movement X" so it can't be replayed)
is deliberately NOT in this migration — it lands in the chunk that ships
the first consumer (receipts). The empty table here means schema-add
later is free.

Revision ID: c4d5e6f7a8b9
Revises: a1b2c3d4e5f6
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


revision: str = "c4d5e6f7a8b9"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Reasons we record on a *failed* reauth attempt. Kept aligned with the
# Pydantic ``ReauthFailureReason`` literal so the wire shape can't drift.
FAILURE_REASONS: tuple[str, ...] = (
    "wrong_password",      # Cognito NotAuthorizedException
    "user_disabled",       # Cognito user disabled / status revoked
    "rate_limited",        # Too many recent failures
    "cognito_error",       # Anything else from Cognito (network / pool config)
)


def upgrade() -> None:
    # ── Immutability trigger fn (mirrors stock_movements pattern) ──────
    # Lives in the audit schema so admin scripts can list all
    # audit-side helpers with one ``\df audit.*``.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit.tg_reauth_events_immutable()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION
                'audit.reauth_events is append-only; rows cannot be modified or removed'
                USING ERRCODE = '23000';  -- integrity_constraint_violation
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    # ── audit.reauth_events ─────────────────────────────────────────────
    op.create_table(
        "reauth_events",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "app.users.id",
                ondelete="RESTRICT",
                name="fk_reauth_events_user_id_users",
            ),
            nullable=False,
        ),
        # Action the user is attesting to. Free text — we don't lock to
        # a CHECK because action verbs multiply across modules and the
        # invariant we want (no typos) is enforced by the write endpoint
        # that *requires* a particular action name. ``movement.receipt``,
        # ``item.update``, etc.
        sa.Column("action", sa.Text(), nullable=False),
        # Optional user-supplied attestation text. Required for some
        # actions at the API layer (e.g. adjustments must explain why),
        # but stored unconditionally so the audit row carries the same
        # text the user saw on the dialog.
        sa.Column("meaning", sa.Text(), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        # Reason a failed attempt failed. NULL on success.
        sa.Column("failure_reason", sa.Text(), nullable=True),
        # Provenance. Recorded for both successful and failed attempts.
        # IP comes from ``X-Forwarded-For`` (preferred) or the socket;
        # UA comes from the browser's ``User-Agent``. Both pass through
        # the Next.js BFF, which is patched in this chunk to forward them.
        sa.Column("ip_address", sa.Text(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        # When the evidence becomes stale. ``created_at + 120s`` for v1;
        # the route picks the exact value so we can tune it without a
        # migration.
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "(success = true AND failure_reason IS NULL)"
            " OR (success = false AND failure_reason IS NOT NULL)",
            name="ck_reauth_events_failure_consistency",
        ),
        sa.CheckConstraint(
            "failure_reason IS NULL OR failure_reason IN ("
            + ", ".join(f"'{r}'" for r in FAILURE_REASONS)
            + ")",
            name="ck_reauth_events_failure_reason",
        ),
        sa.CheckConstraint(
            "expires_at > created_at",
            name="ck_reauth_events_ttl_positive",
        ),
        schema="audit",
    )

    # Hot reads:
    # 1) "Show me this user's reauth history" (admin audit screen later)
    op.create_index(
        "ix_reauth_events_user_id_created_at",
        "reauth_events",
        ["user_id", sa.text("created_at DESC")],
        schema="audit",
    )
    # 2) Rate-limit lookup: count failed attempts in the last N minutes
    #    per user. Partial index keeps it small (only failures land in it).
    op.create_index(
        "ix_reauth_events_failures",
        "reauth_events",
        ["user_id", "created_at"],
        postgresql_where=sa.text("success = false"),
        schema="audit",
    )
    # 3) Validity lookup: live evidence for a particular action.
    op.create_index(
        "ix_reauth_events_active",
        "reauth_events",
        ["id", "user_id", "action"],
        postgresql_where=sa.text("success = true"),
        schema="audit",
    )

    # ── Immutability triggers ───────────────────────────────────────────
    op.execute(
        """
        CREATE TRIGGER tg_reauth_events_no_update
        BEFORE UPDATE ON audit.reauth_events
        FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_events_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER tg_reauth_events_no_delete
        BEFORE DELETE ON audit.reauth_events
        FOR EACH ROW EXECUTE FUNCTION audit.tg_reauth_events_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tg_reauth_events_no_delete ON audit.reauth_events;")
    op.execute("DROP TRIGGER IF EXISTS tg_reauth_events_no_update ON audit.reauth_events;")
    op.drop_index("ix_reauth_events_active", table_name="reauth_events", schema="audit")
    op.drop_index("ix_reauth_events_failures", table_name="reauth_events", schema="audit")
    op.drop_index(
        "ix_reauth_events_user_id_created_at", table_name="reauth_events", schema="audit"
    )
    op.drop_table("reauth_events", schema="audit")
    op.execute("DROP FUNCTION IF EXISTS audit.tg_reauth_events_immutable();")
