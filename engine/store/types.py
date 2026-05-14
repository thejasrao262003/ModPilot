"""Pydantic domain types — the shapes business logic reads.

ORM rows live in `store/models.py`; this file is the layer the
Orchestrator / tools / API touch so we never leak SQLAlchemy types
upward. Spec: docs/Specs.md §9.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003 — Pydantic field type needs runtime resolution
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

UserRiskTier = Literal["new", "trusted", "neutral", "watched"]
Personality = Literal["strict", "balanced", "lenient"]
TierOverride = Literal["auto", "fast", "standard", "deep"]
StrategyTier = Literal["FAST", "STANDARD", "DEEP"]
ToolStatus = Literal["success", "failure", "skipped", "timeout"]
InvestigationStatus = Literal["pending", "completed", "failed"]
ModAction = Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK"]
FeedbackSource = Literal["verdict_card", "reddit_native"]


class SubredditProfileRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="ignore")
    subreddit_id: str
    name: str
    personality: Personality = "balanced"
    rules: str = ""
    region: str = "Global"
    cold_start_count: int = 0
    show_cost_in_dashboard: bool = False
    kill_switch: bool = False
    tier_override: TierOverride = "auto"


class UserMemoryRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="ignore")
    subreddit_id: str
    user_id: str
    risk_tier: UserRiskTier = "new"
    prior_violations: int = 0
    prior_approvals: int = 0
    last_seen_at: datetime | None = None
    detail: dict[str, object] = Field(default_factory=dict)


class ThreadMemoryRow(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="ignore")
    subreddit_id: str
    post_id: str
    mod_actions_taken: list[dict[str, object]] = Field(default_factory=list)
    participants_count: int = 0
    last_summary: str = ""
    last_summary_at: datetime | None = None
    detail: dict[str, object] = Field(default_factory=dict)


class StartInvestigationInput(BaseModel):
    """What `start_investigation` needs to create a pending row."""

    model_config = ConfigDict(extra="forbid")
    correlation_id: str
    subreddit_id: str
    target_kind: Literal["comment", "post"]
    target_id: str
    target_body: str = ""
    target_author_id: str = ""
    tier: StrategyTier


class FinalizeInvestigationInput(BaseModel):
    """Verdict fields written when the pipeline completes."""

    model_config = ConfigDict(extra="forbid")
    risk_tier: Literal["HIGH", "MEDIUM", "LOW"]
    recommendation: Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION"]
    calibrated_confidence: float = Field(ge=0.0, le=1.0)
    rationale: str
    confidence_breakdown: dict[str, float]
    model_reasoner: str
    model_summarizer: str
    cost_usd: float = Field(ge=0.0)
    latency_ms: int = Field(ge=0)
    input_tokens: int = 0
    output_tokens: int = 0
    validation_flag: bool = False
    degraded: bool = False
    cold_start: bool = False


class EvidenceRowInput(BaseModel):
    """One Evidence Accumulator entry to persist."""

    model_config = ConfigDict(extra="forbid")
    evidence_id: str = Field(pattern=r"^ev-\d+$")
    tool: str
    summary: str = ""
    detail: dict[str, object] = Field(default_factory=dict)
    status: ToolStatus = "success"
    latency_ms: int = Field(ge=0, default=0)


class FeedbackInput(BaseModel):
    """Mod action alignment — recorded by the verdict-card buttons + onModAction."""

    model_config = ConfigDict(extra="forbid")
    correlation_id: str
    subreddit_id: str
    target_id: str
    mod_action: ModAction
    raw_action: str = ""
    moderator_id: str = ""
    moderator_name: str = ""
    source: FeedbackSource
    aligned: bool | None = None
