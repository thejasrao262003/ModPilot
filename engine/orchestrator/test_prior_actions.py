"""prior_actions tool tests — unit tests with mocked DB, DB integration tests.

Pure-function tests run always. DB integration tests skip when SKIP_DB_TESTS=true.
"""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

from orchestrator.prior_actions import PriorActionsTool
from orchestrator.tools import ToolContext

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
else:
    from sqlalchemy.ext.asyncio import AsyncEngine  # noqa: TC002


def _context(**overrides: object) -> ToolContext:
    base: dict[str, object] = {
        "subreddit_id": "t5_test",
        "correlation_id": "corr-1",
        "target_kind": "comment",
        "target_id": "t1_abc",
        "target_author_id": "t2_author",
    }
    base.update(overrides)
    return ToolContext(**base)  # type: ignore[arg-type]


def _mock_investigation(**overrides: object) -> object:
    """Minimal object mimicking an Investigation ORM row."""
    from datetime import UTC, datetime
    from types import SimpleNamespace

    defaults: dict[str, object] = {
        "recommendation": "REMOVE",
        "risk_tier": "HIGH",
        "calibrated_confidence": 0.85,
        "target_kind": "comment",
        "target_id": "t1_old",
        "completed_at": datetime(2026, 5, 10, 12, 0, 0, tzinfo=UTC),
        "degraded": False,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# === Unit tests (mocked DB) ===============================================


class TestPriorActionsUnit:
    """Tests with patched DB — validates logic branches, not SQL."""

    @pytest.mark.asyncio
    async def test_skipped_without_author(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        result = await tool.run(_context(target_author_id=""))
        assert result.status == "skipped"
        assert result.tool == "prior_actions"

    @pytest.mark.asyncio
    async def test_no_prior_actions(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        with patch.object(tool, "_fetch", return_value=[]):
            result = await tool.run(_context())
        assert result.status == "success"
        assert result.detail["count"] == 0
        assert result.detail["prior_actions"] == []

    @pytest.mark.asyncio
    async def test_single_removal(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        with patch.object(tool, "_fetch", return_value=[_mock_investigation()]):
            result = await tool.run(_context())
        assert result.status == "success"
        assert result.detail["count"] == 1
        assert result.detail["removals"] == 1
        assert result.detail["signal"] == "normal"  # <2 removals
        assert "1 prior action(s)" in result.summary

    @pytest.mark.asyncio
    async def test_high_signal_on_multiple_removals(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        actions = [_mock_investigation(), _mock_investigation()]
        with patch.object(tool, "_fetch", return_value=actions):
            result = await tool.run(_context())
        assert result.detail["signal"] == "high"
        assert result.detail["removals"] == 2

    @pytest.mark.asyncio
    async def test_mixed_actions(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        actions = [
            _mock_investigation(recommendation="REMOVE"),
            _mock_investigation(recommendation="APPROVE", risk_tier="LOW"),
            _mock_investigation(recommendation="ESCALATE", risk_tier="MEDIUM"),
        ]
        with patch.object(tool, "_fetch", return_value=actions):
            result = await tool.run(_context())
        assert result.detail["count"] == 3
        assert result.detail["removals"] == 1
        assert result.detail["signal"] == "normal"

    @pytest.mark.asyncio
    async def test_detail_entries_shape(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        with patch.object(tool, "_fetch", return_value=[_mock_investigation()]):
            result = await tool.run(_context())
        actions = result.detail["prior_actions"]
        assert isinstance(actions, list)
        entry = actions[0]
        assert isinstance(entry, dict)
        assert entry["recommendation"] == "REMOVE"
        assert entry["risk_tier"] == "HIGH"
        assert entry["confidence"] == 0.85
        assert entry["target_kind"] == "comment"
        assert entry["degraded"] is False
        assert entry["completed_at"] is not None

    @pytest.mark.asyncio
    async def test_failure_on_exception(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        with patch.object(tool, "_fetch", side_effect=RuntimeError("db down")):
            result = await tool.run(_context())
        assert result.status == "failure"
        assert result.error == "db down"

    @pytest.mark.asyncio
    async def test_latency_populated(self) -> None:
        tool = PriorActionsTool(AsyncMock())
        with patch.object(tool, "_fetch", return_value=[]):
            result = await tool.run(_context())
        assert result.latency_ms >= 0


# === DB integration tests =================================================

db_tests = pytest.mark.skipif(
    os.getenv("SKIP_DB_TESTS", "false").lower() in ("true", "1", "yes"),
    reason="SKIP_DB_TESTS=true (CI without docker services)",
)


def _sub_id() -> str:
    return f"t5_{uuid.uuid4().hex[:10]}"


@pytest_asyncio.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    from api.config import get_settings
    from store.connections import close_postgres, open_postgres

    get_settings.cache_clear()
    eng = await open_postgres(get_settings())
    try:
        yield eng
    finally:
        await close_postgres(eng)


@pytest.fixture
def sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    from store.postgres import make_sessionmaker

    return make_sessionmaker(engine)


@db_tests
@pytest.mark.asyncio
async def test_no_results_for_unknown_user(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    tool = PriorActionsTool(sessions)
    result = await tool.run(_context(subreddit_id=_sub_id()))
    assert result.status == "success"
    assert result.detail["count"] == 0


@db_tests
@pytest.mark.asyncio
async def test_returns_completed_investigations(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from store.postgres import (
        ensure_subreddit_profile,
        finalize_investigation,
        start_investigation,
        with_session,
    )
    from store.types import FinalizeInvestigationInput, StartInvestigationInput

    sub = _sub_id()
    author = "t2_repeat"

    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")

        # Create and finalize two investigations on the same author.
        for i in range(2):
            corr = f"inv-pa-{uuid.uuid4().hex[:8]}"
            await start_investigation(
                s,
                input_=StartInvestigationInput(
                    correlation_id=corr,
                    subreddit_id=sub,
                    target_kind="comment",
                    target_id=f"t1_c{i}",
                    target_author_id=author,
                    tier="FAST",
                ),
            )
            await finalize_investigation(
                s,
                correlation_id=corr,
                subreddit_id=sub,
                verdict=FinalizeInvestigationInput(
                    risk_tier="HIGH",
                    recommendation="REMOVE",
                    calibrated_confidence=0.9,
                    rationale="test rationale",
                    confidence_breakdown={"llm_self_report": 0.9},
                    model_reasoner="test",
                    model_summarizer="test",
                    cost_usd=0.0,
                    latency_ms=100,
                ),
            )

    tool = PriorActionsTool(sessions)
    result = await tool.run(
        _context(subreddit_id=sub, target_author_id=author)
    )
    assert result.status == "success"
    assert result.detail["count"] == 2
    assert result.detail["removals"] == 2
    assert result.detail["signal"] == "high"


@db_tests
@pytest.mark.asyncio
async def test_respects_subreddit_isolation(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from store.postgres import (
        ensure_subreddit_profile,
        finalize_investigation,
        start_investigation,
        with_session,
    )
    from store.types import FinalizeInvestigationInput, StartInvestigationInput

    sub_a = _sub_id()
    sub_b = _sub_id()
    author = "t2_cross"

    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub_a, name="a")
        await ensure_subreddit_profile(s, subreddit_id=sub_b, name="b")

        # Investigation in sub_a only.
        corr = f"inv-iso-{uuid.uuid4().hex[:8]}"
        await start_investigation(
            s,
            input_=StartInvestigationInput(
                correlation_id=corr,
                subreddit_id=sub_a,
                target_kind="comment",
                target_id="t1_x",
                target_author_id=author,
                tier="FAST",
            ),
        )
        await finalize_investigation(
            s,
            correlation_id=corr,
            subreddit_id=sub_a,
            verdict=FinalizeInvestigationInput(
                risk_tier="HIGH",
                recommendation="REMOVE",
                calibrated_confidence=0.9,
                rationale="isolation test",
                confidence_breakdown={"llm_self_report": 0.9},
                model_reasoner="test",
                model_summarizer="test",
                cost_usd=0.0,
                latency_ms=50,
            ),
        )

    # sub_b should see nothing.
    tool = PriorActionsTool(sessions)
    result = await tool.run(
        _context(subreddit_id=sub_b, target_author_id=author)
    )
    assert result.status == "success"
    assert result.detail["count"] == 0
