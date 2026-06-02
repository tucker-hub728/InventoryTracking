"""Pydantic schemas for the audit viewer API.

Read-only — the only place audit rows get written is
``app.audit.recorder`` (and Alembic migrations). These schemas back
``GET /v1/audit/events`` and friends.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


# Mirror the DB CHECK / model constants.
AuditSeverity = Literal["info", "warning", "danger"]
AuditActorKind = Literal["user", "system", "integration"]


class AuditEventRead(BaseModel):
    """One row from ``audit.audit_events`` plus a denorm actor display.

    ``actor_user_email`` / ``actor_user_name`` come from a LEFT JOIN to
    ``app.users`` — they're cheap to include and save the viewer a
    second fetch. NULL for ``system`` events (no actor row exists).
    ``before_state`` / ``after_state`` / ``diff`` are raw JSONB and
    deliberately untyped here — the front-end renders them
    field-by-field.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    occurred_at: datetime
    actor_user_id: str | None
    actor_user_email: str | None = None
    actor_user_name: str | None = None
    actor_kind: AuditActorKind
    event_type: str
    severity: AuditSeverity
    subject_table: str
    subject_id: str | None
    subject_label: str | None
    action: str
    before_state: dict | None
    after_state: dict | None
    diff: dict | None
    context: dict
    signature_id: str | None


class AuditEventListResponse(BaseModel):
    """Paged audit timeline."""

    items: list[AuditEventRead]
    total: int
    limit: int
    offset: int
