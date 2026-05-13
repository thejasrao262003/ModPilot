"""Canned verdict for S-1.3 stub `/investigate` endpoint.

Data ported from mockups/moderator-ui.html (the HIGH-conf REMOVE card) so the
Verdict Card UI in S-1.4 renders the same data the design was prototyped against.
Replaced by the real pipeline in E-2.11.
"""

from __future__ import annotations

from api.schemas import (
    ConfidenceBreakdown,
    EvidenceRow,
    InvestigateRequest,
    TimelineStep,
    Verdict,
)


def canned_verdict(req: InvestigateRequest) -> Verdict:
    """Build a HIGH-conf REMOVE verdict that mirrors the mockup."""
    return Verdict(
        correlation_id=req.correlation_id,
        tier="DEEP",
        risk_tier="HIGH",
        recommendation="REMOVE",
        calibrated_confidence=0.92,
        rationale=(
            "Author has [ev-2] three prior removals in this subreddit. "
            "Thread shows escalation from turn 8 [ev-5]. "
            "Matches Rule 2 [ev-1]. Report velocity confirms the pattern is not "
            "a one-off complaint [ev-4]."
        ),
        top_evidence=[
            EvidenceRow(
                id="ev-4",
                summary="4 reports in 6 min (z=6.2) — far above baseline",
                tool="report_velocity",
            ),
            EvidenceRow(
                id="ev-2",
                summary="Author: 3 prior removals in last 30 days",
                tool="user_history",
            ),
            EvidenceRow(
                id="ev-5",
                summary="Thread escalation detected at turn 8",
                tool="thread_context",
            ),
        ],
        timeline=[
            TimelineStep(
                tool="policy_match",
                verb="Matched against rules",
                status="success",
                latency_ms=142,
                evidence_ids=["ev-1"],
            ),
            TimelineStep(
                tool="report_velocity",
                verb="Checked report velocity",
                status="success",
                latency_ms=23,
                evidence_ids=["ev-4"],
            ),
            TimelineStep(
                tool="user_history",
                verb="Pulled author history",
                status="success",
                latency_ms=87,
                evidence_ids=["ev-2", "ev-3"],
            ),
            TimelineStep(
                tool="thread_context",
                verb="Read thread context",
                status="success",
                latency_ms=1180,
                evidence_ids=["ev-5"],
            ),
        ],
        confidence_breakdown=ConfidenceBreakdown(
            llm_self_report=0.95,
            evidence_convergence=0.88,
            subreddit_accuracy=0.87,
            rule_match_strength=0.96,
        ),
        model_reasoner="gemini-2.5-pro",
        model_summarizer="gemini-2.5-flash",
        cost_usd=0.018,
        latency_ms=1432,
        validation_flag=False,
        degraded=False,
        cold_start=False,
    )
