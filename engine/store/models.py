"""SQLAlchemy 2.0 ORM models for the engine's Postgres tables.

Spec: docs/Specs.md §9.1, docs/07-DataLayer.md.
Invariant I-7: every persisted row carries `subreddit_id`. Queries that
forget to filter by `subreddit_id` violate the isolation guarantee from
[10-ReliabilityAndSafety.md] and ADR-0004.
"""

from __future__ import annotations

import uuid
from datetime import datetime  # noqa: TC003 — Mapped[] annotations need runtime resolution

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# === Enum value sources (strings, enforced via CheckConstraint). ===

PERSONALITIES = ("strict", "balanced", "lenient")
REGIONS = ("US", "EU", "UK", "IN", "Global")
TIER_OVERRIDES = ("auto", "fast", "standard", "deep")

RISK_TIERS = ("HIGH", "MEDIUM", "LOW")
RECOMMENDATIONS = ("REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION")
STRATEGY_TIERS = ("FAST", "STANDARD", "DEEP")
TARGET_KINDS = ("comment", "post")
TOOL_STATUSES = ("success", "failure", "skipped", "timeout")
INVESTIGATION_STATUSES = ("pending", "completed", "failed")
USER_RISK_TIERS = ("new", "trusted", "neutral", "watched")
FEEDBACK_ACTIONS = ("REMOVE", "APPROVE", "ESCALATE", "LOCK")
FEEDBACK_SOURCES = ("verdict_card", "reddit_native")


def _check(col: str, values: tuple[str, ...], name: str) -> CheckConstraint:
    quoted = ",".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{col} IN ({quoted})", name=name)


# === Tables =====================================================


class SubredditProfile(Base):
    """One row per subreddit install. Per docs/05-Memory.md §personality."""

    __tablename__ = "subreddit_profile"

    subreddit_id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    personality: Mapped[str] = mapped_column(String(16), nullable=False, default="balanced")
    rules: Mapped[str] = mapped_column(Text, default="", nullable=False)
    region: Mapped[str] = mapped_column(String(8), nullable=False, default="Global")
    cold_start_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    calibration_weights: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    show_cost_in_dashboard: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    kill_switch: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tier_override: Mapped[str] = mapped_column(String(16), nullable=False, default="auto")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        _check("personality", PERSONALITIES, "ck_subreddit_profile_personality"),
        _check("region", REGIONS, "ck_subreddit_profile_region"),
        _check("tier_override", TIER_OVERRIDES, "ck_subreddit_profile_tier_override"),
    )


class UserMemory(Base):
    """Per-(subreddit, user) moderation memory. Exposed in UI as a tier label only."""

    __tablename__ = "user_memory"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    subreddit_id: Mapped[str] = mapped_column(
        String(20),
        ForeignKey("subreddit_profile.subreddit_id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[str] = mapped_column(String(20), nullable=False)
    risk_tier: Mapped[str] = mapped_column(String(16), nullable=False, default="new")
    prior_violations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prior_approvals: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    detail: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("subreddit_id", "user_id", name="uq_user_memory_sub_user"),
        Index("ix_user_memory_subreddit", "subreddit_id"),
        Index("ix_user_memory_user", "user_id"),
        _check("risk_tier", USER_RISK_TIERS, "ck_user_memory_risk_tier"),
    )


class Investigation(Base):
    """One row per Engine /investigate call. The audit-trail backbone."""

    __tablename__ = "investigation"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    correlation_id: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    subreddit_id: Mapped[str] = mapped_column(
        String(20),
        ForeignKey("subreddit_profile.subreddit_id", ondelete="CASCADE"),
        nullable=False,
    )
    target_kind: Mapped[str] = mapped_column(String(8), nullable=False)
    target_id: Mapped[str] = mapped_column(String(20), nullable=False)
    target_body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    target_author_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")

    tier: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")

    # Verdict columns — null until reasoner completes
    risk_tier: Mapped[str | None] = mapped_column(String(16), nullable=True)
    recommendation: Mapped[str | None] = mapped_column(String(32), nullable=True)
    calibrated_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence_breakdown: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)

    model_reasoner: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    model_summarizer: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    validation_flag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    degraded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cold_start: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    evidence: Mapped[list[Evidence]] = relationship(
        "Evidence", back_populates="investigation", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_investigation_subreddit", "subreddit_id"),
        Index("ix_investigation_target", "target_id"),
        Index("ix_investigation_correlation", "correlation_id"),
        _check("target_kind", TARGET_KINDS, "ck_investigation_target_kind"),
        _check("tier", STRATEGY_TIERS, "ck_investigation_tier"),
        _check("status", INVESTIGATION_STATUSES, "ck_investigation_status"),
        CheckConstraint(
            "risk_tier IS NULL OR risk_tier IN ('HIGH','MEDIUM','LOW')",
            name="ck_investigation_risk_tier",
        ),
        CheckConstraint(
            "recommendation IS NULL OR recommendation IN "
            "('REMOVE','APPROVE','ESCALATE','LOCK','NO_RECOMMENDATION')",
            name="ck_investigation_recommendation",
        ),
        CheckConstraint(
            "calibrated_confidence IS NULL OR "
            "(calibrated_confidence >= 0 AND calibrated_confidence <= 1)",
            name="ck_investigation_confidence_range",
        ),
    )


class Evidence(Base):
    """Tool results that fed the verdict. Stable `ev-N` ids per investigation."""

    __tablename__ = "evidence"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    investigation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("investigation.id", ondelete="CASCADE"),
        nullable=False,
    )
    subreddit_id: Mapped[str] = mapped_column(String(20), nullable=False)
    evidence_id: Mapped[str] = mapped_column(String(16), nullable=False)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="success")
    summary: Mapped[str] = mapped_column(String(280), nullable=False, default="")
    detail: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False, default=dict)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    investigation: Mapped[Investigation] = relationship("Investigation", back_populates="evidence")

    __table_args__ = (
        UniqueConstraint(
            "investigation_id", "evidence_id", name="uq_evidence_investigation_evid"
        ),
        Index("ix_evidence_investigation", "investigation_id"),
        Index("ix_evidence_subreddit", "subreddit_id"),
        _check("status", TOOL_STATUSES, "ck_evidence_status"),
    )


class Feedback(Base):
    """Moderator alignment with a verdict. Drives cold-start counter + calibration."""

    __tablename__ = "feedback"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    correlation_id: Mapped[str] = mapped_column(String(80), nullable=False)
    subreddit_id: Mapped[str] = mapped_column(String(20), nullable=False)
    target_id: Mapped[str] = mapped_column(String(20), nullable=False)
    mod_action: Mapped[str] = mapped_column(String(16), nullable=False)
    raw_action: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    moderator_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    moderator_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    aligned: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_feedback_correlation", "correlation_id"),
        Index("ix_feedback_subreddit", "subreddit_id"),
        Index("ix_feedback_target", "target_id"),
        _check("mod_action", FEEDBACK_ACTIONS, "ck_feedback_mod_action"),
        _check("source", FEEDBACK_SOURCES, "ck_feedback_source"),
    )


class AuditLog(Base):
    """Immutable event log. Append-only; 90d retention per docs/Specs.md §13.3."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    subreddit_id: Mapped[str] = mapped_column(String(20), nullable=False)
    correlation_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    actor: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    detail: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_audit_log_subreddit_time", "subreddit_id", "created_at"),
        Index("ix_audit_log_correlation", "correlation_id"),
        Index("ix_audit_log_event_type", "event_type"),
    )
