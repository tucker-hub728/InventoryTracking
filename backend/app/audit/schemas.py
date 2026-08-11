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
    # The operator's mandatory rationale captured at signing time, joined
    # from ``audit.reauth_events`` via ``signature_id``. NULL for unsigned
    # events.
    signature_comment: str | None = None


class AuditEventListResponse(BaseModel):
    """Paged audit timeline."""

    items: list[AuditEventRead]
    total: int
    limit: int
    offset: int


# Which table a timeline row came from. The viewer opens a different detail
# sheet for each, so it has to be told rather than inferring it from
# ``subject_table`` (an audit event *about* a movement would look identical).
TimelineSource = Literal["audit", "movement"]


class TimelineEventRead(BaseModel):
    """One row of the unified timeline (audit event OR stock movement).

    Summary only — the full before/after snapshots and the whole ledger entry
    are fetched by id when a row is opened, so paging a thousand rows doesn't
    drag a thousand JSONB blobs across the wire.

    ``diff`` is the exception, and it earns its place: it is the answer to
    "what actually changed", which is the question the reader has on every
    single row. Making that a click was the main thing wrong with the old
    viewer. It is already computed and stored per row, and it is small — one
    entry per changed field, not the whole record.
    """

    id: str
    source: TimelineSource
    occurred_at: datetime
    actor_user_id: str | None = None
    actor_user_email: str | None = None
    actor_user_name: str | None = None
    actor_kind: AuditActorKind
    event_type: str
    severity: AuditSeverity
    subject_table: str
    subject_id: str | None = None
    subject_label: str | None = None
    action: str
    # Whether the write carried an electronic signature. In a Part 11 system
    # this is the first thing an auditor scans a list for, so it travels with
    # the row rather than being discoverable only by opening it.
    signed: bool = False
    # ``{field: {before, after}}`` for the fields that changed. NULL on a
    # ledger row — a movement is an event, not an edit, so there is no
    # before-state to diff against.
    diff: dict | None = None
    # The operator's own words: the e-signature rationale on an audit row, the
    # note on a ledger row. Shown as a quote under the sentence.
    reason: str | None = None
    # The subject's label *before* this event, when the event renamed it.
    # Without this a rename reads as though it had always been called the new
    # name, and "what happened to ATCC" cannot be answered from the list.
    previous_label: str | None = None


class TimelineFacets(BaseModel):
    """Counts over the *whole filtered set*, not the current page.

    Backs the triage strip above the list — "3 deletions · 1 role change ·
    2 unsigned" — which turns the log from something you read top to bottom
    into something you can steer. Page-scoped counts would be actively
    misleading there.
    """

    deletions: int = 0
    role_changes: int = 0
    unsigned: int = 0


class TimelineListResponse(BaseModel):
    """Paged merged timeline. ``total`` spans both sources post-filter."""

    items: list[TimelineEventRead]
    total: int
    limit: int
    offset: int
    facets: TimelineFacets
