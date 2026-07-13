"""restore_old_schema

RESTORE (2026-07-09). ``week1reset01`` performed a one-way hard reset
(``DROP SCHEMA app/meta/audit CASCADE``) and rebuilt a minimal six-table Week-1
schema. Production ran through that reset (``week1reset01`` → ``loccat01``), but
the source-of-truth application code is the full pre-reset model, so this
migration brings the whole schema back.

What it does:
  * drops the reset-era ``app`` schema (and ``meta``/``audit`` if present) —
    prod data is disposable here, the code is the source of truth
  * rebuilds the complete pre-reset schema captured at revision
    ``f7a8b9c0d1e2`` (all of ``app`` + ``meta`` + ``audit``: tables, indexes,
    views, triggers, functions, the ``app.invite_status`` type and the
    ``app.invitations`` table used by the invite flow) from the sibling SQL
    asset ``restore01_old_schema.sql`` (a ``pg_dump --schema-only`` of that
    revision + the invitations table)
  * re-seeds the four canonical roles (the asset is schema-only, and
    ``app.users`` / ``app.invitations`` FK ``app.roles.code``)

Because ``week1reset01`` is itself one-way, this restore is one-way too:
``downgrade`` is intentionally not implemented.

Revision ID: restore01
Revises: loccat01
Create Date: 2026-07-09 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision: str = "restore01"
down_revision: str | None = "loccat01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The captured pre-reset schema lives beside this file so the (large) DDL
# doesn't clutter the migration. It is a ``pg_dump --schema-only`` of the
# ``f7a8b9c0d1e2`` schema plus the ``app.invitations`` table.
_SCHEMA_SQL = Path(__file__).parent / "restore01_old_schema.sql"

# The four canonical roles: Super Admin, Admin, Operator, Read-Only.
_SEED_ROLES = (
    ("super_admin", "Super Admin", "Full access; bootstrap role."),
    ("admin", "Admin", "User management + all inventory actions."),
    ("operator", "Operator", "Inventory view / create / edit / electronically sign."),
    ("read_only", "Read-Only", "View inventory, ledger, and audit. No mutations."),
)

# The five default item categories (system-created / seeded). Mirrors the
# unified-catalog migration's seed — the schema-only asset above has no data.
_SEED_CATEGORIES = (
    ("Non-Custom Components / Materials", "purchased", "neutral"),
    ("Custom Components / Materials", "purchased", "warning"),
    ("Sub-Assemblies", "built", "accent"),
    ("Finished Goods – Engineering Products", "built", "success"),
    ("Finished Goods – Drug Product", "built", "danger"),
)


def _split_sql(sql: str) -> list[str]:
    """Split a multi-statement SQL script into individual statements.

    Alembic here runs on asyncpg, which refuses multiple commands in one
    prepared statement, so the pg_dump asset must be executed one statement at
    a time. This walker respects the constructs the dump actually uses:
    ``--`` line comments, single-quoted string literals (with ``''`` escaping),
    and dollar-quoted bodies (``$$`` / ``$tag$``) so semicolons inside function
    definitions don't split a statement.
    """
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    in_line_comment = False
    in_string = False
    dollar_tag: str | None = None
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if dollar_tag is not None:
            if sql.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
                continue
            buf.append(ch)
            i += 1
            continue
        if in_string:
            buf.append(ch)
            if ch == "'":
                if nxt == "'":  # escaped quote
                    buf.append(nxt)
                    i += 2
                    continue
                in_string = False
            i += 1
            continue

        # Not in any special state.
        if ch == "-" and nxt == "-":
            in_line_comment = True
            buf.append(ch)
            i += 1
            continue
        if ch == "'":
            in_string = True
            buf.append(ch)
            i += 1
            continue
        if ch == "$":
            # Try to open a dollar-quote tag: $tag$ or $$.
            j = sql.find("$", i + 1)
            if j != -1 and sql[i + 1 : j].replace("_", "").isalnum() or (
                j == i + 1
            ):
                tag = sql[i : j + 1]
                dollar_tag = tag
                buf.append(tag)
                i = j + 1
                continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def upgrade() -> None:
    # Extensions live in ``public`` and survived the reset, but re-ensure them
    # so this migration is safe against a managed Postgres without the dev
    # init hook.
    for ext in ("citext", "ltree", "pg_trgm", "pgcrypto"):
        op.execute(f'CREATE EXTENSION IF NOT EXISTS "{ext}"')

    # Drop the reset-era world. CASCADE clears every FK / view / trigger in one
    # shot; ``public`` (alembic_version + extensions) is untouched.
    op.execute("DROP SCHEMA IF EXISTS app CASCADE")
    op.execute("DROP SCHEMA IF EXISTS meta CASCADE")
    op.execute("DROP SCHEMA IF EXISTS audit CASCADE")

    # Rebuild the full pre-reset schema, one statement at a time (asyncpg
    # rejects multi-command prepared statements).
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    for statement in _split_sql(sql):
        op.execute(statement)

    # Re-seed roles (asset is schema-only; users/invitations FK app.roles.code).
    for code, name, description in _SEED_ROLES:
        op.execute(
            sa.text(
                "INSERT INTO app.roles (code, name, description, is_system) "
                "VALUES (:code, :name, :description, TRUE) "
                "ON CONFLICT (code) DO NOTHING"
            ).bindparams(code=code, name=name, description=description)
        )

    # Re-seed the default item categories (system-created).
    for name, kind, tone in _SEED_CATEGORIES:
        op.execute(
            sa.text(
                "INSERT INTO app.item_categories (name, kind, tone, is_seeded) "
                "VALUES (:name, :kind, :tone, TRUE)"
            ).bindparams(name=name, kind=kind, tone=tone)
        )


def downgrade() -> None:
    raise NotImplementedError(
        "restore_old_schema reverses a one-way hard reset; there is no downgrade."
    )
