"""Feedback ingest tests — risk tier rules, deltas, full process_feedback flow.

Pure-function tests run always. DB integration tests skip when SKIP_DB_TESTS=true.
"""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
else:
    from sqlalchemy.ext.asyncio import AsyncEngine  # noqa: TC002

from memory.ingest import IngestResult, _compute_deltas, compute_risk_tier
from store.types import FeedbackInput

# === Pure-function tests (no DB) ==========================================


class TestComputeRiskTier:
    def test_new_when_no_history(self) -> None:
        assert compute_risk_tier(prior_violations=0, prior_approvals=0) == "new"

    def test_watched_at_three_violations(self) -> None:
        assert compute_risk_tier(prior_violations=3, prior_approvals=0) == "watched"

    def test_watched_at_many_violations(self) -> None:
        assert compute_risk_tier(prior_violations=10, prior_approvals=5) == "watched"

    def test_trusted_at_five_approvals_no_violations(self) -> None:
        assert compute_risk_tier(prior_violations=0, prior_approvals=5) == "trusted"

    def test_trusted_at_many_approvals(self) -> None:
        assert compute_risk_tier(prior_violations=0, prior_approvals=20) == "trusted"

    def test_neutral_with_some_approvals(self) -> None:
        assert compute_risk_tier(prior_violations=0, prior_approvals=3) == "neutral"

    def test_neutral_with_mixed(self) -> None:
        assert compute_risk_tier(prior_violations=1, prior_approvals=10) == "neutral"

    def test_neutral_with_few_violations(self) -> None:
        assert compute_risk_tier(prior_violations=2, prior_approvals=0) == "neutral"

    def test_watched_overrides_approvals(self) -> None:
        assert compute_risk_tier(prior_violations=3, prior_approvals=100) == "watched"


class TestComputeDeltas:
    def test_remove_increments_violations(self) -> None:
        assert _compute_deltas("REMOVE") == (1, 0)

    def test_approve_increments_approvals(self) -> None:
        assert _compute_deltas("APPROVE") == (0, 1)

    def test_escalate_no_change(self) -> None:
        assert _compute_deltas("ESCALATE") == (0, 0)

    def test_lock_no_change(self) -> None:
        assert _compute_deltas("LOCK") == (0, 0)


# === DB integration tests =================================================

db_tests = pytest.mark.skipif(
    os.getenv("SKIP_DB_TESTS", "false").lower() in ("true", "1", "yes"),
    reason="SKIP_DB_TESTS=true (CI without docker services)",
)


def _sub_id() -> str:
    return f"t5_{uuid.uuid4().hex[:10]}"


def _feedback(sub_id: str, **overrides: object) -> FeedbackInput:
    base: dict[str, object] = {
        "correlation_id": f"inv-fb-{uuid.uuid4().hex[:8]}",
        "subreddit_id": sub_id,
        "target_id": "t1_abc",
        "mod_action": "REMOVE",
        "raw_action": "spamlink",
        "moderator_id": "t2_mod",
        "moderator_name": "mod_user",
        "source": "verdict_card",
        "aligned": True,
    }
    base.update(overrides)
    return FeedbackInput.model_validate(base)


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
async def test_process_feedback_happy_path(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        result = await process_feedback(
            s,
            feedback=_feedback(sub),
            target_author_id="t2_author",
            post_id="t3_post1",
        )
    assert isinstance(result, IngestResult)
    assert result.cold_start_count == 1


@db_tests
@pytest.mark.asyncio
async def test_remove_increments_violations(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_user_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        await process_feedback(
            s, feedback=_feedback(sub), target_author_id="t2_author"
        )
        await process_feedback(
            s, feedback=_feedback(sub), target_author_id="t2_author"
        )
        mem = await get_user_memory(s, subreddit_id=sub, user_id="t2_author")
    assert mem is not None
    assert mem.prior_violations == 2
    assert mem.prior_approvals == 0


@db_tests
@pytest.mark.asyncio
async def test_approve_increments_approvals(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_user_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        await process_feedback(
            s,
            feedback=_feedback(sub, mod_action="APPROVE"),
            target_author_id="t2_author",
        )
        mem = await get_user_memory(s, subreddit_id=sub, user_id="t2_author")
    assert mem is not None
    assert mem.prior_approvals == 1
    assert mem.prior_violations == 0


@db_tests
@pytest.mark.asyncio
async def test_risk_tier_transitions_to_watched(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_user_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        for _ in range(3):
            await process_feedback(
                s, feedback=_feedback(sub), target_author_id="t2_bad"
            )
        mem = await get_user_memory(s, subreddit_id=sub, user_id="t2_bad")
    assert mem is not None
    assert mem.risk_tier == "watched"
    assert mem.prior_violations == 3


@db_tests
@pytest.mark.asyncio
async def test_risk_tier_transitions_to_trusted(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_user_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        for _ in range(5):
            await process_feedback(
                s,
                feedback=_feedback(sub, mod_action="APPROVE"),
                target_author_id="t2_good",
            )
        mem = await get_user_memory(s, subreddit_id=sub, user_id="t2_good")
    assert mem is not None
    assert mem.risk_tier == "trusted"


@db_tests
@pytest.mark.asyncio
async def test_cold_start_counter_increments(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        r1 = await process_feedback(s, feedback=_feedback(sub))
        r2 = await process_feedback(s, feedback=_feedback(sub))
    assert r1.cold_start_count == 1
    assert r2.cold_start_count == 2


@db_tests
@pytest.mark.asyncio
async def test_thread_memory_updated(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_thread_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        await process_feedback(
            s, feedback=_feedback(sub), post_id="t3_thread1"
        )
        tm = await get_thread_memory(s, subreddit_id=sub, post_id="t3_thread1")
    assert tm is not None
    assert len(tm.mod_actions_taken) == 1
    assert tm.mod_actions_taken[0]["action"] == "REMOVE"


@db_tests
@pytest.mark.asyncio
async def test_no_user_update_without_author(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        result = await process_feedback(s, feedback=_feedback(sub))
    assert isinstance(result, IngestResult)


@db_tests
@pytest.mark.asyncio
async def test_no_thread_update_without_post_id(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    from memory.ingest import process_feedback
    from store.postgres import ensure_subreddit_profile, get_thread_memory, with_session

    sub = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="test")
        await process_feedback(s, feedback=_feedback(sub), post_id="")
        tm = await get_thread_memory(s, subreddit_id=sub, post_id="t3_nope")
    assert tm is None
