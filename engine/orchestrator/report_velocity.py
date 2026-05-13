"""report_velocity tool — detect rapid / coordinated reporting.

Spec: docs/04-InvestigationEngine.md §5.3.2.

Pure Redis read: sliding-window count over 1 h / 5 min / 1 min windows,
then z-score against a subreddit baseline.  No LLM, no Postgres.
Target: <30 ms p95.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from orchestrator.tools import ToolContext, ToolName, ToolResult
from store.redis import velocity_count, velocity_zscore

if TYPE_CHECKING:
    from redis.asyncio import Redis

# Baseline defaults until per-subreddit baselines are computed (post-MVP).
_DEFAULT_BASELINE_MEAN = 1.0
_DEFAULT_BASELINE_STDDEV = 1.0

# Window sizes (seconds) — match spec §5.3.2.
_WINDOW_1M = 60
_WINDOW_5M = 300
_WINDOW_15M = 900


class ReportVelocityTool:
    """Detects rapid/coordinated reporting via Redis sliding window + z-score.

    Injected with a Redis client at startup; uses only the
    ``velocity_count`` / ``velocity_zscore`` helpers from ``store.redis``.
    """

    def __init__(self, redis: Redis[str]) -> None:
        self._redis = redis

    @property
    def name(self) -> ToolName:
        return "report_velocity"

    async def run(self, context: ToolContext) -> ToolResult:
        t0 = time.monotonic()
        try:
            count_1m, count_5m, count_15m = await self._fetch_counts(context)
            z = velocity_zscore(count_5m, _DEFAULT_BASELINE_MEAN, _DEFAULT_BASELINE_STDDEV)
            latency = _elapsed_ms(t0)

            summary = f"{count_5m} reports in 5 min (z={z:.1f})"
            if len(summary) > 200:
                summary = summary[:200]

            return ToolResult(
                tool=self.name,
                status="success",
                summary=summary,
                latency_ms=latency,
                detail={
                    "reports_1m": count_1m,
                    "reports_5m": count_5m,
                    "reports_15m": count_15m,
                    "baseline_mean": _DEFAULT_BASELINE_MEAN,
                    "baseline_stddev": _DEFAULT_BASELINE_STDDEV,
                    "z_score": z,
                },
            )
        except Exception as exc:
            return ToolResult(
                tool=self.name,
                status="failure",
                summary="velocity lookup failed",
                latency_ms=_elapsed_ms(t0),
                error=str(exc),
            )

    async def _fetch_counts(self, ctx: ToolContext) -> tuple[int, int, int]:
        """Parallel-ish reads for three window sizes."""
        common = {"subreddit_id": ctx.subreddit_id, "target_id": ctx.target_id}
        c1 = await velocity_count(self._redis, **common, window_seconds=_WINDOW_1M)
        c5 = await velocity_count(self._redis, **common, window_seconds=_WINDOW_5M)
        c15 = await velocity_count(self._redis, **common, window_seconds=_WINDOW_15M)
        return c1, c5, c15


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)
