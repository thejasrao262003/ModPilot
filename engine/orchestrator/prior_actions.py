"""prior_actions tool — surface past mod actions on the same author.

Spec: docs/04-InvestigationEngine.md §5.3.4.

Postgres read: fetches last N completed investigations on the target author
in this subreddit.  Returns action type, when, whether ModPilot recommended
it, whether the mod accepted/overrode.  Target: <120 ms p95.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from orchestrator.tools import ToolContext, ToolName, ToolResult
from store.postgres import list_prior_actions_on_user

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from store import models as m

_DEFAULT_LIMIT = 3


class PriorActionsTool:
    """Looks up prior mod actions on the target author in this subreddit.

    Injected with a Postgres session factory at startup. Uses the
    ``list_prior_actions_on_user`` query to find completed investigations
    on the same author.
    """

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    @property
    def name(self) -> ToolName:
        return "prior_actions"

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
            actions = await self._fetch(context)
            latency = _elapsed_ms(t0)

            if not actions:
                return ToolResult(
                    tool=self.name,
                    status="success",
                    summary="no prior mod actions on this user",
                    latency_ms=latency,
                    detail={"prior_actions": [], "count": 0},
                )

            entries: list[dict[str, object]] = []
            removes = 0
            for inv in actions:
                entries.append({
                    "recommendation": inv.recommendation,
                    "risk_tier": inv.risk_tier,
                    "confidence": inv.calibrated_confidence,
                    "target_kind": inv.target_kind,
                    "target_id": inv.target_id,
                    "completed_at": inv.completed_at.isoformat() if inv.completed_at else None,
                    "degraded": inv.degraded,
                })
                if inv.recommendation == "REMOVE":
                    removes += 1

            signal = "high" if removes >= 2 else "normal"
            summary = (
                f"{len(entries)} prior action(s); "
                f"{removes} removal(s)"
            )
            if len(summary) > 200:
                summary = summary[:200]

            return ToolResult(
                tool=self.name,
                status="success",
                summary=summary,
                latency_ms=latency,
                detail={
                    "prior_actions": entries,
                    "count": len(entries),
                    "removals": removes,
                    "signal": signal,
                },
            )
        except Exception as exc:
            return ToolResult(
                tool=self.name,
                status="failure",
                summary="prior actions lookup failed",
                latency_ms=_elapsed_ms(t0),
                error=str(exc),
            )

    async def _fetch(self, ctx: ToolContext) -> list[m.Investigation]:
        from store.postgres import with_session  # noqa: PLC0415

        async with with_session(self._sessions) as session:
            return list(
                await list_prior_actions_on_user(
                    session,
                    subreddit_id=ctx.subreddit_id,
                    author_id=ctx.target_author_id,
                    limit=_DEFAULT_LIMIT,
                )
            )


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)
