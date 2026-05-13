"""Postgres + Redis connection management.

Spec: docs/Specs.md §9, docs/13-Infra.md.
Used by the FastAPI lifespan hook to probe + bind connection pools at startup.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import redis.asyncio as aioredis
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

if TYPE_CHECKING:
    from api.config import Settings

logger = structlog.get_logger(__name__)


async def open_postgres(settings: Settings) -> AsyncEngine:
    """Build the async engine and probe it. Raises if unreachable."""
    engine = create_async_engine(
        settings.database_url,
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
        future=True,
    )
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT version()"))
        version = result.scalar_one()
    logger.info("db.connected", driver="asyncpg", server=str(version).split(" on ", maxsplit=1)[0])
    return engine


async def close_postgres(engine: AsyncEngine) -> None:
    await engine.dispose()
    logger.info("db.disconnected")


async def open_redis(settings: Settings) -> aioredis.Redis[str]:
    """Build the redis client and probe it with PING. Raises if unreachable."""
    client: aioredis.Redis[str] = aioredis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=20,
    )
    pong = await client.ping()
    logger.info("redis.connected", pong=pong, url=_redact(settings.redis_url))
    return client


async def close_redis(client: aioredis.Redis[str]) -> None:
    # `aclose` is the redis-py 5+ async-close method; older type stubs don't know it.
    await client.aclose()  # type: ignore[attr-defined]
    logger.info("redis.disconnected")


def _redact(url: str) -> str:
    """Hide credentials in URLs when logging."""
    if "@" in url:
        scheme, rest = url.split("://", 1)
        creds_and_host = rest.split("@", 1)
        return f"{scheme}://***@{creds_and_host[1]}" if len(creds_and_host) == 2 else url
    return url
