"""Tests for the Strategy Selector — 100% branch coverage per E-2.6 spec."""

from __future__ import annotations

import time

import pytest

from orchestrator.strategy import (
    StrategyDecision,
    StrategyInputs,
    select_strategy,
)


def _inputs(**overrides: object) -> StrategyInputs:
    """Default-balanced, no-escalation, trusted-user inputs. Override what each test needs."""
    base = {
        "reporter_count": 1,
        "velocity_zscore": 0.0,
        "user_risk_tier": "trusted",
        "rule_match_score": 0.5,
        "personality": "balanced",
        "tier_override": "auto",
        "cold_start": False,
    }
    base.update(overrides)
    return StrategyInputs(**base)  # type: ignore[arg-type]


# === Tier defaults ====================================================


def test_default_is_standard() -> None:
    d = select_strategy(_inputs())
    assert d.tier == "STANDARD"
    assert d.tool_budget == 4
    assert d.time_budget_ms == 3_000
    assert d.cost_budget_usd == 0.012
    assert d.reasoner_required is True


# === Override surface =================================================


@pytest.mark.parametrize(
    ("override", "tier"),
    [("fast", "FAST"), ("standard", "STANDARD"), ("deep", "DEEP")],
)
def test_override_forces_tier(override: str, tier: str) -> None:
    d = select_strategy(_inputs(tier_override=override))
    assert d.tier == tier
    assert "override" in d.rationale


def test_cold_start_floors_fast_override() -> None:
    d = select_strategy(_inputs(tier_override="fast", cold_start=True))
    assert d.tier == "STANDARD"
    assert "cold-start" in d.rationale


def test_cold_start_does_not_floor_deep_override() -> None:
    d = select_strategy(_inputs(tier_override="deep", cold_start=True))
    assert d.tier == "DEEP"


# === DEEP signals =====================================================


def test_deep_when_many_reporters() -> None:
    d = select_strategy(_inputs(reporter_count=4))
    assert d.tier == "DEEP"
    assert "reporter_count" in d.rationale


def test_deep_when_high_velocity() -> None:
    d = select_strategy(_inputs(velocity_zscore=3.5))
    assert d.tier == "DEEP"
    assert "velocity_z" in d.rationale


def test_deep_when_user_watched() -> None:
    d = select_strategy(_inputs(user_risk_tier="watched"))
    assert d.tier == "DEEP"
    assert "watched" in d.rationale


def test_deep_signals_combine_in_rationale() -> None:
    d = select_strategy(
        _inputs(reporter_count=5, velocity_zscore=4.0, user_risk_tier="watched")
    )
    assert d.tier == "DEEP"
    assert "reporter_count" in d.rationale
    assert "velocity_z" in d.rationale
    assert "watched" in d.rationale


# === FAST eligibility =================================================


def test_fast_eligible_when_clear_cut() -> None:
    d = select_strategy(
        _inputs(reporter_count=1, velocity_zscore=0.0, rule_match_score=0.95, user_risk_tier="new")
    )
    assert d.tier == "FAST"
    assert d.tool_budget == 2
    assert d.time_budget_ms == 800
    assert d.cost_budget_usd == 0.003
    assert d.reasoner_required is False


def test_fast_blocked_by_cold_start() -> None:
    """Cold-start mode raises thresholds; FAST is never selected (Specs §12.1)."""
    d = select_strategy(
        _inputs(rule_match_score=0.95, user_risk_tier="trusted", cold_start=True)
    )
    assert d.tier == "STANDARD"


def test_fast_blocked_by_two_reporters() -> None:
    d = select_strategy(_inputs(reporter_count=2, rule_match_score=0.95))
    assert d.tier == "STANDARD"


def test_fast_blocked_by_velocity_above_threshold() -> None:
    d = select_strategy(_inputs(velocity_zscore=0.6, rule_match_score=0.95))
    assert d.tier == "STANDARD"


def test_fast_blocked_by_weak_rule_match() -> None:
    d = select_strategy(_inputs(rule_match_score=0.85))
    assert d.tier == "STANDARD"


def test_fast_blocked_by_neutral_user() -> None:
    d = select_strategy(_inputs(rule_match_score=0.95, user_risk_tier="neutral"))
    assert d.tier == "STANDARD"


# === Personality nudges ===============================================


def test_strict_personality_lowers_reporter_threshold() -> None:
    """In a strict sub, 3 reporters is enough to trip DEEP."""
    d = select_strategy(_inputs(reporter_count=3, personality="strict"))
    assert d.tier == "DEEP"


def test_lenient_personality_raises_reporter_threshold() -> None:
    """In a lenient sub, 4 reporters is *not* enough — needs 5."""
    d = select_strategy(_inputs(reporter_count=4, personality="lenient"))
    assert d.tier == "STANDARD"
    d2 = select_strategy(_inputs(reporter_count=5, personality="lenient"))
    assert d2.tier == "DEEP"


def test_strict_personality_lowers_velocity_threshold() -> None:
    d = select_strategy(_inputs(velocity_zscore=2.5, personality="strict"))
    assert d.tier == "DEEP"


def test_lenient_personality_raises_velocity_threshold() -> None:
    d = select_strategy(_inputs(velocity_zscore=3.5, personality="lenient"))
    assert d.tier == "STANDARD"


# === Budget table integrity ===========================================


