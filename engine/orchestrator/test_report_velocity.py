"""report_velocity tool tests — pure unit tests, Redis is mocked."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from orchestrator.report_velocity import (
    _DEFAULT_BASELINE_MEAN,
    _DEFAULT_BASELINE_STDDEV,
    _WINDOW_1M,
    _WINDOW_5M,
    _WINDOW_15M,
    ReportVelocityTool,
)
from orchestrator.tools import Tool, ToolContext


def _ctx(**overrides: object) -> ToolContext:
    base: dict[str, object] = {
        "subreddit_id": "t5_abc",
        "correlation_id": "inv-1",
        "target_kind": "comment",
        "target_id": "t1_xyz",
    }
    base.update(overrides)
    return ToolContext(**base)  # type: ignore[arg-type]


def _mock_redis() -> AsyncMock:
    return AsyncMock()


def _make_tool(redis: AsyncMock | None = None) -> ReportVelocityTool:
    return ReportVelocityTool(redis=redis or _mock_redis())


# === Protocol compliance =================================================


def test_satisfies_tool_protocol() -> None:
    assert isinstance(_make_tool(), Tool)


def test_name_is_report_velocity() -> None:
    assert _make_tool().name == "report_velocity"


# === Happy path ==========================================================


@pytest.mark.asyncio
async def test_returns_success_with_counts_and_zscore() -> None:
    with patch(
        "orchestrator.report_velocity.velocity_count",
        new_callable=AsyncMock,
        side_effect=[2, 5, 8],  # 1m, 5m, 15m
    ):
        result = await _make_tool().run(_ctx())

    assert result.status == "success"
    assert result.tool == "report_velocity"
    assert result.detail["reports_1m"] == 2
    assert result.detail["reports_5m"] == 5
    assert result.detail["reports_15m"] == 8
    assert result.detail["z_score"] == pytest.approx(
        (5 - _DEFAULT_BASELINE_MEAN) / _DEFAULT_BASELINE_STDDEV
    )
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_summary_contains_count_and_zscore() -> None:
    with patch(
        "orchestrator.report_velocity.velocity_count",
        new_callable=AsyncMock,
        side_effect=[0, 3, 7],
    ):
        result = await _make_tool().run(_ctx())

    assert "3 reports in 5 min" in result.summary
    assert "z=" in result.summary


@pytest.mark.asyncio
async def test_zero_reports_returns_negative_zscore() -> None:
    with patch(
        "orchestrator.report_velocity.velocity_count",
        new_callable=AsyncMock,
        side_effect=[0, 0, 0],
    ):
        result = await _make_tool().run(_ctx())

    assert result.status == "success"
    assert result.detail["reports_5m"] == 0
    assert result.detail["z_score"] < 0


@pytest.mark.asyncio
async def test_passes_correct_window_seconds() -> None:
    mock_vc = AsyncMock(side_effect=[1, 2, 3])
    with patch("orchestrator.report_velocity.velocity_count", mock_vc):
        tool = _make_tool()
        await tool.run(_ctx(subreddit_id="t5_sub", target_id="t1_tgt"))

    calls = mock_vc.call_args_list
    assert len(calls) == 3
    assert calls[0].kwargs["window_seconds"] == _WINDOW_1M
    assert calls[1].kwargs["window_seconds"] == _WINDOW_5M
    assert calls[2].kwargs["window_seconds"] == _WINDOW_15M
    # All calls scoped to the same subreddit + target
    for c in calls:
        assert c.kwargs["subreddit_id"] == "t5_sub"
        assert c.kwargs["target_id"] == "t1_tgt"


# === Error handling ======================================================


@pytest.mark.asyncio
async def test_redis_failure_returns_failure_status() -> None:
    with patch(
        "orchestrator.report_velocity.velocity_count",
        new_callable=AsyncMock,
        side_effect=ConnectionError("redis down"),
    ):
        result = await _make_tool().run(_ctx())

    assert result.status == "failure"
    assert result.tool == "report_velocity"
    assert "redis down" in (result.error or "")
    assert result.latency_ms >= 0


# === Detail schema =======================================================


@pytest.mark.asyncio
async def test_detail_contains_all_expected_keys() -> None:
    with patch(
        "orchestrator.report_velocity.velocity_count",
        new_callable=AsyncMock,
        side_effect=[1, 1, 1],
    ):
        result = await _make_tool().run(_ctx())

    expected_keys = {
        "reports_1m",
        "reports_5m",
        "reports_15m",
        "baseline_mean",
        "baseline_stddev",
        "z_score",
    }
    assert set(result.detail.keys()) == expected_keys
