"""Tests for the thread_context tool — cache-aside, skip-on-short, Flash call."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock

import pytest

from llm.client import LLMResponse, Role
from llm.prompts.summarizer import ThreadSummary
from orchestrator.thread_context import ThreadContextTool
from orchestrator.tools import ToolContext

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from llm.client import LLMClient


# === Helpers ============================================================


def _ctx(*, thread_excerpts: tuple[str, ...] = (), thread_id: str = "t3_x") -> ToolContext:
    return ToolContext(
        subreddit_id="t5_test",
        correlation_id="inv-test-thread",
        target_kind="post",
        target_id="t3_x",
        target_body="hi all, discussing X today",
        thread_id=thread_id,
        thread_excerpts=thread_excerpts,
    )


def _summary_payload(
    *,
    arc: str = "civil debate, then heated turn at 8",
    escalation_turn: int | None = 8,
    instigators: tuple[str, ...] = (),
    off_topic: bool = False,
    total_turns: int = 12,
) -> ThreadSummary:
    return ThreadSummary(
        arc=arc,
        escalation_turn=escalation_turn,
        instigator_candidates=list(instigators),
        off_topic=off_topic,
        total_turns=total_turns,
    )


def _llm_response(summary: ThreadSummary) -> LLMResponse:
    return LLMResponse(
        raw_text=summary.model_dump_json(),
        input_tokens=120,
        output_tokens=60,
        model="gemini-2.5-flash",
        latency_ms=420,
        cost_usd=0.000018,
        parsed=summary,
    )


def _make_llm(summary: ThreadSummary) -> LLMClient:
    fake = AsyncMock()
    fake.complete = AsyncMock(return_value=_llm_response(summary))
    return cast("LLMClient", fake)


def _make_redis(cached: object | None = None) -> Redis[str]:
    """Mock Redis with `get` returning a JSON blob (or None) and `set` accepting anything."""
    import json

    redis = AsyncMock()
    if cached is None:
        redis.get = AsyncMock(return_value=None)
    else:
        redis.get = AsyncMock(return_value=json.dumps(cached))
    redis.set = AsyncMock()
    return cast("Redis[str]", redis)


def _ten_comments() -> tuple[str, ...]:
    return tuple(f"comment {i} body" for i in range(12))


# === Skip behaviour =====================================================


@pytest.mark.asyncio
async def test_short_thread_skipped() -> None:
    """Threads with <10 comments are skipped — no LLM call, no cache hit."""
    summary = _summary_payload()
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=tuple(f"c{i}" for i in range(5))))

    assert result.status == "skipped"
    assert "thread too short" in result.summary
    assert result.detail["reason"] == "below_min_comments"
    assert result.detail["comment_count"] == 5
    llm.complete.assert_not_called()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_zero_comments_skipped() -> None:
    """No excerpts at all — boundary case."""
    tool = ThreadContextTool(_make_llm(_summary_payload()), _make_redis())
    result = await tool.run(_ctx(thread_excerpts=()))
    assert result.status == "skipped"
    assert result.detail["comment_count"] == 0


# === Cache hit ==========================================================


@pytest.mark.asyncio
async def test_cache_hit_skips_llm_call() -> None:
    """If Redis has the summary, we return it without hitting Gemini."""
    cached = _summary_payload(arc="cached debate", escalation_turn=4).model_dump()
    llm = _make_llm(_summary_payload())  # won't be called
    redis = _make_redis(cached=cached)
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "success"
    assert result.detail["from_cache"] is True
    assert result.detail["escalation_turn"] == 4
    assert "cached" in result.summary
    llm.complete.assert_not_called()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_corrupt_cache_falls_through_to_llm() -> None:
    """If the cached blob doesn't parse, we silently re-summarize."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value='{"bogus": true}')
    redis.set = AsyncMock()
    summary = _summary_payload()
    llm = _make_llm(summary)
    tool = ThreadContextTool(llm, cast("Redis[str]", redis))

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "success"
    assert result.detail["from_cache"] is False
    llm.complete.assert_called_once()  # type: ignore[attr-defined]


# === Cache miss → LLM call ==============================================


