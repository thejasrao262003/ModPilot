"""Postgres repository functions — typed, async, subreddit_id-scoped.

Every public function takes `subreddit_id` as a mandatory positional arg
(invariant I-7 enforced at the API). Internal helpers add the predicate to
SELECT/UPDATE/DELETE.

Spec: docs/Specs.md §9, docs/07-DataLayer.md.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import structlog
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from store import models as m

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Sequence
from store.types import (
    EvidenceRowInput,
    FeedbackInput,
    FinalizeInvestigationInput,
    StartInvestigationInput,
    SubredditProfileRow,
    UserMemoryRow,
)

logger = structlog.get_logger(__name__)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build the per-engine session factory. Held on app.state in the lifespan."""
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def with_session(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Open a session, commit on clean exit, rollback on exception."""
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# === Subreddit profile =================================================


async def ensure_subreddit_profile(
    session: AsyncSession,
    *,
    subreddit_id: str,
    name: str,
    personality: str = "balanced",
) -> SubredditProfileRow:
    """Idempotent on AppInstall. Returns the existing row if present."""
    stmt = (
        pg_insert(m.SubredditProfile)
        .values(subreddit_id=subreddit_id, name=name, personality=personality)
        .on_conflict_do_nothing(index_elements=["subreddit_id"])
    )
    await session.execute(stmt)
    row = (
        await session.execute(
            select(m.SubredditProfile).where(m.SubredditProfile.subreddit_id == subreddit_id)
        )
    ).scalar_one()
    return SubredditProfileRow.model_validate(row)


async def get_subreddit_profile(
    session: AsyncSession, *, subreddit_id: str
) -> SubredditProfileRow | None:
    row = (
        await session.execute(
            select(m.SubredditProfile).where(m.SubredditProfile.subreddit_id == subreddit_id)
        )
    ).scalar_one_or_none()
    return SubredditProfileRow.model_validate(row) if row else None


# === User memory =======================================================


async def get_user_memory(
    session: AsyncSession, *, subreddit_id: str, user_id: str
) -> UserMemoryRow | None:
    row = (
        await session.execute(
            select(m.UserMemory).where(
                m.UserMemory.subreddit_id == subreddit_id,
                m.UserMemory.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return UserMemoryRow.model_validate(row) if row else None


async def upsert_user_memory(  # noqa: PLR0913 — kwarg-only delta-style API, intentional surface
    session: AsyncSession,
    *,
    subreddit_id: str,
    user_id: str,
    risk_tier: str | None = None,
    prior_violations_delta: int = 0,
    prior_approvals_delta: int = 0,
) -> UserMemoryRow:
    """Get-or-create, then optionally bump counters and refresh last_seen.

    Used by `feedback`-batch ingest (I-3.4) and by `user_history` tool reads.
    Idempotent on (subreddit_id, user_id).
    """
    base = (
        pg_insert(m.UserMemory)
        .values(
            subreddit_id=subreddit_id,
            user_id=user_id,
            last_seen_at=datetime.now(UTC),
        )
        .on_conflict_do_update(
            index_elements=["subreddit_id", "user_id"],
            set_={"last_seen_at": datetime.now(UTC)},
        )
    )
    await session.execute(base)

    if risk_tier or prior_violations_delta or prior_approvals_delta:
        updates: dict[str, object] = {}
        if risk_tier:
            updates["risk_tier"] = risk_tier
        if prior_violations_delta:
            updates["prior_violations"] = (
                m.UserMemory.prior_violations + prior_violations_delta
            )
        if prior_approvals_delta:
            updates["prior_approvals"] = (
                m.UserMemory.prior_approvals + prior_approvals_delta
            )
        await session.execute(
            update(m.UserMemory)
            .where(
                m.UserMemory.subreddit_id == subreddit_id,
                m.UserMemory.user_id == user_id,
            )
            .values(**updates)
        )

    row = (
        await session.execute(
            select(m.UserMemory).where(
                m.UserMemory.subreddit_id == subreddit_id,
                m.UserMemory.user_id == user_id,
            )
        )
    ).scalar_one()
    return UserMemoryRow.model_validate(row)


# === Investigation =====================================================


async def start_investigation(
    session: AsyncSession, *, input_: StartInvestigationInput
) -> m.Investigation:
    """Create a `pending` investigation row and return the ORM object."""
    row = m.Investigation(
        correlation_id=input_.correlation_id,
        subreddit_id=input_.subreddit_id,
        target_kind=input_.target_kind,
        target_id=input_.target_id,
        target_body=input_.target_body,
        target_author_id=input_.target_author_id,
        tier=input_.tier,
        status="pending",
    )
    session.add(row)
    await session.flush()
    return row


async def append_evidence(
    session: AsyncSession,
    *,
    investigation: m.Investigation,
    subreddit_id: str,
    evidence: EvidenceRowInput,
) -> None:
    """Persist one Evidence Accumulator entry. subreddit_id must match the investigation."""
    if investigation.subreddit_id != subreddit_id:
        raise ValueError(
            f"subreddit_id mismatch: investigation={investigation.subreddit_id} call={subreddit_id}"
        )
    row = m.Evidence(
        investigation_id=investigation.id,
        subreddit_id=subreddit_id,
        evidence_id=evidence.evidence_id,
        tool=evidence.tool,
        summary=evidence.summary,
        detail=evidence.detail,
        status=evidence.status,
        latency_ms=evidence.latency_ms,
    )
    session.add(row)
    await session.flush()


async def finalize_investigation(
    session: AsyncSession,
    *,
    correlation_id: str,
    subreddit_id: str,
    verdict: FinalizeInvestigationInput,
) -> None:
    """Stamp the verdict columns + flip status='completed'."""
    completed_at = datetime.now(UTC)
    stmt = (
        update(m.Investigation)
        .where(
            m.Investigation.correlation_id == correlation_id,
            m.Investigation.subreddit_id == subreddit_id,
        )
        .values(
            status="completed",
            risk_tier=verdict.risk_tier,
            recommendation=verdict.recommendation,
            calibrated_confidence=verdict.calibrated_confidence,
            rationale=verdict.rationale,
            confidence_breakdown=verdict.confidence_breakdown,
            model_reasoner=verdict.model_reasoner,
            model_summarizer=verdict.model_summarizer,
            cost_usd=verdict.cost_usd,
            latency_ms=verdict.latency_ms,
            input_tokens=verdict.input_tokens,
            output_tokens=verdict.output_tokens,
            validation_flag=verdict.validation_flag,
            degraded=verdict.degraded,
            cold_start=verdict.cold_start,
            completed_at=completed_at,
        )
        .execution_options(synchronize_session=False)
    )
    result = await session.execute(stmt)
    # CursorResult.rowcount is set on UPDATE; the typed `Result` superclass omits it.
    rowcount = getattr(result, "rowcount", 0) or 0
    if rowcount == 0:
        raise LookupError(
            "no pending investigation for "
            f"correlation_id={correlation_id} subreddit_id={subreddit_id}"
        )


async def get_investigation_by_correlation(
    session: AsyncSession, *, correlation_id: str, subreddit_id: str
) -> m.Investigation | None:
    """Eagerly loads `.evidence` so callers can iterate it after the session closes."""
    return (
        await session.execute(
            select(m.Investigation)
            .where(
                m.Investigation.correlation_id == correlation_id,
                m.Investigation.subreddit_id == subreddit_id,
            )
            .options(selectinload(m.Investigation.evidence))
        )
    ).scalar_one_or_none()


# === Feedback ==========================================================


async def record_feedback(session: AsyncSession, *, feedback: FeedbackInput) -> None:
    session.add(
        m.Feedback(
            correlation_id=feedback.correlation_id,
            subreddit_id=feedback.subreddit_id,
            target_id=feedback.target_id,
            mod_action=feedback.mod_action,
            raw_action=feedback.raw_action,
            moderator_id=feedback.moderator_id,
            moderator_name=feedback.moderator_name,
            source=feedback.source,
            aligned=feedback.aligned,
        )
    )
    await session.flush()


async def list_recent_feedback_for_subreddit(
    session: AsyncSession, *, subreddit_id: str, limit: int = 100
) -> Sequence[m.Feedback]:
    """Used by the nightly calibration batch (post-MVP)."""
    return (
        await session.execute(
            select(m.Feedback)
            .where(m.Feedback.subreddit_id == subreddit_id)
            .order_by(m.Feedback.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()


# === Audit log =========================================================


async def append_audit(  # noqa: PLR0913 — append-only audit takes the full event shape
    session: AsyncSession,
    *,
    subreddit_id: str,
    event_type: str,
    actor: str = "system",
    correlation_id: str | None = None,
    detail: dict[str, object] | None = None,
) -> None:
    session.add(
        m.AuditLog(
            subreddit_id=subreddit_id,
            event_type=event_type,
            actor=actor,
            correlation_id=correlation_id,
            detail=detail or {},
        )
    )
    await session.flush()
