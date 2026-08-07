"""Alembic migration environment.

Runs both online (against a live DB) and offline (emits SQL). Both modes
share the same metadata and connection string sourced from app settings —
not from ``alembic.ini`` — so there's a single source of truth.

Async note: Alembic itself is sync. We wrap it with ``asyncio.run`` and an
async engine when running online, then hand a sync ``Connection`` back to
Alembic via ``connection.run_sync``.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# Import the metadata so autogenerate sees our models. Importing the
# ``models`` package is the side-effect that registers every model on
# ``Base.metadata``.
from app.core.config import get_settings
from app.db.base import Base
from app import models as _models

# Alembic config object provides access to .ini values
config = context.config

# Override the DSN from settings — the .ini placeholder is intentionally fake.
settings = get_settings()
# Escape % so Alembic's ConfigParser (BasicInterpolation) doesn't treat a
# URL-encoded password (e.g. %3E from a generated password) as an
# interpolation token and raise "invalid interpolation syntax".
config.set_main_option("sqlalchemy.url", str(settings.database_url).replace("%", "%%"))

# Set up logging per the [loggers] section of alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

#: Advisory-lock key held for the duration of a migration run. Any constant
#: works as long as every process uses the same one; this is ``cell`` in ASCII,
#: which makes it recognisable in ``pg_locks`` when working out who holds it.
MIGRATION_LOCK_ID = 0x63656C6C


def _include_object(obj, name, type_, reflected, compare_to) -> bool:
    """Filter out objects we never want Alembic to manage.

    Notably: the ``alembic_version`` table itself, and partitions created by
    ``pg_partman`` (when we add audit partitioning).
    """
    if type_ == "table" and name in {"alembic_version"}:
        return False
    return True


def run_migrations_offline() -> None:
    """Run migrations without a live DB connection — emits SQL to stdout."""
    context.configure(
        url=str(settings.database_url_sync),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=_include_object,
        include_schemas=True,
        version_table_schema="public",
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=_include_object,
        include_schemas=True,
        version_table_schema="public",
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        # Serialise migrations across instances.
        #
        # Every instance runs the ``migrate`` container, so a load-balanced
        # environment starts N of them simultaneously against ONE database.
        # Without a lock they all read the same ``alembic_version``, all decide
        # the same revision is pending, and all try to apply it: one wins and
        # the rest die on "column already exists". Their backends then never
        # start at all, because docker-compose gates the backend on
        # ``service_completed_successfully`` — so the deploy comes up at a
        # fraction of capacity, or none.
        #
        # Taken BEFORE ``run_migrations()`` deliberately: alembic reads the
        # current head inside that call, so a waiter re-reads it only after the
        # winner has committed, and correctly finds there is nothing to do.
        # Reading it earlier would leave the waiter acting on a stale plan.
        #
        # The ``_xact_`` form releases on commit OR rollback, including when the
        # process dies mid-migration. A session-level ``pg_advisory_lock`` would
        # stay held until the connection was reaped, which on a failed deploy
        # means the retry blocks on a lock nobody owns.
        connection.execute(
            text("SELECT pg_advisory_xact_lock(:key)"), {"key": MIGRATION_LOCK_ID}
        )
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations against a live DB via an async engine."""
    # RDS (prod) enforces TLS; the local dev postgres container does not
    # accept TLS, so only require it outside dev.
    connect_args = {"ssl": "require"} if settings.is_production else {}
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args=connect_args,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
