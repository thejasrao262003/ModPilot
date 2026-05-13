"""Alembic env for the engine.

Loads the URL from `Settings` so we never duplicate connection strings.
For autogenerate to see new tables, every model module that defines a
table must be imported below (or transitively via store.models).
"""

from __future__ import annotations

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context
from api.config import get_settings
from store.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Allow runtime override of the URL (so tests / staging can swap DBs).
# Settings.database_url is the async URL (postgresql+asyncpg://...); Alembic
# needs a sync driver — swap to psycopg.
settings = get_settings()
runtime_url = settings.database_url.replace("+asyncpg", "+psycopg")
config.set_main_option("sqlalchemy.url", runtime_url)


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting (used for review)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
