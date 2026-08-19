"""Read-only persistence helpers for ``audit.audit_events``.

The recorder (``app.audit.recorder``) owns writes. This module is the
read side — list + filter + lookup. Routes never call SQLAlchemy
directly so the join shape and ordering stay consistent.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import and_, desc, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.search import like_contains
from app.models.audit import AuditEvent, ReauthEvent
from app.models.identity import User
from app.models.inventory import Item, ItemPrefix, Lot, StockMovement

# Shape returned by the listing query — flat dicts so the route can
# build the Pydantic model without dragging a half-hydrated ORM
# instance across an async boundary (the same gotcha that bit the
# Chunk A PATCH handlers).
AuditEventRow = dict

# Which physical table a timeline row came from. Travels to the client so a
# row click knows which detail sheet to open.
SOURCE_AUDIT = "audit"
SOURCE_MOVEMENT = "movement"


def _select_with_actor() -> tuple:
    """Build the canonical SELECT that LEFT-JOINs actor + signature data.

    Returns (AuditEvent, User.email, User.full_name, ReauthEvent.comment)
    so callers can ``await session.execute(select(*_select_with_actor()))``
    and project the user denorm + the e-signature rationale without an
    extra fetch. ``signature_comment`` is NULL for unsigned events.
    """
    return (
        AuditEvent,
        User.email.label("actor_user_email"),
        User.full_name.label("actor_user_name"),
        ReauthEvent.comment.label("signature_comment"),
    )


def _base_stmt():
    """SELECT with the actor + signature LEFT JOINs. Filters layer on top."""
    return (
        select(*_select_with_actor())
        .outerjoin(User, User.id == AuditEvent.actor_user_id)
        .outerjoin(ReauthEvent, ReauthEvent.id == AuditEvent.signature_id)
    )


async def list_audit_events(
    session: AsyncSession,
    *,
    subject_table: str | None = None,
    subject_id: uuid.UUID | None = None,
    lots_of_item: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    event_type: str | None = None,
    severity: str | None = None,
    action: str | None = None,
    occurred_from: datetime | None = None,
    occurred_to: datetime | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[AuditEventRow], int]:
    """Return ``(rows, total)`` newest-first.

    Filters are AND-ed together. ``q`` is a case-insensitive substring
    match over ``event_type`` + ``subject_label`` — the audit viewer's
    "find anything" search. ``occurred_from`` is inclusive,
    ``occurred_to`` is exclusive so half-open ranges work cleanly.
    """
    stmt = _base_stmt()
    count_stmt = select(func.count()).select_from(AuditEvent)

    if subject_table is not None:
        stmt = stmt.where(AuditEvent.subject_table == subject_table)
        count_stmt = count_stmt.where(AuditEvent.subject_table == subject_table)
    if subject_id is not None:
        stmt = stmt.where(AuditEvent.subject_id == subject_id)
        count_stmt = count_stmt.where(AuditEvent.subject_id == subject_id)
    if lots_of_item is not None:
        # "What was decided about THIS item's batches" — release decisions are
        # recorded against the LOT (STS-002 keeps no history table), so an item's
        # own history would otherwise never show them. A subquery rather than a
        # join: audit rows carry no foreign key to their subject, only a table
        # name and an id, so the set of lot ids is resolved first.
        lot_ids = select(Lot.id).where(Lot.item_id == lots_of_item)
        stmt = stmt.where(AuditEvent.subject_id.in_(lot_ids))
        count_stmt = count_stmt.where(AuditEvent.subject_id.in_(lot_ids))
    if actor_user_id is not None:
        stmt = stmt.where(AuditEvent.actor_user_id == actor_user_id)
        count_stmt = count_stmt.where(AuditEvent.actor_user_id == actor_user_id)
    if event_type:
        stmt = stmt.where(AuditEvent.event_type == event_type)
        count_stmt = count_stmt.where(AuditEvent.event_type == event_type)
    if severity:
        stmt = stmt.where(AuditEvent.severity == severity)
        count_stmt = count_stmt.where(AuditEvent.severity == severity)
    if action:
        stmt = stmt.where(AuditEvent.action == action)
        count_stmt = count_stmt.where(AuditEvent.action == action)
    if occurred_from is not None:
        stmt = stmt.where(AuditEvent.occurred_at >= occurred_from)
        count_stmt = count_stmt.where(AuditEvent.occurred_at >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(AuditEvent.occurred_at < occurred_to)
        count_stmt = count_stmt.where(AuditEvent.occurred_at < occurred_to)
    if q:
        like = like_contains(q.lower())
        cond = or_(
            func.lower(AuditEvent.event_type).like(like, escape="\\"),
            func.lower(AuditEvent.subject_label).like(like, escape="\\"),
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    total = int((await session.execute(count_stmt)).scalar_one())

    stmt = stmt.order_by(desc(AuditEvent.occurred_at)).limit(limit).offset(offset)
    result = await session.execute(stmt)

    # ``result.mappings()`` returns one dict per row keyed by column /
    # alias. The AuditEvent row comes back as an ORM instance under the
    # ``AuditEvent`` key; flatten it for the Pydantic adapter.
    rows: list[AuditEventRow] = []
    for mapping in result.mappings().all():
        event: AuditEvent = mapping["AuditEvent"]
        rows.append(
            {
                "event": event,
                "actor_user_email": mapping.get("actor_user_email"),
                "actor_user_name": mapping.get("actor_user_name"),
                "signature_comment": mapping.get("signature_comment"),
            }
        )
    return rows, total


# ── Unified timeline (audit events + stock movements) ────────────────────
#
# The audit viewer shows one chronological stream over two physical tables.
# ``audit.audit_events`` records master-data edits; ``app.stock_movements`` is
# the append-only ledger, and every signed receipt / dispense / transfer in it
# is just as Part-11 audit-worthy as a row in the other table.
#
# This used to be merged in the browser — over-fetch 200 of each, interleave,
# slice. That can't paginate: page 5 of a filtered timeline needs the database
# to know how many rows precede it, and "the first 200 of each" is not that.
#
# The merge is a two-phase query rather than one wide UNION:
#
#   1. UNION ALL the *keys only* — ``(id, occurred_at, source)`` — with every
#      filter applied to both legs. This is what orders, counts and pages.
#   2. Hydrate the ids of the one page, each leg through the loader that
#      already knows its own joins.
#
# Projecting the display columns through the UNION instead would mean
# rebuilding the movement's subject label in SQL (item number is *derived* from
# the prefix code, so that means a join and a concat) and NULL-padding seven
# columns on the audit side. Four cheap queries beat one unreadable one.

# Movement types that read as ``warning`` in the timeline. Everything else is
# ``info``. Declared once so the severity filter and the severity shown on the
# row can't drift apart.
_WARNING_MOVEMENT_TYPES: tuple[str, ...] = ("discard",)

# Movements are always "created" in the audit sense: the ledger is append-only,
# so there is no such thing as an updated or deleted movement.
_MOVEMENT_ACTION = "created"

# The ``subject_table`` value the viewer uses to mean "the ledger".
MOVEMENTS_SUBJECT_TABLE = "app.stock_movements"


def _movement_keys_stmt(
    *,
    severity: str | None,
    action: str | None,
    signed: bool | None,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
    q: str | None,
):
    """Key-only SELECT over ``app.stock_movements`` in timeline shape.

    Returns ``None`` when the filters exclude movements wholesale — e.g. an
    action of ``deleted``, or ``danger`` severity, neither of which a ledger row
    can ever be. That is not the same as "no rows matched": it means the leg
    should be left out of the UNION entirely.
    """
    if action is not None and action != _MOVEMENT_ACTION:
        return None
    if severity == "danger":
        return None

    stmt = select(
        StockMovement.id.label("id"),
        StockMovement.performed_at.label("occurred_at"),
        literal(SOURCE_MOVEMENT).label("source"),
        # Carried so the facet counts can be one aggregate over this union
        # rather than three more filtered queries.
        literal(_MOVEMENT_ACTION).label("action"),
        StockMovement.reauth_evidence_id.isnot(None).label("signed"),
        literal(False).label("is_role_change"),
    )

    if severity == "warning":
        stmt = stmt.where(StockMovement.movement_type.in_(_WARNING_MOVEMENT_TYPES))
    elif severity == "info":
        stmt = stmt.where(StockMovement.movement_type.not_in(_WARNING_MOVEMENT_TYPES))

    if signed is not None:
        stmt = stmt.where(StockMovement.reauth_evidence_id.isnot(None) == signed)

    if occurred_from is not None:
        stmt = stmt.where(StockMovement.performed_at >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(StockMovement.performed_at < occurred_to)

    if q:
        like = like_contains(q.lower())
        stmt = stmt.where(
            or_(
                func.lower(StockMovement.movement_type).like(like, escape="\\"),
                func.lower(StockMovement.notes).like(like, escape="\\"),
                StockMovement.lot_id.in_(
                    select(Lot.id).where(
                        func.lower(Lot.lot_number).like(like, escape="\\")
                    )
                ),
                # The item number is derived (``<prefix code>-<suffix>``), so
                # match its parts the same way the items list does.
                StockMovement.item_id.in_(
                    select(Item.id).where(
                        or_(
                            func.lower(Item.sku_suffix).like(like, escape="\\"),
                            func.lower(Item.description).like(like, escape="\\"),
                            Item.prefix_id.in_(
                                select(ItemPrefix.id).where(
                                    func.lower(ItemPrefix.code).like(like, escape="\\")
                                )
                            ),
                        )
                    )
                ),
            )
        )
    return stmt


def _audit_keys_stmt(
    *,
    subject_table: str | None,
    subject_id: uuid.UUID | None,
    actor_user_id: uuid.UUID | None,
    severity: str | None,
    action: str | None,
    signed: bool | None,
    occurred_from: datetime | None,
    occurred_to: datetime | None,
    q: str | None,
):
    """Key-only SELECT over ``audit.audit_events`` in timeline shape."""
    stmt = select(
        AuditEvent.id.label("id"),
        AuditEvent.occurred_at.label("occurred_at"),
        literal(SOURCE_AUDIT).label("source"),
        AuditEvent.action.label("action"),
        AuditEvent.signature_id.isnot(None).label("signed"),
        # "Did this event change somebody's role" — asked of the stored diff
        # rather than inferred from severity, which a mere email change also
        # raises to ``warning``.
        and_(
            AuditEvent.subject_table == "app.users",
            func.jsonb_exists(AuditEvent.diff, "role"),
        ).label("is_role_change"),
    )
    if subject_table is not None:
        stmt = stmt.where(AuditEvent.subject_table == subject_table)
    if subject_id is not None:
        stmt = stmt.where(AuditEvent.subject_id == subject_id)
    if actor_user_id is not None:
        stmt = stmt.where(AuditEvent.actor_user_id == actor_user_id)
    if severity:
        stmt = stmt.where(AuditEvent.severity == severity)
    if action:
        stmt = stmt.where(AuditEvent.action == action)
    if signed is not None:
        stmt = stmt.where(
            AuditEvent.signature_id.isnot(None)
            if signed
            else AuditEvent.signature_id.is_(None)
        )
    if occurred_from is not None:
        stmt = stmt.where(AuditEvent.occurred_at >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(AuditEvent.occurred_at < occurred_to)
    if q:
        like = like_contains(q.lower())
        stmt = stmt.where(
            or_(
                func.lower(AuditEvent.event_type).like(like, escape="\\"),
                func.lower(AuditEvent.subject_label).like(like, escape="\\"),
            )
        )
    return stmt


async def list_timeline_keys(
    session: AsyncSession,
    *,
    subject_table: str | None = None,
    subject_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    severity: str | None = None,
    action: str | None = None,
    signed: bool | None = None,
    occurred_from: datetime | None = None,
    occurred_to: datetime | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[tuple[uuid.UUID, str]], int, dict[str, int]]:
    """One page of the merged timeline as ``([(id, source)], total, facets)``.

    ``subject_table`` picks which legs run: ``app.stock_movements`` means the
    ledger only, any other value means audit events only, and ``None`` means
    both. Filtering an audit-events query by a subject table it can't contain
    would return zero and report a misleading total, so the choice is made here
    rather than by letting both legs run and one come back empty.

    Ordered newest-first with ``id`` as the tiebreak — without it, rows sharing
    a timestamp (a transfer writes its out/in pair in one transaction) could
    swap places between two page fetches and be shown twice or not at all.
    """
    want_movements = subject_table in (None, MOVEMENTS_SUBJECT_TABLE)
    want_audit = subject_table != MOVEMENTS_SUBJECT_TABLE
    # A subject-id filter addresses a row in a specific table; combined with the
    # ledger it would silently mean "the movement whose id is X", which is not
    # what the per-entity drill-down asks for.
    if subject_id is not None or actor_user_id is not None:
        want_movements = want_movements and subject_table == MOVEMENTS_SUBJECT_TABLE

    legs = []
    if want_audit:
        legs.append(
            _audit_keys_stmt(
                subject_table=subject_table,
                subject_id=subject_id,
                actor_user_id=actor_user_id,
                severity=severity,
                action=action,
                signed=signed,
                occurred_from=occurred_from,
                occurred_to=occurred_to,
                q=q,
            )
        )
    if want_movements:
        movement_leg = _movement_keys_stmt(
            severity=severity,
            action=action,
            signed=signed,
            occurred_from=occurred_from,
            occurred_to=occurred_to,
            q=q,
        )
        if movement_leg is not None:
            legs.append(movement_leg)

    if not legs:
        return [], 0, {"deletions": 0, "role_changes": 0, "unsigned": 0}

    merged = (legs[0] if len(legs) == 1 else union_all(*legs)).subquery("timeline")

    # Total and the three triage counts in ONE pass. Separate COUNT queries
    # would re-run the union four times for numbers that all come off the same
    # filtered set.
    summary = (
        await session.execute(
            select(
                func.count().label("total"),
                func.count()
                .filter(merged.c.action == "deleted")
                .label("deletions"),
                func.count()
                .filter(merged.c.is_role_change.is_(True))
                .label("role_changes"),
                func.count().filter(merged.c.signed.is_(False)).label("unsigned"),
            ).select_from(merged)
        )
    ).one()

    page = (
        select(merged.c.id, merged.c.source)
        .order_by(desc(merged.c.occurred_at), desc(merged.c.id))
        .limit(limit)
        .offset(offset)
    )
    rows = (await session.execute(page)).all()
    facets = {
        "deletions": int(summary.deletions),
        "role_changes": int(summary.role_changes),
        "unsigned": int(summary.unsigned),
    }
    return [(row.id, row.source) for row in rows], int(summary.total), facets


async def audit_events_by_ids(
    session: AsyncSession, ids: list[uuid.UUID]
) -> dict[uuid.UUID, AuditEventRow]:
    """Hydrate audit events by id, keyed for reassembly in timeline order."""
    if not ids:
        return {}
    result = await session.execute(_base_stmt().where(AuditEvent.id.in_(ids)))
    out: dict[uuid.UUID, AuditEventRow] = {}
    for mapping in result.mappings().all():
        event: AuditEvent = mapping["AuditEvent"]
        out[event.id] = {
            "event": event,
            "actor_user_email": mapping.get("actor_user_email"),
            "actor_user_name": mapping.get("actor_user_name"),
            "signature_comment": mapping.get("signature_comment"),
        }
    return out


def movement_severity(movement_type: str) -> str:
    """Timeline severity for a ledger row. Companion to the filter above."""
    return "warning" if movement_type in _WARNING_MOVEMENT_TYPES else "info"


async def get_audit_event(
    session: AsyncSession, event_id: uuid.UUID
) -> AuditEventRow | None:
    """Fetch one event by id with the actor denorm join."""
    stmt = _base_stmt().where(AuditEvent.id == event_id).limit(1)
    result = await session.execute(stmt)
    mapping = result.mappings().first()
    if mapping is None:
        return None
    event: AuditEvent = mapping["AuditEvent"]
    return {
        "event": event,
        "actor_user_email": mapping.get("actor_user_email"),
        "actor_user_name": mapping.get("actor_user_name"),
        "signature_comment": mapping.get("signature_comment"),
    }
