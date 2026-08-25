"""Notification delivery rows and the alert state that gates them (NOTIF-001).

Two tables, and the second is the one that needs explaining.

``notification_deliveries`` is the feed itself: one row per (recipient, event).
It follows ``docs/backend-data-structure.md`` §11.2 and
``docs/modules/inventory.md`` §7.4, with one deviation — ``user_id`` is a real
column here. The doc lists an index on ``user_id`` but never gives the table the
column, having hung the recipient off ``subscription_id`` instead. Phase 1 has
no subscriptions (client, 2026-08-25: fan out now, subscribe later), and the
bell's only hot query is "my unread, newest first". Denormalising the recipient
is what makes that a single index scan, and it stays correct when the
subscription tables land — a subscription would explain *why* a row exists, not
who it is for.

``notification_alert_state`` has no counterpart in the docs at all. It exists
because a low-stock alert is a **state**, not an event: nothing in the database
records the moment an item crossed its threshold, only that it is below it now
(see the ``status_code`` CASE in ``app.v_item_stock``). Without somewhere to
remember what we last said about a subject, every evaluation would look at the
same below-threshold item and emit the same notification again — hourly, for
every user, forever. This table is what makes emission edge-triggered: we emit
on the transition INTO a bad state, and resolve on the transition out of it.

Why not look for an existing unread delivery instead? Because "unread" is
per-user, and per-user state cannot answer a question about the subject. Two
users reading at different times would give different answers about whether an
item has already been announced, and a user who marks everything read would
start receiving duplicates.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
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

#: Single source of truth for the kind enum. Mirrors the DB CHECK and the
#: Pydantic ``NotificationKind`` literal, the same way ``MOVEMENT_TYPES`` does
#: in ``app.models.inventory``.
#:
#: Deliberately NOT the doc's ``meta.notification_kinds`` reference table. That
#: table exists so an admin can relabel a kind without a migration, which only
#: pays for itself once there is a screen to relabel from; phase 1 has three
#: fixed codes, and the house pattern for a fixed set is a tuple plus a CHECK.
#:
#: ``expiration_expired`` replaces the doc's ``expiration_imminent``. The doc
#: imagined a second, shorter warning window (7 days); what the consumables
#: engine actually reports is ``warn`` vs ``expired`` (``flag_for``), and a code
#: named "imminent" for something that has already expired would be a lie.
NOTIFICATION_KINDS: tuple[str, ...] = (
    "reorder_threshold",
    "expiration_warning",
    "expiration_expired",
)

#: Subjects a notification can point at. Schema-qualified to match
#: ``audit_events.subject_table``, so the two can be read side by side.
NOTIFICATION_SUBJECT_TABLES: tuple[str, ...] = (
    "app.items",
    "app.consumable_issues",
)


class NotificationDelivery(Base):
    """One notification, for one recipient.

    Fan-out happens at write time: an event concerning five users writes five
    rows. That is the doc's model and it is the right one here — ``read_at`` is
    per-person, so a single shared row would have nowhere to put it.
    """

    __tablename__ = "notification_deliveries"
    __table_args__ = (
        # The bell's only hot query. ``read_at NULLS FIRST`` puts unread at the
        # top of the same index that orders by recency, so the panel and the
        # badge count are one scan rather than two.
        Index(
            "ix_notification_deliveries_user_unread",
            "user_id",
            text("read_at NULLS FIRST"),
            text("created_at DESC"),
        ),
        # "Every alert ever raised about this subject" — used by the emitter to
        # resolve open rows when a condition clears, and by any future
        # item-detail history tab.
        Index(
            "ix_notification_deliveries_subject",
            "subject_table",
            "subject_id",
            text("created_at DESC"),
        ),
        CheckConstraint(
            "kind_code IN (" + ", ".join(f"'{k}'" for k in NOTIFICATION_KINDS) + ")",
            name="ck_notification_deliveries_kind_code",
        ),
        CheckConstraint(
            "subject_table IN (" + ", ".join(f"'{s}'" for s in NOTIFICATION_SUBJECT_TABLES) + ")",
            name="ck_notification_deliveries_subject_table",
        ),
        {"schema": "app"},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    # CASCADE, not RESTRICT — unlike an audit row, a notification is not a
    # record of what happened, it is a message to somebody. Deleting the person
    # should take their inbox with them rather than pinning the user row
    # undeletable forever.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind_code: Mapped[str] = mapped_column(Text, nullable=False)
    subject_table: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # Rendered at emit time: title, detail, and the raw fields the client needs
    # to re-render (``status_code``, ``item_number``, …). Snapshotted rather
    # than joined on read, so a notification still reads correctly after the
    # item it describes has been renamed or soft-deleted.
    #
    # It carries ``status_code``, never a colour or a badge label. Stock status
    # tone and wording come from ``config/inventory.ts`` on the client and from
    # nowhere else — see the note in the emitter.
    body: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    #: The per-user read state this whole feature exists to make durable.
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Set when the underlying condition clears — restocked, acknowledged. The
    #: row stays (it is a true record that the alert was raised) but drops out
    #: of the bell, so a restocked item stops nagging without anyone reading it.
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NotificationAlertState(Base):
    """What we last told people about one subject.

    Keyed by the subject rather than by (subject, kind) on purpose: a subject
    has exactly one alert state at a time, and the kind is derived from it. An
    item going ``low_stock`` → ``out_of_stock`` is one subject changing state
    twice, not two independent alerts; keying by kind would strand the stale
    ``low_stock`` row to be resolved separately.
    """

    __tablename__ = "notification_alert_state"
    __table_args__ = ({"schema": "app"},)

    subject_table: Mapped[str] = mapped_column(Text, primary_key=True)
    subject_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    #: Free text rather than a CHECK: the vocabulary differs per subject
    #: (``available``/``low_stock``/``out_of_stock`` for items, ``ok``/``warn``/
    #: ``expired`` for consumable issues) and it is written only by the emitter.
    state: Mapped[str] = mapped_column(Text, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
