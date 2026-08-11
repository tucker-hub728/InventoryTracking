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
    TimelineEventRead,
    TimelineListResponse,
)
from app.core.exceptions import NotFoundError
from app.core.search import MAX_SEARCH_LENGTH
from app.inventory import repository as inv_repo
from app.models.audit import AuditEvent
from app.models.inventory import StockMovement
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


def _movement_subject_label(movement: StockMovement) -> str:
    """``CM-0001 · CryoStor 100 mL · −8 · lot L-24 · → Acme`` — the one-line
    identity of a ledger row in the timeline's Subject column.

    Built here rather than in the browser because the row is now assembled
    server-side; the format is carried over verbatim from the client-side merge
    it replaces, so the column reads the same as before.
    """
    number = movement.item.item_number if movement.item else None
    description = movement.item.description if movement.item else None
    item = f"{number} · {description}" if number and description else (number or description or "—")

    sign = "+" if movement.qty_delta > 0 else "−"
    parts = [item, f"{sign}{movement.qty_abs:,}"]
    if movement.lot is not None and movement.lot.lot_number:
        parts.append(f"lot {movement.lot.lot_number}")
    if movement.movement_type == "customer_shipment":
        # A NULL customer is the catalog / arbitrary-recipient shipment
        # (TRX-007), not missing data.
        customer = movement.customer.name if movement.customer else "Catalog"
        parts.append(f"→ {customer}")
    return " · ".join(parts)


def _movement_to_timeline(movement: StockMovement) -> TimelineEventRead:
    actor = movement.performed_by
    return TimelineEventRead(
        id=str(movement.id),
        source=audit_repo.SOURCE_MOVEMENT,
        occurred_at=movement.performed_at,
        actor_user_id=str(movement.performed_by_user_id),
        actor_user_email=actor.email if actor else None,
        actor_user_name=actor.full_name if actor else None,
        actor_kind="user",
        event_type=f"inventory.movement.{movement.movement_type}",
        severity=audit_repo.movement_severity(movement.movement_type),  # type: ignore[arg-type]
        subject_table=audit_repo.MOVEMENTS_SUBJECT_TABLE,
        subject_id=str(movement.id),
        subject_label=_movement_subject_label(movement),
        # The ledger is append-only — a movement is only ever "created".
        action="created",
    )


def _audit_to_timeline(row: dict) -> TimelineEventRead:
    event: AuditEvent = row["event"]
    return TimelineEventRead(
        id=str(event.id),
        source=audit_repo.SOURCE_AUDIT,
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
    )


@audit_router.get(
    "/timeline",
    response_model=TimelineListResponse,
    summary="Unified audit timeline — audit events + stock movements, paginated",
    dependencies=[Depends(RequirePermission("audit", "view"))],
)
async def list_timeline(
    db: DBSession,
    subject_table: Annotated[SubjectTable | None, Query()] = None,
    subject_id: Annotated[uuid.UUID | None, Query()] = None,
    actor_user_id: Annotated[uuid.UUID | None, Query()] = None,
    severity: Annotated[SeverityFilter | None, Query()] = None,
    action: Annotated[ActionFilter | None, Query()] = None,
    occurred_from: Annotated[datetime | None, Query()] = None,
    occurred_to: Annotated[datetime | None, Query()] = None,
    q: Annotated[
        str | None,
        Query(
            description=(
                "Free-text. Audit rows match event_type + subject_label; "
                "ledger rows match movement type, notes, lot number, and the "
                "item's number/description."
            ),
            max_length=MAX_SEARCH_LENGTH,
        ),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TimelineListResponse:
    """The audit viewer's list, merged across both audit-worthy tables.

    Master-data edits live in ``audit.audit_events``; receipts, dispenses,
    transfers and shipments live in ``app.stock_movements``. Both are records
    of who did what to which material and when, so the viewer shows one stream
    — and paginates it here rather than interleaving two over-fetched windows
    in the browser, which could never produce an honest page 5 or an honest
    total.

    ``GET /v1/audit/events`` remains the audit-events-only surface (per-entity
    history tabs use it); this endpoint is the whole-system view.
    """
    keys, total = await audit_repo.list_timeline_keys(
        db,
        subject_table=subject_table,
        subject_id=subject_id,
        actor_user_id=actor_user_id,
        severity=severity,
        action=action,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        q=q,
        limit=limit,
        offset=offset,
    )

    audit_ids = [i for i, src in keys if src == audit_repo.SOURCE_AUDIT]
    movement_ids = [i for i, src in keys if src == audit_repo.SOURCE_MOVEMENT]
    audit_rows = await audit_repo.audit_events_by_ids(db, audit_ids)
    movements = await inv_repo.movements_by_ids(db, movement_ids)

    # Reassemble in the order the merged query returned. A row missing from its
    # hydration map would mean it was deleted between the two queries; both
    # tables are append-only, so this is belt-and-braces rather than expected.
    items: list[TimelineEventRead] = []
    for row_id, source in keys:
        if source == audit_repo.SOURCE_AUDIT:
            row = audit_rows.get(row_id)
            if row is not None:
                items.append(_audit_to_timeline(row))
        else:
            movement = movements.get(row_id)
            if movement is not None:
                items.append(_movement_to_timeline(movement))

    return TimelineListResponse(items=items, total=total, limit=limit, offset=offset)


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
