"""Redis helper tests — round-trip against the local redis:7 container.

Auto-skips when SKIP_DB_TESTS=true. Local-loop runs against
`make services-up`.
"""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from redis.asyncio import Redis

from api.config import get_settings
from store.connections import close_redis, open_redis
from store.redis import (
    add_spend,
    cents,
    get_cached_verdict,
    get_profile_cache,
    get_thread_summary,
    k_velocity,
    record_report,
    set_cached_verdict,
    set_profile_cache,
    set_thread_summary,
    todays_spend_cents,
    velocity_count,
    velocity_zscore,
)
from store.types import UserMemoryRow

pytestmark = pytest.mark.skipif(
    os.getenv("SKIP_DB_TESTS", "false").lower() in ("true", "1", "yes"),
    reason="SKIP_DB_TESTS=true (CI without docker services)",
)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[Redis[str]]:
    get_settings.cache_clear()
    c = await open_redis(get_settings())
    try:
        yield c
    finally:
        await close_redis(c)


def _sub() -> str:
    return f"t5_{uuid.uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_profile_cache_roundtrip(client: Redis[str]) -> None:
    sub, user = _sub(), "t2_a"
    row = UserMemoryRow(
        subreddit_id=sub,
        user_id=user,
        risk_tier="watched",
        prior_violations=3,
        prior_approvals=1,
    )
    await set_profile_cache(client, subreddit_id=sub, user_id=user, row=row)
    got = await get_profile_cache(client, subreddit_id=sub, user_id=user)
    assert got is not None
    assert got.risk_tier == "watched"
    assert got.prior_violations == 3


@pytest.mark.asyncio
async def test_profile_cache_miss(client: Redis[str]) -> None:
    got = await get_profile_cache(client, subreddit_id=_sub(), user_id="t2_nobody")
    assert got is None


@pytest.mark.asyncio
async def test_thread_summary_roundtrip(client: Redis[str]) -> None:
    thread = f"t3_{uuid.uuid4().hex[:8]}"
    summary = {"arc": "heated", "escalation_turn": 8, "off_topic": False}
    await set_thread_summary(client, thread_id=thread, summary=summary)
    got = await get_thread_summary(client, thread_id=thread)
    assert got == summary


@pytest.mark.asyncio
async def test_report_velocity_sliding_window(client: Redis[str]) -> None:
    sub, target = _sub(), f"t1_{uuid.uuid4().hex[:8]}"
    # 4 reports in quick succession → count is 4.
    for _ in range(4):
        await record_report(client, subreddit_id=sub, target_id=target)
    assert await velocity_count(client, subreddit_id=sub, target_id=target) == 4

    # Old reports outside the window are evicted. Manually inject one.
    import time as _t
    old = _t.time() - 7200  # 2 hours ago
    await client.zadd(k_velocity(sub, target), {f"old-{old}": old})
    # velocity_count(window=3600) should still see only the 4 fresh ones.
    assert (
        await velocity_count(
            client, subreddit_id=sub, target_id=target, window_seconds=3600
        )
        == 4
    )


def test_velocity_zscore_pure() -> None:
    # 4 reports against a baseline of mean=0.5, sd=0.5 → z = 7
    assert velocity_zscore(4, 0.5, 0.5) == 7.0
    # stddev=0 fallback uses 1
    assert velocity_zscore(3, 1.0, 0.0) == 2.0
    # capped at 9
    assert velocity_zscore(100, 0.0, 1.0) == 9.0
    assert velocity_zscore(-100, 0.0, 1.0) == -9.0


@pytest.mark.asyncio
async def test_verdict_cache_roundtrip(client: Redis[str]) -> None:
    corr = f"inv-{uuid.uuid4().hex[:8]}"
    verdict = {"recommendation": "REMOVE", "calibrated_confidence": 0.92}
    await set_cached_verdict(client, correlation_id=corr, verdict=verdict)
    got = await get_cached_verdict(client, correlation_id=corr)
    assert got == verdict


@pytest.mark.asyncio
async def test_budget_tracking(client: Redis[str]) -> None:
    sub = _sub()
    day = "2026-05-13"
    assert await todays_spend_cents(client, subreddit_id=sub, day=day) == 0
    after_first = await add_spend(client, subreddit_id=sub, cents=12, day=day)
    after_second = await add_spend(client, subreddit_id=sub, cents=8, day=day)
    assert after_first == 12
    assert after_second == 20
    assert await todays_spend_cents(client, subreddit_id=sub, day=day) == 20


def test_cents_rounding() -> None:
    assert cents(0.10) == 10
    assert cents(0.105) == 11  # ceil — never undercount spend
    assert cents(0.0) == 0
