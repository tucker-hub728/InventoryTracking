"""Helpers for free-text search input.

Free-text ``q`` parameters were unbounded in length and were interpolated
straight into a LIKE pattern as ``f"%{q}%"``. Neither is SQL injection —
every query binds its parameters — but both are cheap ways to make the
database work hard:

  * ``%`` and ``_`` inside the user's text are LIKE *wildcards*, so a search
    for ``%`` matches every row in the table. A leading-wildcard LIKE cannot
    use a btree index, so that is a full scan per request, repeatable by any
    authenticated user.
  * With no ``max_length``, a multi-kilobyte ``q`` is accepted and compared
    against every row.

``escape_like`` neutralises the wildcards (and the escape character itself,
which must be doubled first or it would escape the escapes we add). Callers
MUST pass ``escape="\\\\"`` to the corresponding ``.like()`` / ``.ilike()``,
otherwise the backslashes are matched literally and nothing is found.

``MAX_SEARCH_LENGTH`` is the companion bound for the ``Query(...)`` declaration.
"""

from __future__ import annotations

# Long enough for any real lot number, item description or person's name;
# short enough that the comparison cost stays trivial.
MAX_SEARCH_LENGTH = 128


def escape_like(value: str) -> str:
    """Escape LIKE wildcards so the text is matched literally.

    Backslash first — doing it after would also escape the backslashes
    introduced for ``%`` and ``_``.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def like_contains(value: str) -> str:
    """Build a ``%term%`` pattern with wildcards in the term escaped."""
    return f"%{escape_like(value)}%"


__all__ = ["MAX_SEARCH_LENGTH", "escape_like", "like_contains"]
