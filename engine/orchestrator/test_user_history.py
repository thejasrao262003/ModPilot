"""user_history tool tests — unit tests with mocked DB, DB integration tests.

Pure-function tests run always. DB integration tests skip when SKIP_DB_TESTS=true.
"""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

from orchestrator.tools import ToolContext
from orchestrator.user_history import UserHistoryTool, _signal_strength

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


def _mock_user_memory(**overrides: object) -> object:
    """Minimal object mimicking a UserMemoryRow."""
    from datetime import UTC, datetime
    from types import SimpleNamespace

    defaults: dict[str, object] = {
        "risk_tier": "neutral",
        "prior_violations": 1,
        "prior_approvals": 3,
        "last_seen_at": datetime(2026, 5, 10, 12, 0, 0, tzinfo=UTC),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# === Pure function tests ==================================================


class TestSignalStrength:
    def test_watched_is_high(self) -> None:
        assert _signal_strength("watched", 5) == "high"

    def test_trusted_is_high(self) -> None:
        assert _signal_strength("trusted", 0) == "high"

    def test_high_violations_is_high(self) -> None:
        assert _signal_strength("neutral", 3) == "high"

    def test_neutral_low_violations_is_normal(self) -> None:
        assert _signal_strength("neutral", 1) == "normal"

    def test_new_is_normal(self) -> None:
        assert _signal_strength("new", 0) == "normal"


# === Unit tests (mocked DB) ===============================================


class TestUserHistoryUnit:
    @pytest.mark.asyncio
    async def test_skipped_without_author(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        result = await tool.run(_context(target_author_id=""))
        assert result.status == "skipped"
        assert result.tool == "user_history"

    @pytest.mark.asyncio
    async def test_no_history(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        with patch("orchestrator.user_history.get_user_memory", return_value=None), patch(
            "orchestrator.user_history.with_session"
        ) as mock_ws:
            mock_ws.return_value = _async_ctx(AsyncMock())
            result = await tool.run(_context())
        assert result.status == "success"
        assert result.detail["has_history"] is False
        assert result.detail["risk_tier"] == "new"

    @pytest.mark.asyncio
    async def test_with_history(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        mem = _mock_user_memory(risk_tier="watched", prior_violations=5, prior_approvals=0)
        with patch("orchestrator.user_history.get_user_memory", return_value=mem), patch(
            "orchestrator.user_history.with_session"
        ) as mock_ws:
            mock_ws.return_value = _async_ctx(AsyncMock())
            result = await tool.run(_context())
        assert result.status == "success"
        assert result.detail["has_history"] is True
        assert result.detail["risk_tier"] == "watched"
        assert result.detail["prior_violations"] == 5
        assert result.detail["signal"] == "high"
        assert "watched" in result.summary

    @pytest.mark.asyncio
    async def test_trusted_user(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        mem = _mock_user_memory(risk_tier="trusted", prior_violations=0, prior_approvals=10)
        with patch("orchestrator.user_history.get_user_memory", return_value=mem), patch(
            "orchestrator.user_history.with_session"
        ) as mock_ws:
            mock_ws.return_value = _async_ctx(AsyncMock())
            result = await tool.run(_context())
        assert result.detail["risk_tier"] == "trusted"
        assert result.detail["signal"] == "high"

    @pytest.mark.asyncio
    async def test_failure_on_exception(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        with patch.object(tool, "_lookup", side_effect=RuntimeError("db down")):
            result = await tool.run(_context())
        assert result.status == "failure"
        assert result.error == "db down"

    @pytest.mark.asyncio
    async def test_latency_populated(self) -> None:
        tool = UserHistoryTool(AsyncMock())
        with patch("orchestrator.user_history.get_user_memory", return_value=None), patch(
            "orchestrator.user_history.with_session"
        ) as mock_ws:
            mock_ws.return_value = _async_ctx(AsyncMock())
            result = await tool.run(_context())
        assert result.latency_ms >= 0


class _async_ctx:
    """Minimal async context manager returning a mock session."""

    def __init__(self, session: object) -> None:
        self._session = session

    async def __aenter__(self) -> object:
        return self._session

    async def __aexit__(self, *args: object) -> None:
        pass


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
async def test_first_time_user(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    tool = UserHistoryTool(sessions)
    result = await tool.run(_context(subreddit_id=_sub_id()))
    assert result.status == "success"
    assert result.detail["has_history"] is False


@db_tests
@pytest.mark.asyncio
async def test_returns_user_memory(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from store.postgres import ensure_subreddit_profile, upsert_user_memory, with_session

    sub = _sub_id()
    author = "t2_known"

    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        await upsert_user_memory(
            s,
            subreddit_id=sub,
            user_id=author,
            risk_tier="watched",
            prior_violations_delta=3,
        )

    tool = UserHistoryTool(sessions)
    result = await tool.run(
        _context(subreddit_id=sub, target_author_id=author)
    )
    assert result.status == "success"
    assert result.detail["has_history"] is True
    assert result.detail["risk_tier"] == "watched"
    assert result.detail["prior_violations"] == 3
    assert result.detail["signal"] == "high"


@db_tests
@pytest.mark.asyncio
async def test_subreddit_isolation(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from store.postgres import ensure_subreddit_profile, upsert_user_memory, with_session

    sub_a = _sub_id()
    sub_b = _sub_id()
    author = "t2_cross"

    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub_a, name="a")
        await ensure_subreddit_profile(s, subreddit_id=sub_b, name="b")
        await upsert_user_memory(
            s,
            subreddit_id=sub_a,
            user_id=author,
            prior_violations_delta=5,
        )

    tool = UserHistoryTool(sessions)
    result = await tool.run(
        _context(subreddit_id=sub_b, target_author_id=author)
    )
    assert result.status == "success"
    assert result.detail["has_history"] is False
