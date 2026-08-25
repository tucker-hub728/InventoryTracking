"""``/v1/notifications`` — the bell (NOTIF-001).

Every route here answers about **the caller's own** rows and nothing else. The
thing this replaced was a feed derived from two global queries, identical for
every user, so "whose is it?" is the question the module exists to answer; the
``user_id`` predicate lives in the repository so no route can forget it.

``RequirePermission("inventory", "view")`` gates the router because that is who
these alerts are about. It is not the authorisation that matters, though — the
own-rows filter is. A user cannot reach another user's notifications by any
route here regardless of role, including ``super_admin``.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentDbUserDep, DBSession, resolve_db_user
from app.auth.dependencies import CurrentUserDep
from app.core.exceptions import AuthorizationError, NotFoundError
from app.db.session import get_sessionmaker
from app.notifications import repository as notif_repo
from app.notifications import stream as notif_stream
from app.security.permissions import RequirePermission, has_permission

from .schemas import MarkReadResponse, NotificationListResponse, NotificationRead

notifications_router = APIRouter(prefix="/notifications", tags=["notifications"])


# ── The stream ───────────────────────────────────────────────────────────
#
# Declared before the parameterised routes, matching the house rule that a
# static segment is registered above a path parameter that could swallow it.


@notifications_router.get(
    "/stream",
    summary="Live notification stream (SSE)",
    response_class=StreamingResponse,
)
async def stream(current: CurrentUserDep, request: Request) -> StreamingResponse:
    """Server-sent events carrying the caller's bell contents.

    This route deliberately does **not** take the ``DBSession`` dependency.
    FastAPI holds a ``yield`` dependency open until the response finishes, and
    for a streaming response that means the whole connection — up to ten
    minutes. With a pool of 5 (+10 overflow) per process, a dozen idle browsers
    would exhaust it. Auth is resolved on a short session that is closed before
    streaming starts, and each subsequent read borrows its own.
    """
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        user = await resolve_db_user(current, session)
        # Provisioning on first call can create the row; commit it before the
        # session goes away.
        await session.commit()
        if not has_permission(user.role, "inventory", "view"):
            raise AuthorizationError(
                f"Role '{user.role}' cannot view inventory",
                code="permission_denied",
                details={"resource": "inventory", "action": "view"},
            )
        user_id = user.id

    return StreamingResponse(
        notif_stream.event_stream(user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx (and any proxy that honours it) must not sit on the frames
            # waiting for a full buffer. The Elastic Beanstalk platform nginx
            # is stock — there is no config in this repo to change — so the
            # response header is the only lever available.
            "X-Accel-Buffering": "no",
        },
    )


# ── Reads ────────────────────────────────────────────────────────────────


@notifications_router.get(
    "",
    response_model=NotificationListResponse,
    summary="The caller's notifications, newest first",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_notifications(
    db: DBSession,
    db_user: CurrentDbUserDep,
    status: Annotated[
        Literal["unread", "read", "all"],
        Query(
            description="Which tab of the panel to page: 'unread' is what the "
            "bell shows, 'read' is the history behind it."
        ),
    ] = "unread",
    limit: Annotated[int, Query(ge=1, le=200)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> NotificationListResponse:
    """One page of the caller's feed.

    ``unread_count`` is always counted over the unread set regardless of which
    tab is being paged, because it is what the badge renders — the Read tab must
    not make the badge report the number of things you have already dealt with.
    """
    rows = await notif_repo.list_for_user(
        db, user_id=db_user.id, limit=limit, offset=offset, status=status
    )
    return NotificationListResponse(
        items=[NotificationRead.model_validate(r) for r in rows],
        total=await notif_repo.count_for_user(db, user_id=db_user.id, status=status),
        limit=limit,
        offset=offset,
        unread_count=await notif_repo.unread_count(db, user_id=db_user.id),
    )


# ── Writes ───────────────────────────────────────────────────────────────


@notifications_router.post(
    "/read-all",
    response_model=MarkReadResponse,
    summary="Mark every live unread notification read",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def read_all(db: DBSession, db_user: CurrentDbUserDep) -> MarkReadResponse:
    """Not e-signed, and that is a considered position.

    Reading a notification asserts nothing and changes no record — it is the
    inverse of the acknowledgements that *are* signed, such as the consumable
    expiry check, where a person is attesting they physically looked. Requiring
    a password to clear a badge would teach people to type it without reading.
    """
    updated = await notif_repo.mark_all_read(db, user_id=db_user.id)
    return MarkReadResponse(
        updated=updated,
        unread_count=await notif_repo.unread_count(db, user_id=db_user.id),
    )


@notifications_router.post(
    "/{notification_id}/read",
    response_model=MarkReadResponse,
    summary="Mark one notification read",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def read_one(
    notification_id: uuid.UUID, db: DBSession, db_user: CurrentDbUserDep
) -> MarkReadResponse:
    updated = await notif_repo.mark_read(db, user_id=db_user.id, notification_id=notification_id)
    if updated == 0 and not await _exists_for_user(db, db_user.id, notification_id):
        raise NotFoundError("Notification not found")
    return MarkReadResponse(
        updated=updated,
        unread_count=await notif_repo.unread_count(db, user_id=db_user.id),
    )


@notifications_router.post(
    "/{notification_id}/dismiss",
    response_model=MarkReadResponse,
    summary="Hide one notification for the caller",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def dismiss_one(
    notification_id: uuid.UUID, db: DBSession, db_user: CurrentDbUserDep
) -> MarkReadResponse:
    updated = await notif_repo.dismiss(db, user_id=db_user.id, notification_id=notification_id)
    if updated == 0 and not await _exists_for_user(db, db_user.id, notification_id):
        raise NotFoundError("Notification not found")
    return MarkReadResponse(
        updated=updated,
        unread_count=await notif_repo.unread_count(db, user_id=db_user.id),
    )


async def _exists_for_user(db, user_id: uuid.UUID, notification_id: uuid.UUID) -> bool:
    """Distinguish "already in that state" from "not yours / no such row".

    Both mark-read and dismiss are idempotent, so zero rows updated is the
    normal answer to a second click. Only a row that does not belong to the
    caller — or does not exist — is a 404, and those two cases are deliberately
    indistinguishable from outside: an id that returns 404 for one user and
    "already read" for another would be a membership oracle.
    """
    from sqlalchemy import select

    from app.models.notifications import NotificationDelivery

    stmt = select(NotificationDelivery.id).where(
        NotificationDelivery.id == notification_id,
        NotificationDelivery.user_id == user_id,
    )
    return (await db.execute(stmt)).scalar_one_or_none() is not None
