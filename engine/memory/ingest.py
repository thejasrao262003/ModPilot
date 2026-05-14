"""Feedback ingest — updates user memory, thread memory, cold-start counter.

Spec: docs/05-Memory.md §3, §4, §9-10.

Called on every ModAction feedback event. Pure business logic with an
injected session — no direct I/O beyond the session calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import structlog

from store.postgres import (
    append_audit,
    increment_cold_start_count,
    record_feedback,
    upsert_thread_memory,
    upsert_user_memory,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from store.types import FeedbackInput

logger = structlog.get_logger(__name__)


async def process_feedback(
    session: AsyncSession,
    *,
    feedback: FeedbackInput,
    target_author_id: str = "",
    post_id: str = "",
) -> IngestResult:
    """Process a single feedback event — the I-3.4 entry point.

    Updates:
    1. Durable feedback row (Postgres).
    2. User memory counters + risk tier for the target author.
    3. Thread memory mod_actions_taken (if post_id available).
    4. Subreddit cold_start_count.
    5. Audit log entry.

    All writes happen within the caller's session (single transaction).
    """
    log = logger.bind(
        correlation_id=feedback.correlation_id,
        subreddit_id=feedback.subreddit_id,
        mod_action=feedback.mod_action,
    )

    # 1. Durable feedback record.
    await record_feedback(session, feedback=feedback)

    # 2. User memory update.
    user_memory = None
    if target_author_id:
        violations_delta, approvals_delta = _compute_deltas(feedback.mod_action)
        user_memory = await upsert_user_memory(
            session,
            subreddit_id=feedback.subreddit_id,
            user_id=target_author_id,
            prior_violations_delta=violations_delta,
            prior_approvals_delta=approvals_delta,
        )
        # Recompute risk tier based on updated counters.
        new_tier = compute_risk_tier(
            prior_violations=user_memory.prior_violations,
            prior_approvals=user_memory.prior_approvals,
            created_at=user_memory.last_seen_at,
        )
        if new_tier != user_memory.risk_tier:
            user_memory = await upsert_user_memory(
                session,
                subreddit_id=feedback.subreddit_id,
                user_id=target_author_id,
                risk_tier=new_tier,
            )
            log.info(
                "ingest.risk_tier_changed",
                user_id=target_author_id,
                old_tier=user_memory.risk_tier,
                new_tier=new_tier,
            )

    # 3. Thread memory update.
    if post_id:
        await upsert_thread_memory(
            session,
            subreddit_id=feedback.subreddit_id,
            post_id=post_id,
            mod_action_entry={
                "action": feedback.mod_action,
                "moderator": feedback.moderator_name or feedback.moderator_id,
                "correlation_id": feedback.correlation_id,
                "target_id": feedback.target_id,
            },
        )

    # 4. Increment cold-start counter.
    new_count = await increment_cold_start_count(
        session, subreddit_id=feedback.subreddit_id
    )

    # 5. Audit log.
    await append_audit(
        session,
        subreddit_id=feedback.subreddit_id,
        event_type="feedback.processed",
        actor=feedback.moderator_name or feedback.moderator_id or "unknown",
        correlation_id=feedback.correlation_id,
        detail={
            "mod_action": feedback.mod_action,
            "target_id": feedback.target_id,
            "source": feedback.source,
            "aligned": feedback.aligned,
        },
    )

    log.info(
        "ingest.completed",
        cold_start_count=new_count,
        user_updated=bool(target_author_id),
        thread_updated=bool(post_id),
    )

    return IngestResult(
        cold_start_count=new_count,
        risk_tier_changed=user_memory is not None,
    )


# === Risk tier computation ================================================


def compute_risk_tier(
    *,
    prior_violations: int,
    prior_approvals: int,
    created_at: object = None,
) -> str:
    """Derive risk tier from user memory counters.

    Simplified MVP rules per docs/05-Memory.md §3.4:
    - "watched" if prior_violations >= 3
    - "trusted" if prior_approvals >= 5 and prior_violations == 0
    - "new" if no history (both zero)
    - "neutral" otherwise

    Full trust_score computation with time decay is post-MVP (nightly batch).
    """
    if prior_violations == 0 and prior_approvals == 0:
        return "new"
    if prior_violations >= 3:
        return "watched"
    if prior_approvals >= 5 and prior_violations == 0:
        return "trusted"
    return "neutral"


# === Helpers ==============================================================


def _compute_deltas(mod_action: str) -> tuple[int, int]:
    """Return (violations_delta, approvals_delta) for a given mod action."""
    if mod_action == "REMOVE":
        return (1, 0)
    if mod_action == "APPROVE":
        return (0, 1)
    # ESCALATE and LOCK don't directly change counters.
    return (0, 0)


# === Result type ==========================================================


@dataclass(frozen=True)
class IngestResult:
    """Returned to the caller so the endpoint can include metadata."""

    cold_start_count: int
    risk_tier_changed: bool
