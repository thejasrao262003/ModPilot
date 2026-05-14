"""user_history tool — surface the target author's moderation memory.

Spec: docs/04-InvestigationEngine.md §5.3.3.

Postgres read: fetches UserMemory row for the target author in this subreddit.
Returns prior violations/approvals, risk tier, and derived signal strength.
Target: <500 ms (memory layer read only, no LLM).
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from orchestrator.tools import ToolContext, ToolName, ToolResult
from store.postgres import get_user_memory, with_session

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class UserHistoryTool:
    """Surfaces the target author's longitudinal moderation history.

    Injected with a Postgres session factory at startup. Reads from the
    ``user_memory`` table via ``get_user_memory``.
    """

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    @property
    def name(self) -> ToolName:
        return "user_history"

    async def run(self, context: ToolContext) -> ToolResult:
        t0 = time.monotonic()
        if not context.target_author_id:
            return ToolResult(
                tool=self.name,
                status="skipped",
                summary="no author id available",
                latency_ms=_elapsed_ms(t0),
            )
        try:
            return await self._lookup(context, t0)
        except Exception as exc:
            return ToolResult(
                tool=self.name,
                status="failure",
                summary="user history lookup failed",
                latency_ms=_elapsed_ms(t0),
                error=str(exc),
            )

    async def _lookup(self, ctx: ToolContext, t0: float) -> ToolResult:
        async with with_session(self._sessions) as session:
            mem = await get_user_memory(
                session,
                subreddit_id=ctx.subreddit_id,
                user_id=ctx.target_author_id,
            )

        latency = _elapsed_ms(t0)

        if mem is None:
            return ToolResult(
                tool=self.name,
                status="success",
                summary="no prior history — first-time user",
                latency_ms=latency,
                detail={
                    "risk_tier": "new",
                    "prior_violations": 0,
                    "prior_approvals": 0,
                    "has_history": False,
                },
            )

        signal = _signal_strength(mem.risk_tier, mem.prior_violations)
        summary = (
            f"user tier={mem.risk_tier}, "
            f"{mem.prior_violations} violation(s), "
            f"{mem.prior_approvals} approval(s)"
        )
        if len(summary) > 200:
            summary = summary[:200]

        return ToolResult(
            tool=self.name,
            status="success",
            summary=summary,
            latency_ms=latency,
            detail={
                "risk_tier": mem.risk_tier,
                "prior_violations": mem.prior_violations,
                "prior_approvals": mem.prior_approvals,
                "has_history": True,
                "last_seen_at": mem.last_seen_at.isoformat() if mem.last_seen_at else None,
                "signal": signal,
            },
        )


def _signal_strength(risk_tier: str, prior_violations: int) -> str:
    """Derive signal strength for convergence checks."""
    if risk_tier == "watched" or prior_violations >= 3:
        return "high"
    if risk_tier == "trusted":
        return "high"
    return "normal"


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)
