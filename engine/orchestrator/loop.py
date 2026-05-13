"""Orchestrator loop — runs tools per tier plan, enforces budgets, early-stops.

Spec: docs/04-InvestigationEngine.md §3, docs/Specs.md §7.2.

For each tier the Strategy Selector picks a plan (FAST=2 tools, STANDARD=4,
DEEP=5+ with potential re-loop). The Orchestrator iterates the plan; each
iteration checks budgets *before* running, invokes the tool with isolated
exception handling, appends the result to the Evidence Accumulator, then
asks the convergence policy whether enough signal has accumulated to stop.

The Orchestrator owns:
  - tier → tool plan mapping (overridable per call for testing)
  - budget enforcement (tool count + wall-clock time)
  - per-tool exception isolation: a single tool throwing must not blow
    up the investigation; we record a `failure` ToolResult and keep going
  - convergence policy: 1 strong-signal success on FAST, 2 on STANDARD/DEEP
  - structured logging at start, per-tool, and stop

It does NOT decide the verdict — that's the Reasoner. It does NOT persist —
that's the API handler wrapping `run()` with a session.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import structlog

from orchestrator.tools import (
    EvidenceAccumulator,
    ToolContext,
    ToolName,
    ToolRegistry,
    ToolResult,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from orchestrator.strategy import StrategyDecision

logger = structlog.get_logger(__name__)


# === Result =============================================================


StopReason = str  # "plan_complete" | "converged" | "budget_tool" | "budget_time"


@dataclass(frozen=True)
class OrchestratorResult:
    correlation_id: str
    subreddit_id: str
    tier: str
    accumulator: EvidenceAccumulator
    started_at: datetime
    completed_at: datetime
    total_latency_ms: int
    tools_run: int
    early_stopped: bool
    stop_reason: StopReason
    plan: list[ToolName] = field(default_factory=list)


# === Default tier plans =================================================

# Specs §7.1 budget table; STANDARD picks the 4-tool variant pending the
# open question about 4-vs-5.
_DEFAULT_PLANS: dict[str, list[ToolName]] = {
    "FAST": ["policy_match", "report_velocity"],
    "STANDARD": ["policy_match", "report_velocity", "user_history", "prior_actions"],
    "DEEP": [
        "policy_match",
        "report_velocity",
        "user_history",
        "prior_actions",
        "thread_context",
    ],
}


# === Orchestrator =======================================================


class Orchestrator:
    """Stateless coordinator. Safe to share across requests."""

    def __init__(
        self,
        registry: ToolRegistry,
        *,
        # `perf_counter`-style clock injected so tests can drive elapsed
        # time deterministically. Returns seconds.
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self._registry = registry
        self._clock = clock

    def default_plan(self, tier: str) -> list[ToolName]:
        try:
            return list(_DEFAULT_PLANS[tier])
        except KeyError as e:
            raise ValueError(f"no default plan for tier {tier!r}") from e

    async def run(
        self,
        *,
        decision: StrategyDecision,
        context: ToolContext,
        plan: list[ToolName] | None = None,
    ) -> OrchestratorResult:
        chosen_plan = plan if plan is not None else self.default_plan(decision.tier)
        accumulator = EvidenceAccumulator()
        log = logger.bind(
            correlation_id=context.correlation_id,
            subreddit_id=context.subreddit_id,
            tier=decision.tier,
            plan_length=len(chosen_plan),
        )
        log.info("orchestrator.started", plan=chosen_plan)

        started_at = datetime.now(UTC)
        started_perf = self._clock()

        tools_run = 0
        stop_reason: StopReason = "plan_complete"
        early_stopped = False

        for tool_name in chosen_plan:
            # 1. Budget pre-check.
            elapsed_ms = int((self._clock() - started_perf) * 1000)
            if elapsed_ms >= decision.time_budget_ms:
                stop_reason = "budget_time"
                early_stopped = True
                log.info("orchestrator.stop", reason=stop_reason, elapsed_ms=elapsed_ms)
                break
            if tools_run >= decision.tool_budget:
                stop_reason = "budget_tool"
                early_stopped = True
                log.info("orchestrator.stop", reason=stop_reason, tools_run=tools_run)
                break

            # 2. Resolve tool. Unregistered → record skip, keep going.
            if not self._registry.has(tool_name):
                accumulator.append(
                    ToolResult(
                        tool=tool_name,
                        status="skipped",
                        summary=f"tool {tool_name!r} not registered",
                        latency_ms=0,
                    )
                )
                tools_run += 1
                log.warning("orchestrator.tool.unregistered", tool=tool_name)
                continue

            # 3. Run the tool with isolated exception handling.
            tool = self._registry.get(tool_name)
            tool_started = self._clock()
            try:
                result = await tool.run(context)
            except Exception as exc:
                latency = int((self._clock() - tool_started) * 1000)
                result = ToolResult(
                    tool=tool_name,
                    status="failure",
                    summary=f"tool raised: {type(exc).__name__}",
                    latency_ms=latency,
                    error=str(exc),
                )
                log.warning(
                    "orchestrator.tool.raised",
                    tool=tool_name,
                    exc_type=type(exc).__name__,
                )

            accumulator.append(result)
            tools_run += 1
            log.info(
                "orchestrator.tool.completed",
                tool=tool_name,
                status=result.status,
                latency_ms=result.latency_ms,
            )

            # 4. Convergence check — stop early if we have enough signal.
            if _converged(accumulator, decision.tier):
                stop_reason = "converged"
                early_stopped = True
                log.info(
                    "orchestrator.stop",
                    reason=stop_reason,
                    tools_run=tools_run,
                    successful_evidence=len(accumulator.successful_entries()),
                )
                break

        completed_at = datetime.now(UTC)
        total_latency_ms = int((self._clock() - started_perf) * 1000)
        log.info(
            "orchestrator.completed",
            tools_run=tools_run,
            stop_reason=stop_reason,
            total_latency_ms=total_latency_ms,
        )

        return OrchestratorResult(
            correlation_id=context.correlation_id,
            subreddit_id=context.subreddit_id,
            tier=decision.tier,
            accumulator=accumulator,
            started_at=started_at,
            completed_at=completed_at,
            total_latency_ms=total_latency_ms,
            tools_run=tools_run,
            early_stopped=early_stopped,
            stop_reason=stop_reason,
            plan=chosen_plan,
        )


# === Convergence policy =================================================


def _converged(acc: EvidenceAccumulator, tier: str) -> bool:
    """A simple, explainable convergence rule.

    For FAST tier: 1 strong-signal success is enough.
    For STANDARD / DEEP: require 2 strong signals — we want the Reasoner
    to have at least two corroborating evidence rows before short-circuiting.

    A "strong signal" is a successful tool result whose `detail.signal` is
    `"high"`. Tools self-report this. If no tool has set it, convergence
    never triggers and the plan runs to its budget.
    """
    threshold = 1 if tier == "FAST" else 2
    strong = sum(
        1
        for entry in acc.successful_entries()
        if entry.detail.get("signal") == "high"
    )
    return strong >= threshold


__all__ = [
    "Orchestrator",
    "OrchestratorResult",
    "StopReason",
]
