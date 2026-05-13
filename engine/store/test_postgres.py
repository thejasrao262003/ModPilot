"""Round-trip tests for the Postgres repository layer.

Auto-skips when SKIP_DB_TESTS=true (CI runs the unit suite without docker).
Locally, `make services-up` + `make test` exercises these against pg:16.
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
    from sqlalchemy.ext.asyncio import AsyncEngine  # noqa: TC002 — runtime fixture param

from api.config import get_settings
from store.connections import close_postgres, open_postgres
from store.postgres import (
    append_audit,
    append_evidence,
    ensure_subreddit_profile,
    finalize_investigation,
    get_investigation_by_correlation,
    get_subreddit_profile,
    get_user_memory,
    make_sessionmaker,
    record_feedback,
    start_investigation,
    upsert_user_memory,
    with_session,
)
from store.types import (
    EvidenceRowInput,
    FeedbackInput,
    FinalizeInvestigationInput,
    StartInvestigationInput,
)

pytestmark = pytest.mark.skipif(
    os.getenv("SKIP_DB_TESTS", "false").lower() in ("true", "1", "yes"),
    reason="SKIP_DB_TESTS=true (CI without docker services)",
)


@pytest_asyncio.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    get_settings.cache_clear()
    eng = await open_postgres(get_settings())
    try:
        yield eng
    finally:
        await close_postgres(eng)


@pytest.fixture
def sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return make_sessionmaker(engine)


def _sub_id() -> str:
    """Unique per-test subreddit_id so tests don't trample each other's data."""
    return f"t5_{uuid.uuid4().hex[:10]}"


@pytest.mark.asyncio
async def test_ensure_subreddit_profile_is_idempotent(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub = _sub_id()
    async with with_session(sessions) as s:
        a = await ensure_subreddit_profile(s, subreddit_id=sub, name="test-sub")
    async with with_session(sessions) as s:
        b = await ensure_subreddit_profile(s, subreddit_id=sub, name="test-sub-renamed")
    assert a.subreddit_id == b.subreddit_id == sub
    # on_conflict_do_nothing → name should not have updated
    assert b.name == "test-sub"


@pytest.mark.asyncio
async def test_user_memory_upsert_counters(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub, user = _sub_id(), "t2_testuser"
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="x")
        first = await upsert_user_memory(s, subreddit_id=sub, user_id=user)
    assert first.prior_violations == 0
    assert first.risk_tier == "new"

    async with with_session(sessions) as s:
        bumped = await upsert_user_memory(
            s,
            subreddit_id=sub,
            user_id=user,
            risk_tier="watched",
            prior_violations_delta=2,
            prior_approvals_delta=1,
        )
    assert bumped.prior_violations == 2
    assert bumped.prior_approvals == 1
    assert bumped.risk_tier == "watched"

    async with with_session(sessions) as s:
        read = await get_user_memory(s, subreddit_id=sub, user_id=user)
    assert read is not None
    assert read.prior_violations == 2


@pytest.mark.asyncio
async def test_investigation_lifecycle(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub = _sub_id()
    corr = f"inv-{uuid.uuid4().hex[:8]}"

    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="lifecycle")
        inv = await start_investigation(
            s,
            input_=StartInvestigationInput(
                correlation_id=corr,
                subreddit_id=sub,
                target_kind="post",
                target_id="t3_x",
                target_body="hi all",
                target_author_id="t2_a",
                tier="DEEP",
            ),
        )
        for ev_id, tool, summary in [
            ("ev-1", "policy_match", "matched rule 2"),
            ("ev-2", "user_history", "3 prior removals"),
        ]:
            await append_evidence(
                s,
                investigation=inv,
                subreddit_id=sub,
                evidence=EvidenceRowInput(evidence_id=ev_id, tool=tool, summary=summary),
            )
        await finalize_investigation(
            s,
            correlation_id=corr,
            subreddit_id=sub,
            verdict=FinalizeInvestigationInput(
                risk_tier="HIGH",
                recommendation="REMOVE",
                calibrated_confidence=0.92,
                rationale="author has prior removals [ev-2]; matches [ev-1]",
                confidence_breakdown={
                    "llm_self_report": 0.95,
                    "evidence_convergence": 0.88,
                    "subreddit_accuracy": 0.87,
                    "rule_match_strength": 0.96,
                },
                model_reasoner="gemini-2.5-pro",
                model_summarizer="gemini-2.5-flash",
                cost_usd=0.018,
                latency_ms=1432,
            ),
        )

    async with with_session(sessions) as s:
        loaded = await get_investigation_by_correlation(
            s, correlation_id=corr, subreddit_id=sub
        )
    assert loaded is not None
    assert loaded.status == "completed"
    assert loaded.recommendation == "REMOVE"
    assert loaded.calibrated_confidence == 0.92
    assert loaded.completed_at is not None
    assert len(loaded.evidence) == 2


@pytest.mark.asyncio
async def test_finalize_rejects_subreddit_mismatch(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub_a, sub_b = _sub_id(), _sub_id()
    corr = f"inv-{uuid.uuid4().hex[:8]}"
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub_a, name="a")
        await ensure_subreddit_profile(s, subreddit_id=sub_b, name="b")
        await start_investigation(
            s,
            input_=StartInvestigationInput(
                correlation_id=corr,
                subreddit_id=sub_a,
                target_kind="comment",
                target_id="t1_x",
                tier="STANDARD",
            ),
        )

    with pytest.raises(LookupError):
        async with with_session(sessions) as s:
            await finalize_investigation(
                s,
                correlation_id=corr,
                subreddit_id=sub_b,  # WRONG subreddit_id — must not match
                verdict=FinalizeInvestigationInput(
                    risk_tier="LOW",
                    recommendation="NO_RECOMMENDATION",
                    calibrated_confidence=0.3,
                    rationale="",
                    confidence_breakdown={},
                    model_reasoner="",
                    model_summarizer="",
                    cost_usd=0.0,
                    latency_ms=0,
                ),
            )


@pytest.mark.asyncio
async def test_record_feedback_and_audit(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub = _sub_id()
    corr = f"inv-{uuid.uuid4().hex[:8]}"
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub, name="feedback")
        await record_feedback(
            s,
            feedback=FeedbackInput(
                correlation_id=corr,
                subreddit_id=sub,
                target_id="t1_x",
                mod_action="REMOVE",
                raw_action="removecomment",
                moderator_name="u/tester",
                source="reddit_native",
                aligned=True,
            ),
        )
        await append_audit(
            s,
            subreddit_id=sub,
            event_type="feedback.recorded",
            actor="u/tester",
            correlation_id=corr,
            detail={"aligned": True},
        )
    # No exception → both rows landed. We rely on the DB to validate enums.


@pytest.mark.asyncio
async def test_append_evidence_rejects_subreddit_mismatch(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    sub_a = _sub_id()
    async with with_session(sessions) as s:
        await ensure_subreddit_profile(s, subreddit_id=sub_a, name="a")
        inv = await start_investigation(
            s,
            input_=StartInvestigationInput(
                correlation_id=f"inv-{uuid.uuid4().hex[:8]}",
                subreddit_id=sub_a,
                target_kind="comment",
                target_id="t1_x",
                tier="STANDARD",
            ),
        )
        with pytest.raises(ValueError, match="subreddit_id mismatch"):
            await append_evidence(
                s,
                investigation=inv,
                subreddit_id="t5_wrong",
                evidence=EvidenceRowInput(evidence_id="ev-1", tool="policy_match"),
            )


@pytest.mark.asyncio
async def test_get_subreddit_profile_returns_none_for_unknown(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    async with with_session(sessions) as s:
        result = await get_subreddit_profile(s, subreddit_id=_sub_id())
    assert result is None