@pytest.mark.asyncio
async def test_cache_miss_calls_llm_and_caches() -> None:
    summary = _summary_payload(escalation_turn=7, total_turns=11)
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "success"
    assert result.detail["from_cache"] is False
    assert result.detail["escalation_turn"] == 7
    assert result.detail["signal"] == "high"
    # Cached the summary back to Redis.
    redis.set.assert_awaited_once()  # type: ignore[attr-defined]
    # The LLM call used the SUMMARIZER role.
    call = llm.complete.call_args  # type: ignore[attr-defined]
    assert call is not None
    assert call.kwargs["role"] is Role.SUMMARIZER


@pytest.mark.asyncio
async def test_no_thread_id_skips_cache_lookup_but_runs_llm() -> None:
    """Without thread_id, we can't cache — but the LLM call still happens."""
    summary = _summary_payload(escalation_turn=None)  # no escalation
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments(), thread_id=""))

    assert result.status == "success"
    assert result.detail["from_cache"] is False
    assert result.detail["signal"] == "neutral"  # no escalation_turn
    redis.get.assert_not_called()  # type: ignore[attr-defined]
    redis.set.assert_not_called()  # type: ignore[attr-defined]


# === LLM failure =======================================================


@pytest.mark.asyncio
async def test_llm_failure_returns_failure_status() -> None:
    """LLM exceptions are captured, not propagated."""
    llm = AsyncMock()
    llm.complete = AsyncMock(side_effect=RuntimeError("gemini timeout"))
    redis = _make_redis()
    tool = ThreadContextTool(cast("LLMClient", llm), redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "failure"
    assert result.error == "gemini timeout"
    assert "RuntimeError" in result.summary
    # We did NOT cache anything on failure.
    redis.set.assert_not_called()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_cache_set_failure_does_not_break_tool() -> None:
    """If Redis.set fails after a successful LLM call, we still return success."""
    summary = _summary_payload()
    llm = _make_llm(summary)
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(side_effect=ConnectionError("redis down"))
    tool = ThreadContextTool(llm, cast("Redis[str]", redis))

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "success"
    assert result.detail["from_cache"] is False


@pytest.mark.asyncio
async def test_cache_get_failure_falls_through() -> None:
    """If Redis.get raises, we silently summarize fresh."""
    summary = _summary_payload()
    llm = _make_llm(summary)
    redis = AsyncMock()
    redis.get = AsyncMock(side_effect=ConnectionError("redis flap"))
    redis.set = AsyncMock()
    tool = ThreadContextTool(llm, cast("Redis[str]", redis))

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))

    assert result.status == "success"
    assert result.detail["from_cache"] is False
    llm.complete.assert_called_once()  # type: ignore[attr-defined]


# === Signal + summary formatting =======================================


@pytest.mark.asyncio
async def test_no_escalation_emits_neutral_signal() -> None:
    summary = _summary_payload(arc="purely civil debate", escalation_turn=None, total_turns=12)
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))
    assert result.detail["signal"] == "neutral"
    assert "arc captured" in result.summary or "civil" in result.summary


@pytest.mark.asyncio
async def test_off_topic_surfaces_in_summary() -> None:
    summary = _summary_payload(
        arc="drifts to unrelated topic",
        escalation_turn=None,
        off_topic=True,
    )
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))
    assert "off-topic" in result.summary
    assert result.detail["off_topic"] is True


@pytest.mark.asyncio
async def test_summary_truncated_to_200_chars() -> None:
    """The Verdict Card's evidence row caps at 200 chars.

    arc itself is Pydantic-capped at 240 chars; we just need the full
    formatted line (including prefix + suffix) to exceed 200 to exercise
    the truncation branch.
    """
    long_arc = "x" * 240  # max allowed by ThreadSummary schema
    summary = _summary_payload(arc=long_arc, total_turns=12)
    llm = _make_llm(summary)
    redis = _make_redis()
    tool = ThreadContextTool(llm, redis)

    result = await tool.run(_ctx(thread_excerpts=_ten_comments()))
    assert len(result.summary) <= 200
    assert result.summary.endswith("...")


# === Name / Protocol ====================================================


def test_tool_name_is_canonical() -> None:
    tool = ThreadContextTool(_make_llm(_summary_payload()), _make_redis())
    assert tool.name == "thread_context"