@pytest.mark.parametrize(
    ("tier", "tool_budget", "time_budget_ms", "cost_budget_usd", "reasoner"),
    [
        ("FAST", 2, 800, 0.003, False),
        ("STANDARD", 4, 3_000, 0.012, True),
        ("DEEP", 6, 6_000, 0.030, True),
    ],
)
def test_budget_table_matches_specs(
    tier: str, tool_budget: int, time_budget_ms: int, cost_budget_usd: float, reasoner: bool
) -> None:
    """Locks the Specs §7.1 numbers into a test so casual edits get caught."""
    d = select_strategy(_inputs(tier_override=tier.lower()))
    assert d.tier == tier
    assert d.tool_budget == tool_budget
    assert d.time_budget_ms == time_budget_ms
    assert d.cost_budget_usd == cost_budget_usd
    assert d.reasoner_required is reasoner


# === Latency budget ====================================================


def test_select_strategy_under_50ms() -> None:
    """Spec: pure function, <50ms — 1000 calls should fit well under that bound."""
    inputs = _inputs(reporter_count=2, velocity_zscore=1.0)
    started = time.perf_counter()
    for _ in range(1000):
        select_strategy(inputs)
    elapsed_ms = (time.perf_counter() - started) * 1000
    # 1000 calls in << 50ms (single-call budget). Local: ~3-5ms total.
    assert elapsed_ms < 50.0, f"too slow: {elapsed_ms:.2f}ms for 1000 calls"


# === Return type sanity ===============================================


def test_decision_is_frozen() -> None:
    from dataclasses import FrozenInstanceError

    d = select_strategy(_inputs())
    with pytest.raises(FrozenInstanceError):
        d.tier = "DEEP"  # type: ignore[misc]
    assert isinstance(d, StrategyDecision)


def test_override_unknown_value_raises() -> None:
    """Defensive: type-checker forbids bad override strings, but the runtime
    guard catches them anyway if e.g. settings somehow get a stale value."""
    from orchestrator.strategy import _override_tier

    with pytest.raises(ValueError, match="unsupported override"):
        _override_tier("nonsense")  # type: ignore[arg-type]


# === I-3.9: thread_escalated cached signal ============================


def test_thread_escalated_lowers_reporter_threshold() -> None:
    """On a balanced sub, 3 reporters is below DEEP — *unless* the thread
    has known prior escalation, which drops the threshold from 4 to 3."""
    not_escalated = select_strategy(_inputs(reporter_count=3, thread_escalated=False))
    assert not_escalated.tier == "STANDARD"
    escalated = select_strategy(_inputs(reporter_count=3, thread_escalated=True))
    assert escalated.tier == "DEEP"
    assert "reporter_count" in escalated.rationale


def test_thread_escalated_lowers_velocity_threshold() -> None:
    not_escalated = select_strategy(_inputs(velocity_zscore=2.5, thread_escalated=False))
    assert not_escalated.tier == "STANDARD"
    escalated = select_strategy(_inputs(velocity_zscore=2.5, thread_escalated=True))
    assert escalated.tier == "DEEP"
    assert "velocity_z" in escalated.rationale


def test_thread_escalated_stacks_with_strict_personality() -> None:
    """strict (-1) + thread_escalated (-1) = reporter threshold 2."""
    d = select_strategy(
        _inputs(reporter_count=2, personality="strict", thread_escalated=True)
    )
    assert d.tier == "DEEP"


def test_thread_escalated_plus_user_risk_triggers_deep_alone() -> None:
    """Even at quiet baseline (1 reporter, z=0), a watched/neutral user on
    a known-escalating thread is DEEP. Captures the 'context-aware'
    investigation thesis from docs/Specs.md §1.2."""
    for tier in ("neutral", "watched"):
        d = select_strategy(
            _inputs(
                reporter_count=1,
                velocity_zscore=0.0,
                user_risk_tier=tier,
                thread_escalated=True,
            )
        )
        assert d.tier == "DEEP", f"user_risk_tier={tier}"
        assert "thread_escalated+user_risk" in d.rationale


def test_thread_escalated_plus_new_user_does_not_force_deep() -> None:
    """A new user on an escalating thread isn't automatically DEEP — needs
    a confirming velocity / reporter signal. Avoids false-positives on
    newcomers who happened to land in a contentious thread."""
    d = select_strategy(
        _inputs(reporter_count=1, velocity_zscore=0.0, user_risk_tier="new", thread_escalated=True)
    )
    # No combined signal triggered, default branch wins.
    assert d.tier == "STANDARD"


def test_thread_escalated_vetoes_fast() -> None:
    """A target that would otherwise hit FAST (single report, clear rule
    match, trusted user) is bumped to STANDARD when the thread is known
    to be escalating — we want the Reasoner's review, not a shortcut."""
    base_inputs: dict[str, object] = {
        "reporter_count": 1,
        "velocity_zscore": 0.0,
        "rule_match_score": 0.95,
        "user_risk_tier": "trusted",
    }
    fast = select_strategy(_inputs(**base_inputs, thread_escalated=False))
    assert fast.tier == "FAST"
    no_fast = select_strategy(_inputs(**base_inputs, thread_escalated=True))
    assert no_fast.tier == "STANDARD"


def test_thread_escalated_default_is_false() -> None:
    """Backwards-compat: existing callers that don't set thread_escalated
    keep working as before."""
    d = select_strategy(_inputs())
    assert d.tier == "STANDARD"  # same default behaviour
