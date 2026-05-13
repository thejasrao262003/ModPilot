"""Orchestrator loop tests — happy path, early-stop, budget exits, failure isolation."""

from __future__ import annotations

from typing import Literal

import pytest

from orchestrator.loop import Orchestrator
from orchestrator.strategy import StrategyDecision
from orchestrator.tools import ToolContext, ToolName, ToolRegistry, ToolResult

# === Test doubles ======================================================


class _ScriptedTool:
    """A `Tool` that returns a pre-scripted result. Records calls for assertions."""

    def __init__(  # noqa: PLR0913 — test-only kwarg surface, intentional
        self,
        name: ToolName,
        *,
        status: Literal["success", "failure", "skipped", "timeout"] = "success",
        summary: str = "ok",
        latency_ms: int = 10,
        signal: str | None = None,
        raise_exc: Exception | None = None,
    ) -> None:
        self._name = name
        self._status = status
        self._summary = summary
        self._latency_ms = latency_ms
        self._signal = signal
        self._raise = raise_exc
        self.calls: int = 0

    @property
    def name(self) -> ToolName:
        return self._name

    async def run(self, context: ToolContext) -> ToolResult:
        self.calls += 1
        if self._raise is not None:
            raise self._raise
        detail: dict[str, object] = {}
        if self._signal:
            detail["signal"] = self._signal
        return ToolResult(
            tool=self._name,
            status=self._status,
            summary=self._summary,
            latency_ms=self._latency_ms,
            detail=detail,
        )


def _decision(
    tier: Literal["FAST", "STANDARD", "DEEP"] = "STANDARD",
    *,
    tool_budget: int | None = None,
    time_budget_ms: int | None = None,
) -> StrategyDecision:
    defaults = {
        "FAST": (2, 800, 0.003, False),
        "STANDARD": (4, 3_000, 0.012, True),
        "DEEP": (6, 6_000, 0.030, True),
    }[tier]
    return StrategyDecision(
        tier=tier,
        tool_budget=tool_budget if tool_budget is not None else defaults[0],
        time_budget_ms=time_budget_ms if time_budget_ms is not None else defaults[1],
        cost_budget_usd=defaults[2],
        reasoner_required=defaults[3],
        rationale="test",
    )


def _ctx() -> ToolContext:
    return ToolContext(
        subreddit_id="t5_test",
        correlation_id="inv-test-1",
        target_kind="post",
        target_id="t3_x",
    )


class _FakeClock:
    """Monotonic clock that advances by `step` on each call."""

    def __init__(self, step: float = 0.001) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        self._t += self._step
        return self._t

    def advance(self, seconds: float) -> None:
        self._t += seconds


# === Happy path ========================================================


@pytest.mark.asyncio
async def test_happy_path_runs_full_plan() -> None:
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity"))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("STANDARD"), context=_ctx())

    assert result.tier == "STANDARD"
    assert result.tools_run == 4
    assert result.early_stopped is False
    assert result.stop_reason == "plan_complete"
    assert [e.tool for e in result.accumulator.entries()] == [
        "policy_match",
        "report_velocity",
        "user_history",
        "prior_actions",
    ]
    assert [e.id for e in result.accumulator.entries()] == ["ev-1", "ev-2", "ev-3", "ev-4"]


@pytest.mark.asyncio
async def test_records_started_and_completed_timestamps() -> None:
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(
        decision=_decision("FAST"), context=_ctx(), plan=["policy_match"]
    )
    assert result.started_at <= result.completed_at


# === Early stop: convergence ===========================================


@pytest.mark.asyncio
async def test_standard_converges_after_two_strong_signals() -> None:
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match", signal="high"))
    registry.register(_ScriptedTool("report_velocity", signal="high"))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("STANDARD"), context=_ctx())

    assert result.tools_run == 2
    assert result.early_stopped is True
    assert result.stop_reason == "converged"
    # The third tool (user_history) never ran.
    user_history_tool = registry.get("user_history")
    assert isinstance(user_history_tool, _ScriptedTool)
    assert user_history_tool.calls == 0


@pytest.mark.asyncio
async def test_fast_converges_after_one_strong_signal() -> None:
    """FAST tier's convergence threshold is 1."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match", signal="high"))
    registry.register(_ScriptedTool("report_velocity"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("FAST"), context=_ctx())

    assert result.tools_run == 1
    assert result.stop_reason == "converged"


@pytest.mark.asyncio
async def test_no_convergence_when_no_strong_signal() -> None:
    """Tools that don't self-report signal=high never trigger convergence."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity"))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("STANDARD"), context=_ctx())

    assert result.stop_reason == "plan_complete"
    assert result.early_stopped is False


