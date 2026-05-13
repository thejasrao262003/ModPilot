"""Confidence Calibrator — weighted blend of 4 signals + conditional demotions.

Spec: docs/04-InvestigationEngine.md §9, docs/Specs.md §7.6.

The Calibrator is a pure function.  It takes the Reasoner's raw confidence
plus three additional signals, blends them, applies conditional demotions,
and returns a calibrated confidence with tier assignment.

Weights are MVP starting values — tunable via eval harness, never
hardcoded in branches.  When ``personalities/presets.py`` lands they
will move there.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# === Weights (MVP defaults, per §9.4) ====================================

W_LLM = 0.25
W_EVIDENCE = 0.30
W_ACCURACY = 0.20
W_RULE_MATCH = 0.25

# LLM overconfidence discount: compresses self-report toward 0.5.
# Formula: 0.5 + (raw - 0.5) * LLM_DISCOUNT_FACTOR
LLM_DISCOUNT_FACTOR = 0.4

# Conditional demotion multipliers.
DEMOTION_VALIDATION_FAILED = 0.6
DEMOTION_PARTIAL = 0.8
DEMOTION_COLD_START = 0.85

# Tier boundaries (§9.3).
TIER_HIGH = 0.85
TIER_MEDIUM = 0.60

ConfidenceTier = Literal["HIGH", "MEDIUM", "LOW"]


# === Types ================================================================


@dataclass(frozen=True)
class CalibrationInputs:
    """The six signals fed to the Calibrator."""

    llm_self_report: float        # 0.0-1.0, from Reasoner raw_confidence
    evidence_convergence: float   # 0.0-1.0, agreement across tool outputs
    subreddit_accuracy: float     # 0.0-1.0, 30-day acceptance rate
    rule_match_strength: float    # 0.0-1.0, max similarity from policy_match
    validation_passed: bool
    cold_start: bool
    is_partial: bool


@dataclass(frozen=True)
class CalibrationResult:
    """Output of the Calibrator — calibrated confidence + audit trail."""

    calibrated_confidence: float  # 0.0-1.0
    tier: ConfidenceTier
    # The four primary signals (pre-weighting) for the UI breakdown.
    llm_self_report: float
    evidence_convergence: float
    subreddit_accuracy: float
    rule_match_strength: float


# === Public API ===========================================================


def calibrate(inputs: CalibrationInputs) -> CalibrationResult:
    """Compute calibrated confidence from the 4 weighted signals + demotions.

    Pure function — no I/O, no side-effects.
    """
    # 1. Discount the LLM's self-report (LLMs are overconfident).
    llm_signal = 0.5 + (inputs.llm_self_report - 0.5) * LLM_DISCOUNT_FACTOR

    # 2. Weighted blend of the four primary signals.
    base = (
        W_LLM * llm_signal
        + W_EVIDENCE * inputs.evidence_convergence
        + W_ACCURACY * inputs.subreddit_accuracy
        + W_RULE_MATCH * inputs.rule_match_strength
    )

    # 3. Conditional demotions (multiplicative, stackable).
    if not inputs.validation_passed:
        base *= DEMOTION_VALIDATION_FAILED
    if inputs.is_partial:
        base *= DEMOTION_PARTIAL
    if inputs.cold_start:
        base *= DEMOTION_COLD_START

    # 4. Clamp to [0, 1].
    base = max(0.0, min(1.0, base))

    return CalibrationResult(
        calibrated_confidence=round(base, 4),
        tier=_tier_for(base),
        llm_self_report=inputs.llm_self_report,
        evidence_convergence=inputs.evidence_convergence,
        subreddit_accuracy=inputs.subreddit_accuracy,
        rule_match_strength=inputs.rule_match_strength,
    )


def _tier_for(confidence: float) -> ConfidenceTier:
    if confidence >= TIER_HIGH:
        return "HIGH"
    if confidence >= TIER_MEDIUM:
        return "MEDIUM"
    return "LOW"


def compute_evidence_convergence(
    tool_signals: list[float],
) -> float:
    """Derive evidence convergence from individual tool-level signal strengths.

    Simple average of tool signals (each in 0-1).  Returns 0.0 when no
    signals are provided.  A future iteration may use agreement-weighted
    schemes.
    """
    if not tool_signals:
        return 0.0
    return sum(tool_signals) / len(tool_signals)
