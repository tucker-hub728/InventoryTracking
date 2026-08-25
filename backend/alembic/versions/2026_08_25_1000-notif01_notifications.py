"""notif01: per-user notification deliveries + alert state (NOTIF-001)

Creates the two tables behind the notification bell.

**This replaces a bell that was never real.** Until now the panel was assembled
in the browser from the first five rows of ``/planning/reorder`` and the first
five of ``/consumables/expiring``, formatted to look like notifications. Nothing
was stored, so "notification" meant "a query result rendered with an icon": it
was identical for every user, it only changed when you navigated to another
page, and "Mark all as read" lived in a JavaScript ``Set`` that a refresh threw
away. The client asked for all three of those to stop being true (2026-08-25).

``app.notification_deliveries`` follows ``docs/backend-data-structure.md`` §11.2
and ``docs/modules/inventory.md`` §7.4 with one deliberate change: ``user_id``
is a column. The doc specifies an index on ``(user_id, read_at NULLS FIRST,
created_at DESC)`` for a table whose columns it lists without a ``user_id`` —
the recipient was meant to be reached through ``subscription_id``. Phase 1 has
no subscriptions (client: fan out now, subscribe later), and even with them the
bell's hot query is "my unread, newest first". The recipient belongs on the row.

Recipients are users holding ``inventory:sign``, not ``inventory:view`` — both
alerts ask somebody to act, and both actions (acknowledging an expiry check,
receiving to inventory) are gated on ``sign``. On the dev database that is the
difference between 5 recipients and 518, because ``view`` includes 513 seeded
``read_only`` accounts that can do nothing about either alert. See
``app/notifications/emitter.py``.

``app.notification_alert_state`` is not in the docs. It is what stops the feed
repeating itself. A low-stock alert is a *state*, not an event — the database
records that an item is below its threshold, never the moment it crossed — so
an evaluator with no memory re-announces every below-threshold item on every
run. This table remembers what was last said about each subject, which turns
emission into an edge trigger: announce on the way in, resolve on the way out.

The doc's ``meta.notification_kinds`` reference table is deliberately NOT
created. It exists so an admin can relabel a kind without a migration, which
only earns its keep once there is a screen to relabel from; three fixed codes
are a tuple and a CHECK, matching ``ck_movements_type``. It arrives in phase 2
with ``notification_subscriptions`` and ``item_watch_subscriptions``.

No retention job here either. The doc asks for 90 days and estimates ~50k rows
a year, which is small enough that deleting on a schedule is a separate
decision rather than a launch blocker — and a purge that runs before anyone has
seen the feed work would be the wrong first thing to add.

Revision ID: notif01
Revises: pln01
Create Date: 2026-08-25 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "notif01"
down_revision: str | None = "pln01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: Mirrors ``NOTIFICATION_KINDS`` in ``app/models/notifications.py``. Duplicated
#: rather than imported: a migration has to keep describing the schema it built
#: even after the model moves on, which is the whole reason migrations are not
#: generated from models at run time.
_KINDS = ("reorder_threshold", "expiration_warning", "expiration_expired")
_SUBJECT_TABLES = ("app.items", "app.consumable_issues")


def _in_list(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.create_table(
        "notification_deliveries",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        # ON DELETE CASCADE, unlike the RESTRICT used on audit rows. An audit
        # event is a record of what happened and must outlive its actor; a
        # notification is a message to a person, and deleting the person should
        # take their inbox with them rather than make the user row undeletable.
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind_code", sa.Text(), nullable=False),
        sa.Column("subject_table", sa.Text(), nullable=False),
        sa.Column("subject_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Snapshotted at emit time, not joined on read: a notification has to
        # keep reading correctly after the item it describes is renamed or
        # soft-deleted. Carries ``status_code``, never a colour or a label —
        # stock-status tone and wording are owned by the client's
        # ``config/inventory.ts`` and must have exactly one source.
        sa.Column(
            "body",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # The point of the exercise: read state that survives a refresh.
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        # Set when the condition clears. The row stays — it is true that the
        # alert was raised — but drops out of the bell, so a restocked item
        # stops nagging without anybody having to read it first.
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_notification_deliveries"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["app.users.id"],
            name="fk_notification_deliveries_user_id_users",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            _in_list("kind_code", _KINDS),
            name="ck_notification_deliveries_kind_code",
        ),
        sa.CheckConstraint(
            _in_list("subject_table", _SUBJECT_TABLES),
            name="ck_notification_deliveries_subject_table",
        ),
        schema="app",
    )

    # The bell's only hot query, served by one index scan: unread first, then
    # newest first, within one user.
    op.execute(
        "CREATE INDEX ix_notification_deliveries_user_unread"
        " ON app.notification_deliveries"
        " (user_id, read_at NULLS FIRST, created_at DESC)"
    )
    # "Every alert ever raised about this subject" — the emitter uses it to
    # resolve open rows when a condition clears.
    op.execute(
        "CREATE INDEX ix_notification_deliveries_subject"
        " ON app.notification_deliveries"
        " (subject_table, subject_id, created_at DESC)"
    )

    op.create_table(
        "notification_alert_state",
        sa.Column("subject_table", sa.Text(), nullable=False),
        sa.Column("subject_id", postgresql.UUID(as_uuid=True), nullable=False),
        # No CHECK: the vocabulary differs per subject ('available' /
        # 'low_stock' / 'out_of_stock' for items, 'ok' / 'warn' / 'expired' for
        # consumable issues) and the only writer is the emitter.
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Keyed by subject, not by (subject, kind): a subject has one alert
        # state at a time and the kind is derived from it. An item going
        # low_stock → out_of_stock is one subject changing twice, and keying by
        # kind would strand the stale low_stock row to be resolved separately.
        sa.PrimaryKeyConstraint("subject_table", "subject_id", name="pk_notification_alert_state"),
        schema="app",
    )


def downgrade() -> None:
    # Both tables are lost outright, and neither can be reconstructed.
    #
    # ``notification_deliveries`` holds read/dismissed timestamps that exist
    # nowhere else — they are a record of what each person has seen, not a
    # cache of something derivable. ``notification_alert_state`` is recoverable
    # in effect but not in fact: re-running the emitter after a downgrade will
    # rebuild it from current stock, and in doing so re-announce every item
    # that is currently below threshold, because with the memory gone every
    # subject looks like a fresh transition.
    op.drop_table("notification_alert_state", schema="app")
    op.drop_index(
        "ix_notification_deliveries_subject",
        table_name="notification_deliveries",
        schema="app",
    )
    op.drop_index(
        "ix_notification_deliveries_user_unread",
        table_name="notification_deliveries",
        schema="app",
    )
    op.drop_table("notification_deliveries", schema="app")
