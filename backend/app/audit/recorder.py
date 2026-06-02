"""Append rows to ``audit.audit_events`` from the request handler layer.

This module is the **only** place outside Alembic migrations that
writes to ``audit.audit_events``. Routes call ``record_entity_change``
with a before / after snapshot of the entity (already trimmed to the
business-relevant fields) and the recorder takes care of:

  * Computing the per-field diff so the audit viewer doesn't have to.
  * Emitting a structured ``event_type`` (``inventory.vendor.updated``,
    ``inventory.item.deleted``) so dashboards and alert rules can
    filter with ``event_type LIKE 'inventory.%'``.
  * Picking a sane severity per action (``info`` for create/update,
    ``warning`` for delete; callers can override).
  * Rolling back the *whole* transaction — including the entity write —
    if the audit insert fails. (Caller commits; we just flush.)

Append-only is enforced by trigger at the DB layer; this module
just won't try to mutate.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent


# Allowed actions. ``deleted`` covers both hard and soft (deactivated)
# deletes — the ``after_state`` will carry the soft-delete marker.
AuditAction = Literal["created", "updated", "deleted", "restored"]

# Default severity per action. Override via the ``severity`` kwarg
# when a particular event needs to warn / alert (e.g. role grants).
_DEFAULT_SEVERITY: dict[AuditAction, str] = {
    "created": "info",
    "updated": "info",
    "deleted": "warning",
    "restored": "info",
}


def _compute_diff(
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> dict[str, dict[str, Any]] | None:
    """Return ``{field: {before, after}}`` for fields whose value moved.

    Skips fields whose before/after compare equal (so a no-op PATCH
    yields ``diff = {}`` — an empty diff is meaningful: it tells the
    audit viewer "user touched this row but changed nothing".
    Callers may choose not to write at all on an empty diff). When
    either side is None, all fields from the populated side are
    treated as having moved.
    """
    if before is None and after is None:
        return None
    if before is None:
        return {k: {"before": None, "after": v} for k, v in (after or {}).items()}
    if after is None:
        return {k: {"before": v, "after": None} for k, v in before.items()}
    keys = set(before.keys()) | set(after.keys())
    diff: dict[str, dict[str, Any]] = {}
    for k in keys:
        b = before.get(k)
        a = after.get(k)
        if b != a:
            diff[k] = {"before": b, "after": a}
    return diff


def _event_type(subject_table: str, action: AuditAction) -> str:
    """Dotted event_type matching the long-spec namespace.

    ``meta.vendors`` → ``inventory.vendor.updated``. The first segment
    is hard-coded to ``inventory`` because every entity this module
    audits belongs to that domain; identity / auth events get their
    own recorder later (Chunk A2).
    """
    # ``meta.vendors`` → ``vendor``; ``app.items`` → ``item``; etc.
    bare = subject_table.split(".")[-1]
    singular = bare.rstrip("s") if bare.endswith("s") else bare
    return f"inventory.{singular}.{action}"


async def record_entity_change(
    session: AsyncSession,
    *,
    actor_user_id: uuid.UUID | None,
    action: AuditAction,
    subject_table: str,
    subject_id: uuid.UUID,
    subject_label: str | None,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    actor_kind: Literal["user", "system", "integration"] = "user",
    severity: str | None = None,
    context: dict[str, Any] | None = None,
    signature_id: uuid.UUID | None = None,
) -> AuditEvent:
    """Insert one audit row tied to a state change.

    Caller responsibilities:

    * Trim ``before`` / ``after`` to business-relevant fields. Don't
      pass entire ORM ``__dict__`` blobs — they include SQLAlchemy
      internals and will balloon the audit table.
    * Use ``before=None`` for ``created`` events and ``after=None``
      for hard ``deleted`` events. For soft deletes, ``after`` should
      carry the marker (``{"is_active": false}`` or
      ``{"deleted_at": "..."}``) so the diff is informative.
    * Commit the transaction yourself after this call returns — the
      recorder flushes but does not commit, so a failed audit write
      rolls back the entity write too.
    """
    event = AuditEvent(
        actor_user_id=actor_user_id if actor_kind == "user" else actor_user_id,
        actor_kind=actor_kind,
        event_type=_event_type(subject_table, action),
        severity=severity or _DEFAULT_SEVERITY[action],
        subject_table=subject_table,
        subject_id=subject_id,
        subject_label=subject_label,
        action=action,
        before_state=before,
        after_state=after,
        diff=_compute_diff(before, after),
        context=context or {},
        signature_id=signature_id,
    )
    session.add(event)
    await session.flush()
    return event