# === Early stop: budgets ==============================================


@pytest.mark.asyncio
async def test_tool_budget_exit() -> None:
    """tool_budget=2 caps at 2 even when plan has 4."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity"))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(
        decision=_decision("STANDARD", tool_budget=2),
        context=_ctx(),
    )

    assert result.tools_run == 2
    assert result.early_stopped is True
    assert result.stop_reason == "budget_tool"


@pytest.mark.asyncio
async def test_time_budget_exit() -> None:
    """Fake clock burns 1 full second per tool; budget is 1500ms → 1 tool then stop."""

    clock = _FakeClock(step=0.5)  # 500ms per clock tick

    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity"))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=clock)
    result = await orch.run(
        decision=_decision("STANDARD", time_budget_ms=1_500),
        context=_ctx(),
    )

    # We exit on a pre-check, so at least one tool runs but not all 4.
    assert result.early_stopped is True
    assert result.stop_reason == "budget_time"
    assert result.tools_run < 4


# === Failure isolation =================================================


@pytest.mark.asyncio
async def test_single_tool_exception_does_not_abort_investigation() -> None:
    """A tool raising must not propagate. Investigation continues."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity", raise_exc=RuntimeError("db down")))
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("STANDARD"), context=_ctx())

    assert result.tools_run == 4
    assert result.stop_reason == "plan_complete"

    failed = result.accumulator.by_id("ev-2")
    assert failed is not None
    assert failed.tool == "report_velocity"
    assert failed.status == "failure"
    assert failed.error == "db down"
    assert "RuntimeError" in failed.summary

    # Subsequent tools still ran:
    assert result.accumulator.by_id("ev-3") is not None
    assert result.accumulator.by_id("ev-4") is not None


@pytest.mark.asyncio
async def test_failure_excluded_from_successful_entries() -> None:
    """Failures get evidence ids but are excluded from cite-able set (ADR-0003)."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    registry.register(_ScriptedTool("report_velocity", raise_exc=ValueError("x")))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(decision=_decision("FAST"), context=_ctx())

    successful = result.accumulator.successful_entries()
    assert [e.tool for e in successful] == ["policy_match"]


# === Plan edge cases ===================================================


@pytest.mark.asyncio
async def test_unregistered_tool_in_plan_becomes_skipped() -> None:
    """Unknown tool → recorded as `status=skipped`, doesn't crash."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    # report_velocity intentionally NOT registered

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(
        decision=_decision("FAST"),
        context=_ctx(),
        plan=["policy_match", "report_velocity"],
    )

    assert result.tools_run == 2
    skipped = result.accumulator.by_id("ev-2")
    assert skipped is not None
    assert skipped.status == "skipped"
    assert "not registered" in skipped.summary


@pytest.mark.asyncio
async def test_custom_plan_overrides_tier_default() -> None:
    registry = ToolRegistry()
    registry.register(_ScriptedTool("user_history"))
    registry.register(_ScriptedTool("prior_actions"))

    orch = Orchestrator(registry, clock=_FakeClock())
    result = await orch.run(
        decision=_decision("STANDARD"),
        context=_ctx(),
        plan=["user_history", "prior_actions"],  # skip policy_match + report_velocity
    )

    assert [e.tool for e in result.accumulator.entries()] == ["user_history", "prior_actions"]
    assert result.plan == ["user_history", "prior_actions"]


def test_default_plan_per_tier() -> None:
    orch = Orchestrator(ToolRegistry())
    assert orch.default_plan("FAST") == ["policy_match", "report_velocity"]
    assert len(orch.default_plan("STANDARD")) == 4
    assert "thread_context" in orch.default_plan("DEEP")


def test_default_plan_unknown_tier_raises() -> None:
    orch = Orchestrator(ToolRegistry())
    with pytest.raises(ValueError, match="no default plan"):
        orch.default_plan("FAKE_TIER")


# === Reuse safety ======================================================


@pytest.mark.asyncio
async def test_orchestrator_reusable_across_investigations() -> None:
    """Stateless orchestrator: a second `run()` starts a fresh accumulator."""
    registry = ToolRegistry()
    registry.register(_ScriptedTool("policy_match"))
    orch = Orchestrator(registry, clock=_FakeClock())

    a = await orch.run(decision=_decision("FAST"), context=_ctx(), plan=["policy_match"])
    b = await orch.run(decision=_decision("FAST"), context=_ctx(), plan=["policy_match"])

    assert len(a.accumulator) == 1
    assert len(b.accumulator) == 1
    assert a.accumulator is not b.accumulator
    assert a.accumulator.entries()[0].id == "ev-1"
    assert b.accumulator.entries()[0].id == "ev-1"
