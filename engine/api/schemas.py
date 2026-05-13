"""Wire schemas for /investigate, /feedback, /explain.

Spec: docs/Specs.md §10, docs/08-API.md.
Pydantic v2. These models are the contract between Devvit and the Engine —
any change requires the docs sync from docs/14-Engineering.md §7.8.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003 — Pydantic needs runtime type to build schema
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# === Enums (mirror docs/Glossary.md §4-§5) ============================

RiskTier = Literal["HIGH", "MEDIUM", "LOW"]
Recommendation = Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION"]
StrategyTier = Literal["FAST", "STANDARD", "DEEP"]
TargetKind = Literal["comment", "post"]
ToolName = Literal[
    "policy_match",
    "report_velocity",
    "user_history",
    "prior_actions",
    "thread_context",
]
ToolStatus = Literal["success", "failure", "skipped", "timeout"]


# === Request ==========================================================


class InvestigateTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: TargetKind
    id: str = Field(min_length=1)
    body: str = ""
    author: str = ""  # Reddit user id (t2_...) or username; engine normalizes.


class InvestigateReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reasons: list[str] = Field(default_factory=list)
    reporter_count: int = Field(ge=0)
    first_at: datetime | None = None
    last_at: datetime | None = None


class InvestigateContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    thread_id: str = ""
    thread_excerpts: list[str] = Field(default_factory=list)


class InvestigateRequest(BaseModel):
    """POST /investigate request body. Spec: docs/Specs.md §10.2."""

    model_config = ConfigDict(extra="forbid")
    correlation_id: str = Field(min_length=1)
    subreddit_id: str = Field(min_length=1, pattern=r"^t5_")
    target: InvestigateTarget
    report: InvestigateReport
    context: InvestigateContext = Field(default_factory=InvestigateContext)


# === Response — Verdict + components ==================================


class EvidenceRow(BaseModel):
    """One entry from the Evidence Accumulator — surfaces in the Verdict Card."""

    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^ev-\d+$")
    summary: str
    tool: ToolName


class TimelineStep(BaseModel):
    """One row of the Investigation Timeline."""

    model_config = ConfigDict(extra="forbid")
    tool: ToolName
    verb: str  # past-tense UI label from docs/Glossary.md §6
    status: ToolStatus
    latency_ms: int = Field(ge=0)
    evidence_ids: list[str] = Field(default_factory=list)


class ConfidenceBreakdown(BaseModel):
    """The four-input calibration audit trail. Spec: docs/Specs.md §7.6."""

    model_config = ConfigDict(extra="forbid")
    llm_self_report: float = Field(ge=0.0, le=1.0)
    evidence_convergence: float = Field(ge=0.0, le=1.0)
    subreddit_accuracy: float = Field(ge=0.0, le=1.0)
    rule_match_strength: float = Field(ge=0.0, le=1.0)


class Verdict(BaseModel):
    """The full verdict surfaced to the moderator. Spec: docs/Specs.md §10.2."""

    model_config = ConfigDict(extra="forbid")
    correlation_id: str
    tier: StrategyTier
    risk_tier: RiskTier
    recommendation: Recommendation
    calibrated_confidence: float = Field(ge=0.0, le=1.0)
    rationale: str  # contains inline [ev-N] citations per ADR-0003
    top_evidence: list[EvidenceRow] = Field(max_length=3)
    timeline: list[TimelineStep]
    confidence_breakdown: ConfidenceBreakdown
    model_reasoner: str
    model_summarizer: str
    cost_usd: float = Field(ge=0.0)
    latency_ms: int = Field(ge=0)
    validation_flag: bool = False
    degraded: bool = False
    cold_start: bool = False


# === Envelopes (mirror /health success shape) ========================


class InvestigateResponse(BaseModel):
    """Top-level envelope for /investigate. Matches docs/Specs.md §10.2."""

    model_config = ConfigDict(extra="forbid")
    ok: Literal[True] = True
    data: Verdict
