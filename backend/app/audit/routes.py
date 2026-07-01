"""``/v1/audit`` routes — read-only viewer over ``audit.audit_events``.

Gated on the ``audit:view`` permission. Every role except ``viewer``
can also export later (Chunk B+); for v1 the export pipeline is
deferred and the API just lists rows.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query

from app.api.deps import DBSession
from app.audit import repository as audit_repo
from app.audit.schemas import (
    AuditEventListResponse,
    AuditEventRead,
)
from app.core.exceptions import NotFoundError
from app.models.audit import AuditEvent
from app.security.permissions import RequirePermission

audit_router = APIRouter(prefix="/audit", tags=["audit"])


# Whitelisted ``subject_table`` filter values. The schema doesn't
# constrain the column (writes can come from future modules) but we
# narrow the API surface so the viewer doesn't accept arbitrary input.
SubjectTable = Literal[
    "meta.suppliers",
    "meta.locations",
    "app.items",
    "app.lots",
    "app.users",
    "app.stock_movements",
]

# Mirrors ``AuditAction`` in the recorder. Filtering by action is the
# "show me deletes" use case.
ActionFilter = Literal["created", "updated", "deleted", "restored"]
SeverityFilter = Literal["info", "warning", "danger"]


def _row_to_read(row: dict) -> AuditEventRead:
    event: AuditEvent = row["event"]
    return AuditEventRead(
        id=str(event.id),
        occurred_at=event.occurred_at,
        actor_user_id=str(event.actor_user_id) if event.actor_user_id else None,
        actor_user_email=row.get("actor_user_email"),
        actor_user_name=row.get("actor_user_name"),
        actor_kind=event.actor_kind,  # type: ignore[arg-type]
        event_type=event.event_type,
        severity=event.severity,  # type: ignore[arg-type]
        subject_table=event.subject_table,
        subject_id=str(event.subject_id) if event.subject_id else None,
        subject_label=event.subject_label,
        action=event.action,
        before_state=event.before_state,
        after_state=event.after_state,
        diff=event.diff,
        context=event.context,
        signature_id=str(event.signature_id) if event.signature_id else None,
        signature_comment=row.get("signature_comment"),
    )


@audit_router.get(
    "/events",
    response_model=AuditEventListResponse,
    summary="List audit events (newest first, paginated)",
    dependencies=[Depends(RequirePermission("audit", "view"))],
)
async def list_audit_events(
    db: DBSession,
    subject_table: Annotated[SubjectTable | None, Query()] = None,
    subject_id: Annotated[uuid.UUID | None, Query()] = None,
    actor_user_id: Annotated[uuid.UUID | None, Query()] = None,
    event_type: Annotated[str | None, Query(max_length=128)] = None,
    severity: Annotated[SeverityFilter | None, Query()] = None,
    action: Annotated[ActionFilter | None, Query()] = None,
    occurred_from: Annotated[datetime | None, Query()] = None,
    occurred_to: Annotated[datetime | None, Query()] = None,
    q: Annotated[
        str | None,
        Query(
            description="Free-text — matches event_type + subject_label",
            max_length=128,
        ),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditEventListResponse:
    """Paged timeline. All filters AND-ed.

    Common queries:
      * ``?subject_table=app.items&subject_id=<uuid>`` — "what happened
        to this item" (per-entity history tab on the detail page).
      * ``?actor_user_id=<uuid>`` — "what did this user touch today"
        (admin audit drill-down).
      * ``?action=deleted&occurred_from=<iso>`` — "what got deleted in
        the last hour" (incident triage).
    """
    rows, total = await audit_repo.list_audit_events(
        db,
        subject_table=subject_table,
        subject_id=subject_id,
        actor_user_id=actor_user_id,
        event_type=event_type,
        severity=severity,
        action=action,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        q=q,
        limit=limit,
        offset=offset,
    )
    return AuditEventListResponse(
        items=[_row_to_read(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@audit_router.get(
    "/events/{event_id}",
    response_model=AuditEventRead,
    summary="One audit event by id (with actor denorm)",
    dependencies=[Depends(RequirePermission("audit", "view"))],
)
async def get_audit_event(
    db: DBSession,
    event_id: Annotated[uuid.UUID, Path()],
) -> AuditEventRead:
    row = await audit_repo.get_audit_event(db, event_id)
    if row is None:
        raise NotFoundError(f"Audit event {event_id} not found")
    return _row_to_read(row)
