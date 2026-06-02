"""ORM models for the ``audit`` schema.

* ``ReauthEvent`` — append-only record of every password re-auth (the
  e-signature evidence for movement endpoints).
* ``ReauthConsumption`` — proof-of-use for one of those evidences,
  preventing replay.
* ``AuditEvent`` — the general row-diff history (master-data edits,
  soft-deletes, role changes). Single non-partitioned table per the
  v1 MVP doc §2.

All ``audit.*`` tables share one rule: **no UPDATE, no DELETE**, enforced
by per-table triggers. The ORM does NOT need to know about that — it
just won't try to mutate rows.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


# Single source of truth for the actor + severity enums. Mirror the DB
# CHECK + the Pydantic literal types.
AUDIT_ACTOR_KINDS: tuple[str, ...] = ("user", "system", "integration")
AUDIT_SEVERITIES: tuple[str, ...] = ("info", "warning", "danger")


# Single source of truth for the failure_reason enum. Mirror the DB
# CHECK + the Pydantic ``ReauthFailureReason`` literal.
REAUTH_FAILURE_REASONS: tuple[str, ...] = (
    "wrong_password",
    "user_disabled",
    "rate_limited",
    "cognito_error",
)


class ReauthConsumption(Base):
    """Append-only proof-of-use for a reauth evidence row.

    The primary key is ``reauth_event_id`` itself — a unique constraint
    that doubles as the entire replay-protection mechanism. Two
    concurrent writes trying to consume the same evidence will see one
    insert succeed and the other raise ``UniqueViolation``, which the
    consuming endpoint translates to a 401 ``reauth_evidence_replayed``.

    The reference back to the write that *used* the evidence
    (``target_table`` + ``target_id``) is plain text + UUID for now;
    a polymorphic FK would need per-table check constraints and we
    don't yet have a payoff for that complexity.
    """

    __tablename__ = "reauth_consumptions"
    __table_args__ = (
        Index("ix_reauth_consumptions_consumed_at_desc", text("consumed_at DESC")),
        Index("ix_reauth_consumptions_user_id", "consumed_by_user_id"),
        {"schema": "audit"},
    )

    reauth_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    consumed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    consumed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    target_table: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)


class ReauthEvent(Base):
    """One row per reauth attempt. Truly append-only.

    Successful events are the e-signature evidence the receipt / dispense
    / adjustment endpoints will require (Chunk 4+). Failed events feed
    the per-user rate limiter (count failures in last 5 minutes) and
    the future "suspicious activity" admin view.
    """

    __tablename__ = "reauth_events"
    __table_args__ = (
        Index(
            "ix_reauth_events_user_id_created_at",
            "user_id",
            text("created_at DESC"),
        ),
        Index(
            "ix_reauth_events_failures",
            "user_id",
            "created_at",
            postgresql_where=text("success = false"),
        ),
        Index(
            "ix_reauth_events_active",
            "id",
            "user_id",
            "action",
            postgresql_where=text("success = true"),
        ),
        CheckConstraint(
            "(success = true AND failure_reason IS NULL)"
            " OR (success = false AND failure_reason IS NOT NULL)",
            name="ck_reauth_events_failure_consistency",
        ),
        CheckConstraint(
            "expires_at > created_at",
            name="ck_reauth_events_ttl_positive",
        ),
        {"schema": "audit"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    action: Mapped[str] = mapped_column(Text, nullable=False)
    meaning: Mapped[str | None] = mapped_column(Text, nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    # S3 key (e.g. ``signatures/<user_id>/<evidence_id>.png``) pointing
    # at the canvas-drawn signature image the operator drew at sign
    # time. Nullable — headless / API-only callers don't supply one,
    # and the audit module renders a "no image" placeholder when null.
    signature_image_s3_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class AuditEvent(Base):
    """One row per meaningful state change to an entity.

    Single-table for v1 (the MVP doc allows it). Append-only — the
    immutability trigger raises on UPDATE / DELETE / TRUNCATE. Callers
    construct via ``app.audit.recorder.record_entity_change`` so the
    event_type / diff plumbing stays consistent.
    """

    __tablename__ = "audit_events"
    __table_args__ = (
        Index(
            "ix_audit_events_subject",
            "subject_table",
            "subject_id",
            text("occurred_at DESC"),
        ),
        Index(
            "ix_audit_events_actor",
            "actor_user_id",
            text("occurred_at DESC"),
            postgresql_where=text("actor_user_id IS NOT NULL"),
        ),
        Index(
            "ix_audit_events_event_type",
            "event_type",
            text("occurred_at DESC"),
        ),
        Index("ix_audit_events_occurred_at", text("occurred_at DESC")),
        CheckConstraint(
            "actor_kind IN (" + ", ".join(f"'{a}'" for a in AUDIT_ACTOR_KINDS) + ")",
            name="ck_audit_events_actor_kind",
        ),
        CheckConstraint(
            "severity IN (" + ", ".join(f"'{s}'" for s in AUDIT_SEVERITIES) + ")",
            name="ck_audit_events_severity",
        ),
        CheckConstraint(
            "(actor_kind = 'user' AND actor_user_id IS NOT NULL)"
            " OR (actor_kind IN ('system', 'integration'))",
            name="ck_audit_events_user_actor_has_id",
        ),
        {"schema": "audit"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    actor_kind: Mapped[str] = mapped_column(Text, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=text("'info'"),
    )
    subject_table: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
    )
    subject_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    before_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    diff: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    context: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    signature_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("audit.reauth_events.id", ondelete="RESTRICT"),
        nullable=True,
    )
