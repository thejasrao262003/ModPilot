"""Strategy Selector — picks an investigation tier from cheap signals.

Pure function. Sub-50ms latency budget. Spec: docs/Specs.md §7.1,
docs/04-InvestigationEngine.md §2.

Decision order:
  1. Moderator `tier_override` setting (escape hatch). Cold-start floors
     a FAST override up to STANDARD per docs/05-Memory.md §cold-start.
  2. DEEP escalation signals — any one trips DEEP. Personality nudges
     the thresholds: strict subs escalate sooner, lenient subs later.
  3. FAST shortcut — only when *every* signal says "obvious, low-risk."
  4. Otherwise STANDARD.

Budgets are pinned in Specs §7.1; the open question of "STANDARD = 4 or 5
tools" defaults to 4 here and will be revisited via ADR.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from store.types import Personality, StrategyTier, TierOverride, UserRiskTier


# === Inputs / decision dataclasses =====================================


@dataclass(frozen=True)
class StrategyInputs:
    """Everything the selector needs. Built by the orchestrator from the
    report payload + cached subreddit profile + a cheap rule-match precheck."""

    reporter_count: int
    velocity_zscore: float
    user_risk_tier: UserRiskTier
    rule_match_score: float  # 0..1 — how strongly the precheck embedding matched a rule
    personality: Personality = "balanced"
    tier_override: TierOverride = "auto"
    cold_start: bool = False


@dataclass(frozen=True)
class StrategyDecision:
    tier: StrategyTier
    tool_budget: int
    time_budget_ms: int
    cost_budget_usd: float
    reasoner_required: bool
    rationale: str  # plain English; surfaced in logs + investigation audit


# === Budgets — Specs §7.1 ==============================================


@dataclass(frozen=True)
class _Budget:
    tool_budget: int
    time_budget_ms: int
    cost_budget_usd: float
    reasoner_required: bool


_BUDGETS: dict[str, _Budget] = {
    "FAST": _Budget(2, 800, 0.003, reasoner_required=False),
    "STANDARD": _Budget(4, 3_000, 0.012, reasoner_required=True),
    "DEEP": _Budget(6, 6_000, 0.030, reasoner_required=True),
}


# === Thresholds ========================================================

_DEEP_REPORTER_COUNT_DEFAULT = 4
_DEEP_VELOCITY_Z_DEFAULT = 3.0
_FAST_RULE_MATCH = 0.9
_FAST_VELOCITY_Z = 0.5


# === Public API ========================================================


def select_strategy(inputs: StrategyInputs) -> StrategyDecision:
    # 1. Moderator override.
    if inputs.tier_override != "auto":
        forced = _override_tier(inputs.tier_override)
        if inputs.cold_start and forced == "FAST":
            return _decision("STANDARD", "cold-start floors FAST override -> standard")
        return _decision(forced, f"override -> {forced.lower()}")

    # 2. DEEP escalation signals.
    deep_signals = _deep_signals(inputs)
    if deep_signals:
        return _decision("DEEP", "; ".join(deep_signals))

    # 3. FAST shortcut. Cold-start always vetoes FAST per Specs §12.1.
    if _fast_eligible(inputs):
        return _decision(
            "FAST", "single report + strong rule match + trusted/new user + no escalation"
        )

    # 4. Default.
    return _decision("STANDARD", "no escalation signals, no fast-shortcut conditions met")


# === Internals =========================================================


def _override_tier(override: TierOverride) -> StrategyTier:
    if override == "fast":
        return "FAST"
    if override == "standard":
        return "STANDARD"
    if override == "deep":
        return "DEEP"
    raise ValueError(f"unsupported override {override!r}")


def _deep_signals(inputs: StrategyInputs) -> list[str]:
    """Returns the human-readable reasons DEEP triggered, or [] if it didn't."""
    threshold_reporters = _DEEP_REPORTER_COUNT_DEFAULT
    threshold_velocity = _DEEP_VELOCITY_Z_DEFAULT
    if inputs.personality == "strict":
        threshold_reporters -= 1
        threshold_velocity -= 1.0
    elif inputs.personality == "lenient":
        threshold_reporters += 1
        threshold_velocity += 1.0

    signals: list[str] = []
    if inputs.reporter_count >= threshold_reporters:
        signals.append(f"reporter_count={inputs.reporter_count}>={threshold_reporters}")
    if inputs.velocity_zscore >= threshold_velocity:
        signals.append(f"velocity_z={inputs.velocity_zscore:.1f}>={threshold_velocity:.1f}")
    if inputs.user_risk_tier == "watched":
        signals.append("user_risk_tier=watched")
    return signals


def _fast_eligible(inputs: StrategyInputs) -> bool:
    if inputs.cold_start:
        return False
    return (
        inputs.reporter_count == 1
        and inputs.velocity_zscore < _FAST_VELOCITY_Z
        and inputs.rule_match_score >= _FAST_RULE_MATCH
        and inputs.user_risk_tier in ("new", "trusted")
    )


def _decision(tier: StrategyTier, rationale: str) -> StrategyDecision:
    b = _BUDGETS[tier]
    return StrategyDecision(
        tier=tier,
        tool_budget=b.tool_budget,
        time_budget_ms=b.time_budget_ms,
        cost_budget_usd=b.cost_budget_usd,
        reasoner_required=b.reasoner_required,
        rationale=rationale,
    )


# Re-export the literal tier names for downstream typing.
__all__ = [
    "StrategyDecision",
    "StrategyInputs",
    "select_strategy",
]


# Catches "added a tier, forgot the budget" at import time.
_TIER_VALUES: tuple[Literal["FAST", "STANDARD", "DEEP"], ...] = ("FAST", "STANDARD", "DEEP")
assert set(_BUDGETS.keys()) == set(_TIER_VALUES), "_BUDGETS must cover every StrategyTier value"
