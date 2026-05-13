"""Redis key namespace + typed helpers per docs/Specs.md §9.2.

Every key carries the subreddit_id where applicable (invariant I-7).
Public functions take `subreddit_id` as a mandatory positional arg.

Key patterns owned by this module:
    profile:{sub}:{user}        cached UserMemory (1h TTL)
    summary:{thread}            thread summary blob (24h TTL)
    velocity:{sub}:{target}     sliding-window report timestamps (1h TTL)
    verdict:{correlation_id}    full verdict for "Explain last call" (7d TTL)
    embedding:{rule}            precomputed rule embedding (30d TTL)
    budget:{sub}:{day}          daily spend counter (24h TTL)
"""

from __future__ import annotations

import json
import math
import time
from typing import TYPE_CHECKING

from store.types import UserMemoryRow

if TYPE_CHECKING:
    from redis.asyncio import Redis

# === TTL constants (seconds) ===========================================

_TTL_PROFILE = 60 * 60
_TTL_SUMMARY = 60 * 60 * 24
_TTL_VELOCITY = 60 * 60
_TTL_VERDICT = 60 * 60 * 24 * 7
_TTL_EMBEDDING = 60 * 60 * 24 * 30
_TTL_BUDGET = 60 * 60 * 24


# === Key builders ======================================================


def k_profile(subreddit_id: str, user_id: str) -> str:
    return f"profile:{subreddit_id}:{user_id}"


def k_summary(thread_id: str) -> str:
    return f"summary:{thread_id}"


def k_velocity(subreddit_id: str, target_id: str) -> str:
    return f"velocity:{subreddit_id}:{target_id}"


def k_verdict(correlation_id: str) -> str:
    return f"verdict:{correlation_id}"


def k_embedding(rule_id: str) -> str:
    return f"embedding:{rule_id}"


def k_budget(subreddit_id: str, day: str) -> str:
    """day is ISO YYYY-MM-DD (UTC)."""
    return f"budget:{subreddit_id}:{day}"


# === Profile cache =====================================================


async def get_profile_cache(
    client: Redis[str], *, subreddit_id: str, user_id: str
) -> UserMemoryRow | None:
    raw = await client.get(k_profile(subreddit_id, user_id))
    if not raw:
        return None
    return UserMemoryRow.model_validate(json.loads(raw))


async def set_profile_cache(
    client: Redis[str], *, subreddit_id: str, user_id: str, row: UserMemoryRow
) -> None:
    await client.set(
        k_profile(subreddit_id, user_id),
        row.model_dump_json(),
        ex=_TTL_PROFILE,
    )


# === Thread summary cache ==============================================


async def get_thread_summary(client: Redis[str], *, thread_id: str) -> dict[str, object] | None:
    raw = await client.get(k_summary(thread_id))
    return json.loads(raw) if raw else None


async def set_thread_summary(
    client: Redis[str], *, thread_id: str, summary: dict[str, object]
) -> None:
    await client.set(k_summary(thread_id), json.dumps(summary), ex=_TTL_SUMMARY)


# === Report velocity (sliding window) ==================================

# Implementation: a Redis sorted set per target, scored by epoch-seconds.
# `ZADD` on each report, `ZREMRANGEBYSCORE` to evict outside the window,
# `ZCARD` to read the current count. The z-score is computed against a
# rolling per-subreddit baseline (a separate key, post-MVP).


async def record_report(
    client: Redis[str],
    *,
    subreddit_id: str,
    target_id: str,
    timestamp: float | None = None,
) -> int:
    """Append a report event to the sliding window. Returns the current count."""
    now = timestamp if timestamp is not None else time.time()
    key = k_velocity(subreddit_id, target_id)
    await client.zadd(key, {f"{now}-{int(now * 1000)}": now})
    cutoff = now - _TTL_VELOCITY
    await client.zremrangebyscore(key, "-inf", cutoff)
    await client.expire(key, _TTL_VELOCITY)
    return int(await client.zcard(key))


async def velocity_count(
    client: Redis[str], *, subreddit_id: str, target_id: str, window_seconds: int = _TTL_VELOCITY
) -> int:
    now = time.time()
    key = k_velocity(subreddit_id, target_id)
    cutoff = now - window_seconds
    return int(await client.zcount(key, cutoff, "+inf"))


def velocity_zscore(count: int, baseline_mean: float, baseline_stddev: float) -> float:
    """Tiny pure helper — used by the report_velocity tool. Treats stddev=0 as 1."""
    sd = baseline_stddev if baseline_stddev > 0 else 1.0
    z = (count - baseline_mean) / sd
    # Cap to avoid pathological values for prompt tokens / UI:
    return float(max(-9.0, min(9.0, z)))


# === Verdict cache (for "Explain ModPilot's last call" menu) ===========


async def get_cached_verdict(
    client: Redis[str], *, correlation_id: str
) -> dict[str, object] | None:
    raw = await client.get(k_verdict(correlation_id))
    return json.loads(raw) if raw else None


async def set_cached_verdict(
    client: Redis[str], *, correlation_id: str, verdict: dict[str, object]
) -> None:
    await client.set(k_verdict(correlation_id), json.dumps(verdict), ex=_TTL_VERDICT)


# === Daily budget tracking =============================================


def _today_utc() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


async def add_spend(
    client: Redis[str], *, subreddit_id: str, cents: int, day: str | None = None
) -> int:
    """Atomically increment today's spend (integer cents). Returns the new total.

    The Calibrator + budget gate (post-MVP) read this to enforce
    daily_spend_cap_per_sub_usd from Settings.
    """
    key = k_budget(subreddit_id, day or _today_utc())
    new_total = int(await client.incrby(key, cents))
    await client.expire(key, _TTL_BUDGET)
    return new_total


async def todays_spend_cents(
    client: Redis[str], *, subreddit_id: str, day: str | None = None
) -> int:
    key = k_budget(subreddit_id, day or _today_utc())
    raw = await client.get(key)
    return int(raw) if raw else 0


def cents(usd: float) -> int:
    """Convert a USD float to integer cents (rounded). Avoids float drift in incrby."""
    return math.ceil(usd * 100)
