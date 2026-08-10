"""Application settings that an administrator can change at runtime.

A key/value table rather than more environment variables, because
REQ-2026-07-15-DATA-001 asks for "a configured age" and the client wants to set
it from the Receipt Admin screen — a deploy is the wrong unit of change for a
policy an operations lead owns.

Deliberately small: one row per setting, a JSON value so the next setting needs
no migration, and the user who last changed it so the audit answers "who
loosened the retention policy?".
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

#: How long a finished Order stays on the working list before it is archived
#: (DATA-001). The client proposed one year.
ORDER_ARCHIVE_AFTER_DAYS = "order_archive_after_days"
DEFAULT_ORDER_ARCHIVE_AFTER_DAYS = 365

#: When the archiving sweep last ran. Stored so the Receipt Admin panel can say
#: whether the daily job is alive — "last run 3 weeks ago" is the only way an
#: operator finds out the scheduler died.
ORDER_ARCHIVE_LAST_SWEPT_AT = "order_archive_last_swept_at"

#: How many days BEFORE its expiration date a consumable starts warning.
#:
#: The requirements do not settle this: the main SRS (LOC-008) alerts only once
#: stock "sits past its expiration date", while Transaction Spec §4.2 wants the
#: item flagged when it "is approaching expiration", and the July 9 amendment
#: never gives a number. So it is a setting, defaulted to 30 days, and the open
#: question goes to the client rather than being hard-coded to one reading.
#:
#: Distinct from Planning's "expiring within a year" horizon (REQ-2026-07-09-
#: PLN-003) on purpose — that is a different screen answering a different
#: question, and sharing one constant would couple them wrongly.
CONSUMABLE_EXPIRY_WARN_DAYS = "consumable_expiry_warn_days"
DEFAULT_CONSUMABLE_EXPIRY_WARN_DAYS = 30


class AppSetting(Base):
    """One administrator-editable setting."""

    __tablename__ = "app_settings"
    __table_args__ = ({"schema": "app"},)

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app.users.id", ondelete="RESTRICT"),
        nullable=True,
    )
