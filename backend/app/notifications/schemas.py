"""Wire shapes for ``/v1/notifications``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

#: Mirrors ``NOTIFICATION_KINDS`` in ``app.models.notifications`` and the DB
#: CHECK, the same way ``MovementType`` mirrors ``MOVEMENT_TYPES``.
NotificationKind = Literal[
    "reorder_threshold",
    "expiration_warning",
    "expiration_expired",
]

NotificationSubjectTable = Literal["app.items", "app.consumable_issues"]


class NotificationRead(BaseModel):
    """One notification, as the bell sees it.

    ``body`` is deliberately an open dict rather than a typed union. It is a
    snapshot of the facts behind the alert — item number, quantity, threshold,
    lot, expiry — and the client turns those into a sentence.

    What it must NOT contain is a rendered badge label or a colour. Stock
    status tone and wording live in ``config/inventory.ts`` and are resolved
    from ``body.status_code`` at render time. That rule is not stylistic: the
    same status previously reached the screen through three different call
    sites and rendered in three different colours at once. A server that ships
    a label would quietly become a fourth.
    """

    model_config = ConfigDict(from_attributes=True)

    # ``uuid.UUID``, not ``str``. These are built with ``model_validate`` from an
    # ORM row rather than assembled field by field like ``ReorderRow``, so there
    # is no ``str(...)`` call to convert them and Pydantic will not coerce a UUID
    # into a string on its own. Both serialise to a plain string in JSON, which
    # is what the client's `Notification` type expects.
    id: uuid.UUID
    kind_code: NotificationKind
    subject_table: NotificationSubjectTable
    subject_id: uuid.UUID
    body: dict[str, Any]
    created_at: datetime
    read_at: datetime | None = None
    dismissed_at: datetime | None = None
    resolved_at: datetime | None = None


class NotificationListResponse(BaseModel):
    """One page of the caller's own notifications.

    ``unread_count`` is counted over the whole feed, not the page. The badge on
    the bell has to be a true number — the old client-side feed capped itself
    at ten rows and then displayed that cap as the total, so "10" meant "at
    least 10, possibly hundreds" and nobody could tell which.
    """

    items: list[NotificationRead]
    total: int
    limit: int
    offset: int
    unread_count: int


class MarkReadResponse(BaseModel):
    """Result of marking one or many rows read.

    Returns the fresh ``unread_count`` so the badge settles from the mutation's
    own response rather than needing a follow-up read.
    """

    updated: int
    unread_count: int
