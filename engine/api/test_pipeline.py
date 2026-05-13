"""Pipeline integration tests — mocked deps, real business logic.

Tests the full run_investigation() flow plus all helper functions.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from api.pipeline import (
    PipelineResult,
    _build_timeline,
    _build_top_evidence,
    _extract_evidence_signals,
    _extract_rule_match_strength,
    _fallback_output,
    run_investigation,
)
from api.schemas import InvestigateRequest
from llm.client import LLMResponse
from llm.prompts.reasoner import ReasonerOutput
from orchestrator.loop import OrchestratorResult
from orchestrator.tools import EvidenceAccumulator, ToolResult

# === Helpers =============================================================


def _req(**overrides: object) -> InvestigateRequest:
    base: dict[str, object] = {
        "correlation_id": "inv-test-001",
        "subreddit_id": "t5_test",
        "target": {
            "kind": "comment",
            "id": "t1_abc",
            "body": "some content",
            "author": "t2_user",
        },
        "report": {"reasons": ["spam"], "reporter_count": 2},
    }
    base.update(overrides)
    return InvestigateRequest.model_validate(base)


def _tool_result(
    tool: str = "policy_match",
    status: str = "success",
    summary: str = "matched rule 2",
    detail: dict[str, object] | None = None,
) -> ToolResult:
    return ToolResult(
        tool=tool,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        summary=summary,
        latency_ms=10,
        detail=detail or {},
    )


def _accumulator(*results: ToolResult) -> EvidenceAccumulator:
    acc = EvidenceAccumulator()
    for r in results:
        acc.append(r)
    return acc


def _reasoner_output(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "risk_tier": "HIGH",
        "recommendation": "REMOVE",
        "rationale": (
            "The content matches rule 2 with high similarity [ev-1] "
            "and report velocity is elevated [ev-2]."
        ),
        "top_evidence_ids": ["ev-1", "ev-2"],
        "raw_confidence": 0.88,
        "cited_evidence_ids": ["ev-1", "ev-2"],
        "flags": [],
    }
    base.update(overrides)
    return base


def _mock_orchestrator(
    accumulator: EvidenceAccumulator | None = None,
    tools_run: int = 2,
    early_stopped: bool = False,
    stop_reason: str = "plan_complete",
) -> AsyncMock:
    acc = accumulator or _accumulator(
        _tool_result("policy_match", summary="matched rule 2"),
        _tool_result("report_velocity", summary="3 in 5min"),
    )
    mock = AsyncMock()
    mock.run.return_value = OrchestratorResult(
        correlation_id="inv-test-001",
        subreddit_id="t5_test",
        tier="STANDARD",
        accumulator=acc,
        started_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
        total_latency_ms=100,
        tools_run=tools_run,
        early_stopped=early_stopped,
        stop_reason=stop_reason,
    )
    return mock


def _mock_llm(output: dict[str, object] | None = None) -> AsyncMock:
    data = output or _reasoner_output()
    raw_text = json.dumps(data)
    parsed = ReasonerOutput.model_validate(data)
    mock = AsyncMock()
    mock.complete.return_value = LLMResponse(
        raw_text=raw_text,
        input_tokens=500,
        output_tokens=120,
        model="gemini-2.5-pro",
        latency_ms=1200,
        cost_usd=0.002,
        parsed=parsed,
    )
    return mock


async def _run(**overrides: object) -> PipelineResult:
    """Run the pipeline with sensible defaults. Override any kwarg."""
    defaults: dict[str, object] = {
        "req": _req(),
        "orchestrator": _mock_orchestrator(),
        "llm": _mock_llm(),
        "personality": "balanced",
        "region": "US",
        "rules": "1. No spam\n2. Be civil",
        "cold_start": False,
        "user_risk_tier": "neutral",
        "velocity_zscore": 0.0,
        "rule_match_score": 0.0,
        "tier_override": "auto",
    }
    defaults.update(overrides)
    return await run_investigation(**defaults)  # type: ignore[arg-type]


# === Pipeline happy path ==================================================


class TestPipelineHappyPath:
    @pytest.mark.asyncio
    async def test_returns_pipeline_result(self) -> None:
        result = await _run()
        assert isinstance(result, PipelineResult)
        assert result.verdict is not None

    @pytest.mark.asyncio
    async def test_verdict_has_correct_correlation_id(self) -> None:
        result = await _run()
        assert result.verdict.correlation_id == "inv-test-001"

    @pytest.mark.asyncio
    async def test_verdict_recommendation_from_reasoner(self) -> None:
        result = await _run()
        assert result.verdict.recommendation == "REMOVE"

    @pytest.mark.asyncio
    async def test_verdict_risk_tier_from_reasoner(self) -> None:
        result = await _run()
        assert result.verdict.risk_tier == "HIGH"

    @pytest.mark.asyncio
    async def test_verdict_has_timeline(self) -> None:
        result = await _run()
        assert len(result.verdict.timeline) == 2
        assert result.verdict.timeline[0].tool == "policy_match"
        assert result.verdict.timeline[1].tool == "report_velocity"

    @pytest.mark.asyncio
    async def test_verdict_has_top_evidence(self) -> None:
        result = await _run()
        assert len(result.verdict.top_evidence) == 2
        assert result.verdict.top_evidence[0].id == "ev-1"

    @pytest.mark.asyncio
    async def test_verdict_has_confidence_breakdown(self) -> None:
        result = await _run()
        cb = result.verdict.confidence_breakdown
        assert 0.0 <= cb.llm_self_report <= 1.0
        assert 0.0 <= cb.evidence_convergence <= 1.0

    @pytest.mark.asyncio
    async def test_result_carries_token_counts(self) -> None:
        result = await _run()
        assert result.input_tokens == 500
        assert result.output_tokens == 120
        assert result.cost_usd == 0.002

    @pytest.mark.asyncio
    async def test_result_carries_model(self) -> None:
        result = await _run()
        assert result.model_reasoner == "gemini-2.5-pro"

    @pytest.mark.asyncio
    async def test_calibrated_confidence_in_range(self) -> None:
        result = await _run()
        assert 0.0 <= result.verdict.calibrated_confidence <= 1.0


# === Degraded mode (Reasoner fails) ======================================


class TestDegradedMode:
    @pytest.mark.asyncio
    async def test_llm_failure_returns_degraded_verdict(self) -> None:
        llm = AsyncMock()
        llm.complete.side_effect = TimeoutError("LLM timeout")
        result = await _run(llm=llm)
        assert result.verdict.degraded is True
        assert result.verdict.recommendation == "NO_RECOMMENDATION"
        assert result.verdict.risk_tier == "LOW"

    @pytest.mark.asyncio
    async def test_degraded_has_zero_cost(self) -> None:
        llm = AsyncMock()
        llm.complete.side_effect = TimeoutError("LLM timeout")
        result = await _run(llm=llm)
        assert result.cost_usd == 0.0
        assert result.input_tokens == 0

    @pytest.mark.asyncio
    async def test_degraded_sets_validation_flag(self) -> None:
        llm = AsyncMock()
        llm.complete.side_effect = TimeoutError("LLM timeout")
        result = await _run(llm=llm)
        assert result.validation_flag is True


# === Cold start ===========================================================


class TestColdStart:
    @pytest.mark.asyncio
    async def test_cold_start_flag_propagated(self) -> None:
        result = await _run(cold_start=True)
        assert result.cold_start is True
        assert result.verdict.cold_start is True

    @pytest.mark.asyncio
    async def test_cold_start_demotes_confidence(self) -> None:
        normal = await _run(cold_start=False)
        cold = await _run(cold_start=True)
        assert cold.verdict.calibrated_confidence < normal.verdict.calibrated_confidence


# === Partial evidence =====================================================


class TestPartialEvidence:
    @pytest.mark.asyncio
    async def test_partial_demotes_confidence(self) -> None:
        normal_orch = _mock_orchestrator(early_stopped=False)
        partial_orch = _mock_orchestrator(
            early_stopped=True, stop_reason="budget_time"
        )
        normal = await _run(orchestrator=normal_orch)
        partial = await _run(orchestrator=partial_orch)
        assert partial.verdict.calibrated_confidence < normal.verdict.calibrated_confidence

    @pytest.mark.asyncio
    async def test_converged_not_partial(self) -> None:
        """Convergence early-stop is NOT treated as partial."""
        normal_orch = _mock_orchestrator(early_stopped=False)
        converged_orch = _mock_orchestrator(
            early_stopped=True, stop_reason="converged"
        )
        normal = await _run(orchestrator=normal_orch)
        converged = await _run(orchestrator=converged_orch)
        assert (
            converged.verdict.calibrated_confidence
            == normal.verdict.calibrated_confidence
        )


# === Helper functions =====================================================


class TestFallbackOutput:
    def test_fallback_is_low_no_recommendation(self) -> None:
        out = _fallback_output()
        assert out.risk_tier == "LOW"
        assert out.recommendation == "NO_RECOMMENDATION"
        assert out.raw_confidence == 0.0
        assert "reasoner_failed" in out.flags


class TestExtractRuleMatchStrength:
    def test_with_policy_match(self) -> None:
        acc = _accumulator(
            _tool_result(
                "policy_match",
                detail={"matches": [{"rule": "r1", "similarity": 0.91}]},
            )
        )
        assert _extract_rule_match_strength(acc) == 0.91

    def test_no_policy_match(self) -> None:
        acc = _accumulator(_tool_result("report_velocity"))
        assert _extract_rule_match_strength(acc) == 0.0

    def test_empty_matches(self) -> None:
        acc = _accumulator(
            _tool_result("policy_match", detail={"matches": []})
        )
        assert _extract_rule_match_strength(acc) == 0.0

    def test_failure_entries_ignored(self) -> None:
        acc = _accumulator(
            _tool_result(
                "policy_match",
                status="failure",
                detail={"matches": [{"similarity": 0.9}]},
            )
        )
        assert _extract_rule_match_strength(acc) == 0.0


class TestExtractEvidenceSignals:
    def test_policy_match_signal(self) -> None:
        acc = _accumulator(
            _tool_result(
                "policy_match",
                detail={"matches": [{"similarity": 0.85}]},
            )
        )
        signals = _extract_evidence_signals(acc)
        assert signals == [0.85]

    def test_velocity_signal_normalized(self) -> None:
        acc = _accumulator(
            _tool_result("report_velocity", detail={"z_score": 5.0})
        )
        signals = _extract_evidence_signals(acc)
        assert signals == [1.0]  # z=5 / 5.0 = 1.0, capped at 1.0

    def test_generic_tool_signal(self) -> None:
        acc = _accumulator(_tool_result("user_history"))
        signals = _extract_evidence_signals(acc)
        assert signals == [0.5]

    def test_empty_accumulator(self) -> None:
        acc = _accumulator()
        assert _extract_evidence_signals(acc) == []


class TestBuildTimeline:
    def test_all_entries_included(self) -> None:
        acc = _accumulator(
            _tool_result("policy_match"),
            _tool_result("report_velocity"),
        )
        timeline = _build_timeline(acc)
        assert len(timeline) == 2
        assert timeline[0].tool == "policy_match"
        assert timeline[0].verb == "Matched against rules"
        assert timeline[1].tool == "report_velocity"

    def test_failure_entries_in_timeline(self) -> None:
        acc = _accumulator(
            _tool_result("policy_match", status="failure", summary="err"),
        )
        timeline = _build_timeline(acc)
        assert len(timeline) == 1
        assert timeline[0].status == "failure"


class TestBuildTopEvidence:
    def test_selects_by_ids(self) -> None:
        acc = _accumulator(
            _tool_result("policy_match", summary="rule 2"),
            _tool_result("report_velocity", summary="fast"),
        )
        rows = _build_top_evidence(acc, ["ev-2", "ev-1"])
        assert len(rows) == 2
        assert rows[0].id == "ev-2"
        assert rows[1].id == "ev-1"

    def test_missing_id_skipped(self) -> None:
        acc = _accumulator(_tool_result("policy_match"))
        rows = _build_top_evidence(acc, ["ev-1", "ev-99"])
        assert len(rows) == 1

    def test_max_three(self) -> None:
        acc = _accumulator(
            _tool_result("policy_match"),
            _tool_result("report_velocity"),
            _tool_result("user_history"),
            _tool_result("thread_context"),
        )
        rows = _build_top_evidence(acc, ["ev-1", "ev-2", "ev-3", "ev-4"])
        assert len(rows) == 3
