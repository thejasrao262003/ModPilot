"""Personality presets — three built-in subreddit moderation postures.

Spec: docs/05-Memory.md §6.2, docs/Specs.md §12.2.

Each preset adjusts four axes:
  - Confidence threshold: how high calibrated confidence must be to recommend action
  - Escalation preference: user-level vs thread-level vs contextual
  - Reasoning tone: formal / neutral / conversational (affects LLM prompt)
  - Prompt phrasing: appended to the Reasoner system prompt

Strategy Selector and Calibrator read these values at investigation time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Personality = Literal["strict", "balanced", "lenient"]


@dataclass(frozen=True)
class PersonalityPreset:
    """Immutable personality configuration. One per subreddit."""

    name: Personality
    confidence_threshold: float  # minimum calibrated confidence to recommend action
    escalation_preference: Literal["user", "contextual", "thread"]
    reasoning_tone: Literal["formal", "neutral", "conversational"]
    prompt_phrasing: str
    # Strategy Selector tuning (docs/05-Memory.md §6.1)
    deep_reporter_adjust: int  # added to DEEP reporter count threshold
    deep_velocity_adjust: float  # added to DEEP velocity z-score threshold


STRICT = PersonalityPreset(
    name="strict",
    confidence_threshold=0.50,
    escalation_preference="user",
    reasoning_tone="formal",
    prompt_phrasing=(
        "If the evidence suggests a possible violation, lean toward recommending action. "
        "This subreddit has chosen a strict moderation posture."
    ),
    deep_reporter_adjust=-1,
    deep_velocity_adjust=-1.0,
)

BALANCED = PersonalityPreset(
    name="balanced",
    confidence_threshold=0.60,
    escalation_preference="contextual",
    reasoning_tone="neutral",
    prompt_phrasing=(
        "Recommend action when evidence supports it; recommend no action when evidence is mixed. "
        "Balance protective and lenient considerations."
    ),
    deep_reporter_adjust=0,
    deep_velocity_adjust=0.0,
)

LENIENT = PersonalityPreset(
    name="lenient",
    confidence_threshold=0.75,
    escalation_preference="thread",
    reasoning_tone="conversational",
    prompt_phrasing=(
        "Only recommend action when evidence clearly supports it. "
        "Default to no action when evidence is ambiguous. "
        "This subreddit values openness and tolerates more discussion."
    ),
    deep_reporter_adjust=1,
    deep_velocity_adjust=1.0,
)

PRESETS: dict[Personality, PersonalityPreset] = {
    "strict": STRICT,
    "balanced": BALANCED,
    "lenient": LENIENT,
}


def get_preset(name: str) -> PersonalityPreset:
    """Look up a preset by name. Defaults to balanced for unknown values."""
    if name in PRESETS:
        return PRESETS[name]
    return BALANCED
