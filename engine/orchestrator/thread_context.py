"""thread_context tool — structured Reddit thread summary via Gemini 2.5 Flash.

Spec: docs/04-InvestigationEngine.md §5.3.5, docs/06-AILayer.md §2.2.

Reads thread excerpts from ToolContext (populated by the API handler from
the InvestigateRequest), checks the Redis cache, and if cold, calls the
Summarizer (Gemini 2.5 Flash with thinking disabled).

Skip conditions (status="skipped"):
- Fewer than `_MIN_COMMENTS_FOR_SUMMARY` excerpts (default 10) — short threads
  don't carry enough signal to summarize, and the spec gates the tool on this.

Signal escalation (detail["signal"] = "high") fires when the summary reports
an escalation_turn — that's the strongest evidence a moderator wants.
"""

from __future__ import annotations

import contextlib
import time
from typing import TYPE_CHECKING

from llm.prompts.summarizer import Summarizer, ThreadSummary
from orchestrator.tools import ToolContext, ToolName, ToolResult
from store.redis import get_thread_summary, set_thread_summary

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from llm.client import LLMClient


_MIN_COMMENTS_FOR_SUMMARY = 10
_SUMMARY_PREVIEW_CHARS = 180


class ThreadContextTool:
    """Summarizes the thread surrounding a reported target.

    Construction-injected with the LLM client + Redis client. Cache-aside
    pattern: read Redis first, fall through to Gemini Flash on miss.
    """

    def __init__(self, llm: LLMClient, redis: Redis[str]) -> None:
        self._summarizer = Summarizer(llm)
        self._redis = redis

    @property
    def name(self) -> ToolName:
        return "thread_context"

    async def run(self, context: ToolContext) -> ToolResult:
        t0 = time.monotonic()

        comments = context.thread_excerpts
        if len(comments) < _MIN_COMMENTS_FOR_SUMMARY:
            return ToolResult(
                tool=self.name,
                status="skipped",
                summary=(
                    f"thread too short for summary ({len(comments)} "
                    f"< {_MIN_COMMENTS_FOR_SUMMARY} comments)"
                ),
                latency_ms=_elapsed_ms(t0),
                detail={
                    "reason": "below_min_comments",
                    "comment_count": len(comments),
                    "threshold": _MIN_COMMENTS_FOR_SUMMARY,
                },
            )

        thread_id = context.thread_id
        cached: dict[str, object] | None = None
        from_cache = False
        if thread_id:
            # Cache lookup is best-effort; don't fail the tool on Redis issues.
            with contextlib.suppress(Exception):
                cached = await get_thread_summary(self._redis, thread_id=thread_id)
        if cached is not None:
            try:
                summary = ThreadSummary.model_validate(cached)
                from_cache = True
            except Exception:
                cached = None

        if cached is None:
            try:
                result = await self._summarizer.summarize(
                    post_body=context.target_body,
                    comments=comments,
                    correlation_id=context.correlation_id,
                )
            except Exception as exc:
                return ToolResult(
                    tool=self.name,
                    status="failure",
                    summary=f"summarizer call failed: {type(exc).__name__}",
                    latency_ms=_elapsed_ms(t0),
                    error=str(exc),
                )
            summary = result.summary
            if thread_id:
                # Cache write failure is non-fatal — we still return the summary.
                with contextlib.suppress(Exception):
                    await set_thread_summary(
                        self._redis,
                        thread_id=thread_id,
                        summary=summary.model_dump(),
                    )

        latency = _elapsed_ms(t0)
        signal_high = summary.escalation_turn is not None
        return ToolResult(
            tool=self.name,
            status="success",
            summary=_format_summary(summary, from_cache=from_cache),
            latency_ms=latency,
            detail={
                "arc": summary.arc,
                "escalation_turn": summary.escalation_turn,
                "instigator_candidates": list(summary.instigator_candidates),
                "off_topic": summary.off_topic,
                "total_turns": summary.total_turns,
                "from_cache": from_cache,
                "signal": "high" if signal_high else "neutral",
            },
        )


def _format_summary(summary: ThreadSummary, *, from_cache: bool) -> str:
    """One-line evidence summary for the Verdict Card."""
    parts: list[str] = []
    if summary.escalation_turn is not None:
        parts.append(f"escalation at turn {summary.escalation_turn}")
    if summary.off_topic:
        parts.append("off-topic drift")
    if not parts:
        parts.append("arc captured")
    arc_preview = summary.arc[:_SUMMARY_PREVIEW_CHARS]
    label = "cached" if from_cache else "fresh"
    text = f"thread: {', '.join(parts)} — {arc_preview} ({label})"
    if len(text) > 200:
        text = text[:197] + "..."
    return text


def _elapsed_ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


__all__ = ["ThreadContextTool"]
