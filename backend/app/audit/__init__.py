"""``app.audit`` — single-source helpers for writing ``audit.audit_events``.

Routes never INSERT into the audit table directly; they go through
``recorder.record_entity_change`` so the diff / event_type plumbing
stays consistent and the test surface is one function.
"""

from __future__ import annotations

from app.audit.recorder import (
    AuditAction,
    record_entity_change,
)

__all__ = ["AuditAction", "record_entity_change"]
