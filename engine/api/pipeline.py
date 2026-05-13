"""Investigation pipeline — Strategy → Orchestrator → Reasoner → Validator → Calibrator.

Spec: docs/Specs.md §10.2, docs/04-InvestigationEngine.md §1-§9.

This module contains the full pipeline as a single async function with
explicit dependency injection.  The FastAPI endpoint in ``main.py`` calls
``run_investigation()`` with real deps; tests inject mocks.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import structlog

from api.schemas import (
    ConfidenceBreakdown,
    EvidenceRow,
    TimelineStep,
    Verdict,
)
from llm.prompts.reasoner import (
    Reasoner,
    ReasonerOutput,
    ReasonerResult,
    build_corrective_messages,
    build_messages,
)
from llm.validation import validate_citations
from orchestrator.calibrator import (
    CalibrationInputs,
    calibrate,
    compute_evidence_convergence,
)
from orchestrator.strategy import StrategyInputs, select_strategy
from orchestrator.tools import EvidenceAccumulator, ToolContext

if TYPE_CHECKING:
    from api.schemas import InvestigateRequest
    from llm.client import LLMClient, Message
    from orchestrator.loop import Orchestrator

logger = structlog.get_logger(__name__)


# === Tool verb map (Specs §11.5, Glossary §6) ============================

_TOOL_VERBS: dict[str, str] = {
    "policy_match": "Matched against rules",
    "report_velocity": "Checked report velocity",
    "user_history": "Pulled author history",
    "prior_actions": "Reviewed prior mod actions",
    "thread_context": "Read thread context",
}


# === Pipeline =============================================================


async def run_investigation(  # noqa: PLR0913
    *,
    req: InvestigateRequest,
    orchestrator: Orchestrator,
    llm: LLMClient,
    # Subreddit context (fetched by caller from DB or defaults).
    personality: str,
    region: str,
    rules: str,
    cold_start: bool,
    user_risk_tier: str,
    # Precomputed cheap signals for strategy selection.
    velocity_zscore: float,
    rule_match_score: float,
    tier_override: str,
) -> PipelineResult:
    """Run the full investigation pipeline.  Pure business logic — no I/O
    beyond what the orchestrator tools and LLM client perform.

    Returns a ``PipelineResult`` containing the ``Verdict`` plus metadata
    needed for persistence.
    """
    t0 = time.perf_counter()
    log = logger.bind(
        correlation_id=req.correlation_id,
        subreddit_id=req.subreddit_id,
    )

    # 1. Strategy selection
    strategy_inputs = StrategyInputs(
        reporter_count=req.report.reporter_count,
        velocity_zscore=velocity_zscore,
        user_risk_tier=user_risk_tier,  # type: ignore[arg-type]
        rule_match_score=rule_match_score,
        personality=personality,  # type: ignore[arg-type]
        tier_override=tier_override,  # type: ignore[arg-type]
        cold_start=cold_start,
    )
    decision = select_strategy(strategy_inputs)
    log.info("pipeline.strategy", tier=decision.tier, rationale=decision.rationale)

    # 2. Orchestrator — run tools
    context = ToolContext(
        subreddit_id=req.subreddit_id,
        correlation_id=req.correlation_id,
        target_kind=req.target.kind,
        target_id=req.target.id,
        target_body=req.target.body,
        target_author_id=req.target.author,
        reporter_count=req.report.reporter_count,
        rule_match_score=rule_match_score,
    )
    orch_result = await orchestrator.run(decision=decision, context=context)
    accumulator = orch_result.accumulator

    # 3. Reasoner — LLM call
    is_partial = orch_result.early_stopped and orch_result.stop_reason != "converged"
    messages = build_messages(
        accumulator=accumulator,
        personality=personality,
        region=region,
        rules=rules,
        target_kind=req.target.kind,
        target_id=req.target.id,
        reporter_count=req.report.reporter_count,
        tier=decision.tier,
        tools_run=orch_result.tools_run,
        is_partial=is_partial,
        cold_start=cold_start,
    )

    reasoner_result: ReasonerResult | None = None
    validation_flag = False

    if decision.reasoner_required:
        reasoner_result = await _reason_with_retry(
            llm=llm,
            messages=messages,
            accumulator=accumulator,
            correlation_id=req.correlation_id,
            log=log,
        )
        validation_flag = reasoner_result is None

    # 4. Extract signals for calibration
    reasoner_output = reasoner_result.output if reasoner_result else _fallback_output()
    rule_match_strength = _extract_rule_match_strength(accumulator)
    evidence_signals = _extract_evidence_signals(accumulator)

    # 5. Calibrate
    cal_inputs = CalibrationInputs(
        llm_self_report=reasoner_output.raw_confidence,
        evidence_convergence=compute_evidence_convergence(evidence_signals),
        subreddit_accuracy=0.5,  # TODO(I-3.4): compute from feedback history
        rule_match_strength=rule_match_strength,
        validation_passed=not validation_flag,
        cold_start=cold_start,
        is_partial=is_partial,
    )
    cal_result = calibrate(cal_inputs)

    # 6. Assemble verdict
    total_ms = int((time.perf_counter() - t0) * 1000)
    model_reasoner = reasoner_result.model if reasoner_result else ""
    input_tokens = reasoner_result.input_tokens if reasoner_result else 0
    output_tokens = reasoner_result.output_tokens if reasoner_result else 0
    cost_usd = reasoner_result.cost_usd if reasoner_result else 0.0

    timeline = _build_timeline(accumulator)
    top_evidence = _build_top_evidence(
        accumulator, reasoner_output.top_evidence_ids
    )

    verdict = Verdict(
        correlation_id=req.correlation_id,
        tier=decision.tier,
        risk_tier=reasoner_output.risk_tier,
        recommendation=reasoner_output.recommendation,
        calibrated_confidence=cal_result.calibrated_confidence,
        rationale=reasoner_output.rationale,
        top_evidence=top_evidence,
        timeline=timeline,
        confidence_breakdown=ConfidenceBreakdown(
            llm_self_report=cal_result.llm_self_report,
            evidence_convergence=cal_result.evidence_convergence,
            subreddit_accuracy=cal_result.subreddit_accuracy,
            rule_match_strength=cal_result.rule_match_strength,
        ),
        model_reasoner=model_reasoner,
        model_summarizer="",  # summarizer not used in current pipeline
        cost_usd=round(cost_usd, 6),
        latency_ms=total_ms,
        validation_flag=validation_flag,
        degraded=reasoner_result is None,
        cold_start=cold_start,
    )

    log.info(
        "pipeline.completed",
        tier=decision.tier,
        recommendation=reasoner_output.recommendation,
        calibrated_confidence=cal_result.calibrated_confidence,
        confidence_tier=cal_result.tier,
        latency_ms=total_ms,
        tools_run=orch_result.tools_run,
        validation_flag=validation_flag,
    )

    return PipelineResult(
        verdict=verdict,
        accumulator=accumulator,
        tier=decision.tier,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
        model_reasoner=model_reasoner,
        validation_flag=validation_flag,
        cold_start=cold_start,
    )


# === Reasoner with retry ==================================================


async def _reason_with_retry(
    *,
    llm: LLMClient,
    messages: list[Message],
    accumulator: EvidenceAccumulator,
    correlation_id: str,
    log: structlog.stdlib.BoundLogger,
) -> ReasonerResult | None:
    """Call the Reasoner, validate, retry once on failure.

    Returns the valid ``ReasonerResult``, or ``None`` if both attempts fail.
    """
    reasoner = Reasoner(llm)

    # First attempt
    try:
        result = await reasoner.reason(
            messages=messages, correlation_id=correlation_id
        )
    except Exception:
        log.warning("pipeline.reasoner.failed", attempt=1)
        return None

    validation = validate_citations(
        result.output.rationale,
        accumulator,
        cited_evidence_ids=result.output.cited_evidence_ids,
    )
    if validation.passed:
        return result

    log.warning(
        "pipeline.validation.failed",
        attempt=1,
        reason=validation.reason,
        details=validation.details,
    )

    # Corrective retry
    corrective = build_corrective_messages(
        prior_messages=messages,
        prior_response=result.raw_text,
        validation_reason=validation.reason,
        validation_details=str(validation.details),
    )
    try:
        result2 = await reasoner.reason(
            messages=corrective, correlation_id=f"{correlation_id}:retry"
        )
    except Exception:
        log.warning("pipeline.reasoner.failed", attempt=2)
        return None

    validation2 = validate_citations(
        result2.output.rationale,
        accumulator,
        cited_evidence_ids=result2.output.cited_evidence_ids,
    )
    if validation2.passed:
        return result2

    log.warning(
        "pipeline.validation.failed",
        attempt=2,
        reason=validation2.reason,
        details=validation2.details,
    )
    return None


# === Helpers ==============================================================


def _fallback_output() -> ReasonerOutput:
    """Degraded verdict when the Reasoner fails twice."""
    return ReasonerOutput(
        risk_tier="LOW",
        recommendation="NO_RECOMMENDATION",
        rationale=(
            "ModPilot was unable to produce a recommendation for this report. "
            "The evidence has been collected and is available for review [ev-1]."
        ),
        top_evidence_ids=["ev-1"],
        raw_confidence=0.0,
        cited_evidence_ids=["ev-1"],
        flags=["reasoner_failed"],
    )


def _extract_rule_match_strength(accumulator: EvidenceAccumulator) -> float:
    """Pull the max similarity from policy_match evidence, or 0.0."""
    for entry in accumulator.successful_entries():
        if entry.tool == "policy_match":
            matches = entry.detail.get("matches")
            if isinstance(matches, list) and matches:
                first = matches[0]
                if isinstance(first, dict) and "similarity" in first:
                    return float(first["similarity"])
    return 0.0


def _extract_evidence_signals(accumulator: EvidenceAccumulator) -> list[float]:
    """Build a list of tool-level signal strengths for convergence scoring."""
    signals: list[float] = []
    for entry in accumulator.successful_entries():
        detail = entry.detail
        # policy_match: use top similarity
        if entry.tool == "policy_match":
            matches = detail.get("matches")
            if isinstance(matches, list) and matches:
                first = matches[0]
                if isinstance(first, dict):
                    signals.append(float(first.get("similarity", 0.0)))
            else:
                signals.append(0.0)
        # report_velocity: normalize z_score (cap at 1.0)
        elif entry.tool == "report_velocity":
            raw_z = detail.get("z_score", 0.0)
            z = float(str(raw_z))
            signals.append(min(abs(z) / 5.0, 1.0))  # z=5 → 1.0
        else:
            # Generic: 0.5 for any successful tool without a numeric signal
            signals.append(0.5)
    return signals


def _build_timeline(accumulator: EvidenceAccumulator) -> list[TimelineStep]:
    """Convert Evidence Accumulator entries to timeline steps."""
    steps: list[TimelineStep] = []
    for entry in accumulator.entries():
        steps.append(
            TimelineStep(
                tool=entry.tool,
                verb=_TOOL_VERBS.get(entry.tool, f"Ran {entry.tool}"),
                status=entry.status,
                latency_ms=entry.latency_ms,
                evidence_ids=[entry.id],
            )
        )
    return steps


def _build_top_evidence(
    accumulator: EvidenceAccumulator,
    top_ids: list[str],
) -> list[EvidenceRow]:
    """Select top evidence rows by the Reasoner's top_evidence_ids."""
    rows: list[EvidenceRow] = []
    for ev_id in top_ids:
        entry = accumulator.by_id(ev_id)
        if entry is not None:
            rows.append(
                EvidenceRow(
                    id=entry.id,
                    summary=entry.summary,
                    tool=entry.tool,
                )
            )
    return rows[:3]


# === Result type ==========================================================


@dataclass(frozen=True)
class PipelineResult:
    """Everything the API handler needs to build the response + persist."""

    verdict: Verdict
    accumulator: EvidenceAccumulator
    tier: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    model_reasoner: str = ""
    validation_flag: bool = False
    cold_start: bool = False
