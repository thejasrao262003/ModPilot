"""Reasoner prompt v1.0 tests — template assembly, evidence serialization, Reasoner caller."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from llm.client import LLMResponse, Message
from llm.prompts.reasoner import (
    SYSTEM_PROMPT,
    Reasoner,
    ReasonerOutput,
    ReasonerResult,
    build_corrective_messages,
    build_messages,
    serialize_evidence,
)
from orchestrator.tools import EvidenceAccumulator, ToolResult

# === Helpers =============================================================


def _result(
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


def _acc(*results: ToolResult) -> EvidenceAccumulator:
    acc = EvidenceAccumulator()
    for r in results:
        acc.append(r)
    return acc


def _sample_output(**overrides: object) -> dict[str, object]:
    """A valid ReasonerOutput as a dict (for JSON serialization)."""
    base: dict[str, object] = {
        "risk_tier": "HIGH",
        "recommendation": "REMOVE",
        "rationale": "Author has 3 prior violations [ev-1] and content matches rule [ev-2].",
        "top_evidence_ids": ["ev-1", "ev-2"],
        "raw_confidence": 0.88,
        "cited_evidence_ids": ["ev-1", "ev-2"],
        "flags": [],
    }
    base.update(overrides)
    return base


def _mock_llm(output: dict[str, object] | None = None) -> AsyncMock:
    """Mock LLMClient that returns a valid ReasonerOutput."""
    data = output or _sample_output()
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


# === ReasonerOutput schema ================================================


class TestReasonerOutput:
    def test_valid_output_parses(self) -> None:
        output = ReasonerOutput.model_validate(_sample_output())
        assert output.risk_tier == "HIGH"
        assert output.recommendation == "REMOVE"
        assert output.raw_confidence == 0.88

    def test_all_recommendations(self) -> None:
        for rec in ("REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION"):
            o = ReasonerOutput.model_validate(_sample_output(recommendation=rec))
            assert o.recommendation == rec

    def test_all_risk_tiers(self) -> None:
        for tier in ("HIGH", "MEDIUM", "LOW"):
            o = ReasonerOutput.model_validate(_sample_output(risk_tier=tier))
            assert o.risk_tier == tier

    def test_confidence_bounds(self) -> None:
        ReasonerOutput.model_validate(_sample_output(raw_confidence=0.0))
        ReasonerOutput.model_validate(_sample_output(raw_confidence=1.0))
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(_sample_output(raw_confidence=1.1))
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(_sample_output(raw_confidence=-0.1))

    def test_rationale_min_length(self) -> None:
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(_sample_output(rationale="too short"))

    def test_rationale_max_length(self) -> None:
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(_sample_output(rationale="x" * 601))

    def test_top_evidence_ids_max_3(self) -> None:
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(
                _sample_output(top_evidence_ids=["ev-1", "ev-2", "ev-3", "ev-4"])
            )

    def test_flags_default_empty(self) -> None:
        data = _sample_output()
        del data["flags"]
        o = ReasonerOutput.model_validate(data)
        assert o.flags == []

    def test_invalid_recommendation_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ReasonerOutput.model_validate(_sample_output(recommendation="BAN"))


# === serialize_evidence ===================================================


class TestSerializeEvidence:
    def test_empty_entries(self) -> None:
        assert serialize_evidence([]) == "(no evidence collected)"

    def test_single_entry_no_detail(self) -> None:
        acc = _acc(_result(summary="matched rule 2"))
        entries = acc.successful_entries()
        text = serialize_evidence(entries)
        assert "[ev-1]" in text
        assert "policy_match" in text
        assert "matched rule 2" in text

    def test_detail_included(self) -> None:
        acc = _acc(_result(detail={"z_score": 6.2, "reports_5m": 4}))
        text = serialize_evidence(acc.successful_entries())
        assert "reports_5m=4" in text
        assert "z_score=6.2" in text

    def test_multiple_entries(self) -> None:
        acc = _acc(
            _result("policy_match", summary="rule 2"),
            _result("report_velocity", summary="3 in 5min"),
        )
        text = serialize_evidence(acc.successful_entries())
        assert "[ev-1]" in text
        assert "[ev-2]" in text

    def test_failure_entries_excluded_when_filtered(self) -> None:
        acc = _acc(
            _result("policy_match", status="success", summary="ok"),
            _result("user_history", status="failure", summary="db err"),
        )
        text = serialize_evidence(acc.successful_entries())
        assert "[ev-1]" in text
        assert "[ev-2]" not in text


# === build_messages =======================================================


class TestBuildMessages:
    def test_returns_system_and_user(self) -> None:
        acc = _acc(_result())
        msgs = build_messages(
            accumulator=acc,
            personality="balanced",
            region="US",
            rules="1. No spam",
            target_kind="comment",
            target_id="t1_abc",
            reporter_count=2,
            tier="STANDARD",
            tools_run=4,
            is_partial=False,
            cold_start=False,
        )
        assert len(msgs) == 2
        assert msgs[0].role == "system"
        assert msgs[1].role == "user"

    def test_system_prompt_is_constant(self) -> None:
        acc = _acc(_result())
        msgs = build_messages(
            accumulator=acc,
            personality="strict",
            region="EU",
            rules="",
            target_kind="post",
            target_id="t3_x",
            reporter_count=1,
            tier="FAST",
            tools_run=2,
            is_partial=False,
            cold_start=True,
        )
        assert msgs[0].content == SYSTEM_PROMPT

    def test_user_message_contains_context(self) -> None:
        acc = _acc(_result(summary="matched rule"))
        msgs = build_messages(
            accumulator=acc,
            personality="lenient",
            region="UK",
            rules="1. Be civil\n2. No spam",
            target_kind="comment",
            target_id="t1_abc",
            reporter_count=3,
            tier="DEEP",
            tools_run=5,
            is_partial=True,
            cold_start=False,
        )
        user = msgs[1].content
        assert "lenient" in user
        assert "UK" in user
        assert "Be civil" in user
        assert "t1_abc" in user
        assert "DEEP" in user
        assert "true" in user  # is_partial
        assert "[ev-1]" in user  # evidence block

    def test_empty_rules_shows_placeholder(self) -> None:
        acc = _acc(_result())
        msgs = build_messages(
            accumulator=acc,
            personality="balanced",
            region="Global",
            rules="  ",
            target_kind="post",
            target_id="t3_x",
            reporter_count=1,
            tier="FAST",
            tools_run=2,
            is_partial=False,
            cold_start=False,
        )
        assert "(no rules configured)" in msgs[1].content


# === build_corrective_messages ============================================


class TestBuildCorrectiveMessages:
    def test_appends_assistant_and_corrective_user(self) -> None:
        original = [
            Message(role="system", content="sys"),
            Message(role="user", content="usr"),
        ]
        msgs = build_corrective_messages(
            prior_messages=original,
            prior_response='{"recommendation": "REMOVE"}',
            validation_reason="hallucinated_evidence_ids",
            validation_details="['ev-99']",
        )
        assert len(msgs) == 4
        assert msgs[0].role == "system"
        assert msgs[1].role == "user"
        assert msgs[2].role == "assistant"
        assert msgs[3].role == "user"
        assert "hallucinated_evidence_ids" in msgs[3].content
        assert "ev-99" in msgs[3].content

    def test_preserves_original_messages(self) -> None:
        original = [Message(role="system", content="keep me")]
        msgs = build_corrective_messages(
            prior_messages=original,
            prior_response="resp",
            validation_reason="uncited_claims",
            validation_details="details",
        )
        assert msgs[0].content == "keep me"


# === Reasoner caller ======================================================


class TestReasoner:
    @pytest.mark.asyncio
    async def test_reason_returns_parsed_output(self) -> None:
        llm = _mock_llm()
        reasoner = Reasoner(llm)
        result = await reasoner.reason(
            messages=[Message(role="user", content="test")],
            correlation_id="inv-1",
        )
        assert isinstance(result, ReasonerResult)
        assert isinstance(result.output, ReasonerOutput)
        assert result.output.recommendation == "REMOVE"
        assert result.model == "gemini-2.5-pro"
        assert result.latency_ms == 1200

    @pytest.mark.asyncio
    async def test_reason_fallback_to_raw_text_parsing(self) -> None:
        """When parsed is None, Reasoner parses raw_text as JSON."""
        data = _sample_output()
        llm = AsyncMock()
        llm.complete.return_value = LLMResponse(
            raw_text=json.dumps(data),
            input_tokens=500,
            output_tokens=120,
            model="gemini-2.5-pro",
            latency_ms=1000,
            cost_usd=0.001,
            parsed=None,  # SDK didn't parse it
        )
        reasoner = Reasoner(llm)
        result = await reasoner.reason(
            messages=[Message(role="user", content="test")],
            correlation_id="inv-2",
        )
        assert result.output.recommendation == "REMOVE"

    @pytest.mark.asyncio
    async def test_reason_passes_correct_params(self) -> None:
        llm = _mock_llm()
        reasoner = Reasoner(llm)
        await reasoner.reason(
            messages=[Message(role="user", content="test")],
            correlation_id="inv-3",
        )
        call_kwargs = llm.complete.call_args.kwargs
        assert call_kwargs["role"].value == "reasoner"
        assert call_kwargs["response_schema"] is ReasonerOutput
        assert call_kwargs["temperature"] == 0.0
        assert call_kwargs["correlation_id"] == "inv-3"
        assert call_kwargs["thinking_budget"] == Reasoner.THINKING_BUDGET

    @pytest.mark.asyncio
    async def test_reason_propagates_llm_error(self) -> None:
        llm = AsyncMock()
        llm.complete.side_effect = TimeoutError("LLM timeout")
        reasoner = Reasoner(llm)
        with pytest.raises(TimeoutError, match="LLM timeout"):
            await reasoner.reason(
                messages=[Message(role="user", content="test")],
                correlation_id="inv-4",
            )

    @pytest.mark.asyncio
    async def test_reason_invalid_json_raises(self) -> None:
        llm = AsyncMock()
        llm.complete.return_value = LLMResponse(
            raw_text="not valid json",
            input_tokens=100,
            output_tokens=50,
            model="gemini-2.5-pro",
            latency_ms=500,
            cost_usd=0.001,
            parsed=None,
        )
        reasoner = Reasoner(llm)
        with pytest.raises(ValidationError):
            await reasoner.reason(
                messages=[Message(role="user", content="test")],
                correlation_id="inv-5",
            )

    @pytest.mark.asyncio
    async def test_result_metadata_propagated(self) -> None:
        llm = _mock_llm()
        reasoner = Reasoner(llm)
        result = await reasoner.reason(
            messages=[Message(role="user", content="test")],
            correlation_id="inv-6",
        )
        assert result.input_tokens == 500
        assert result.output_tokens == 120
        assert result.cost_usd == 0.002


# === Integration: build_messages → validate scenario =====================


class TestScenarios:
    """Three sample scenarios that exercise the full prompt assembly path."""

    def _build_scenario(
        self,
        *,
        personality: str = "balanced",
        rules: str = "1. No spam\n2. Be civil\n3. No NSFW",
        evidence: list[ToolResult],
        reporter_count: int = 1,
        tier: str = "STANDARD",
    ) -> list[Message]:
        acc = _acc(*evidence)
        return build_messages(
            accumulator=acc,
            personality=personality,
            region="US",
            rules=rules,
            target_kind="comment",
            target_id="t1_test",
            reporter_count=reporter_count,
            tier=tier,
            tools_run=len(evidence),
            is_partial=False,
            cold_start=False,
        )

    def test_scenario_clear_violation(self) -> None:
        """High-signal: rule match + velocity + user history all point to removal."""
        msgs = self._build_scenario(
            evidence=[
                _result("policy_match", summary="matched rule 2 (sim=0.91)"),
                _result("report_velocity", summary="4 in 5min (z=6.2)"),
                _result("user_history", summary="3 prior removals"),
            ],
            reporter_count=4,
        )
        assert len(msgs) == 2
        user = msgs[1].content
        assert "matched rule 2" in user
        assert "4 in 5min" in user
        assert "3 prior removals" in user

    def test_scenario_ambiguous_content(self) -> None:
        """Mixed signals: weak rule match, no velocity spike."""
        msgs = self._build_scenario(
            personality="lenient",
            evidence=[
                _result("policy_match", summary="weak match (sim=0.67)"),
                _result("report_velocity", summary="1 in 5min (z=0.3)"),
            ],
            tier="FAST",
        )
        user = msgs[1].content
        assert "lenient" in user
        assert "FAST" in user
        assert "weak match" in user

    def test_scenario_no_rules_cold_start(self) -> None:
        """Cold start with no rules configured."""
        msgs = self._build_scenario(
            rules="",
            evidence=[
                _result("report_velocity", summary="2 in 5min (z=1.1)"),
            ],
            tier="STANDARD",
        )
        user = msgs[1].content
        assert "(no rules configured)" in user
