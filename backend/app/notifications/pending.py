"""Tagging subjects for re-evaluation at commit time (NOTIF-001).

A leaf module by necessity. The ledger-writer helpers live in
``app.locations.repository``, ``app.consumables.repository`` and
``app.kitting.repository``; the emitter reads from all three. If the helpers
imported the emitter directly that would be a cycle, so the one thing they need
— "remember this item" — lives here, importing nothing but SQLAlchemy's session
type.

Storing on ``session.info`` rather than in a module global is deliberate: the
tags belong to one transaction. A module-level set would leak ids between
concurrent requests in the same worker and re-evaluate items whose transaction
had already rolled back.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

ITEMS_KEY = "notify_items"
ISSUES_KEY = "notify_issues"


def mark_item(session: AsyncSession, item_id: uuid.UUID | None) -> None:
    """Note that this item's stock position may have changed.

    Called from every helper that writes a ``stock_movements`` row. One line at
    each call site, and deliberately not an ORM event listener or a decorator:
    those helpers are where this codebase already says out loud that stock
    moved, and an implicit hook would hide it from whoever reads them next.

    Marking is cheap and always safe. Evaluation re-reads the item's real state
    and does nothing unless it crossed a line, so a mark that turns out not to
    matter — a net-zero transfer, a rolled-back request — costs one query and
    changes nothing.
    """
    if item_id is not None:
        session.info.setdefault(ITEMS_KEY, set()).add(item_id)


def mark_issue(session: AsyncSession, issue_id: uuid.UUID | None) -> None:
    """As :func:`mark_item`, for a consumable register row."""
    if issue_id is not None:
        session.info.setdefault(ISSUES_KEY, set()).add(issue_id)


def take_pending(
    session: AsyncSession,
) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """Remove and return everything tagged on this session.

    Removing rather than reading: the drain runs once per transaction, and
    leaving the tags behind would re-evaluate them on the next request that
    happened to reuse the session object.
    """
    return (
        session.info.pop(ITEMS_KEY, set()),
        session.info.pop(ISSUES_KEY, set()),
    )
