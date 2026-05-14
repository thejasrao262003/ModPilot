"""Personality presets tests — values, lookup, defaults."""

from __future__ import annotations

from personalities.presets import (
    BALANCED,
    LENIENT,
    PRESETS,
    STRICT,
    PersonalityPreset,
    get_preset,
)


class TestPresetValues:
    def test_three_presets_exist(self) -> None:
        assert len(PRESETS) == 3
        assert set(PRESETS.keys()) == {"strict", "balanced", "lenient"}

    def test_all_are_personality_preset(self) -> None:
        for preset in PRESETS.values():
            assert isinstance(preset, PersonalityPreset)

    def test_strict_lower_threshold(self) -> None:
        assert STRICT.confidence_threshold < BALANCED.confidence_threshold

    def test_lenient_higher_threshold(self) -> None:
        assert LENIENT.confidence_threshold > BALANCED.confidence_threshold

    def test_strict_negative_reporter_adjust(self) -> None:
        assert STRICT.deep_reporter_adjust < 0

    def test_lenient_positive_reporter_adjust(self) -> None:
        assert LENIENT.deep_reporter_adjust > 0

    def test_balanced_zero_adjustments(self) -> None:
        assert BALANCED.deep_reporter_adjust == 0
        assert BALANCED.deep_velocity_adjust == 0.0

    def test_prompt_phrasing_non_empty(self) -> None:
        for preset in PRESETS.values():
            assert len(preset.prompt_phrasing) > 0

    def test_names_match_keys(self) -> None:
        for key, preset in PRESETS.items():
            assert preset.name == key


class TestGetPreset:
    def test_known_name(self) -> None:
        assert get_preset("strict") is STRICT
        assert get_preset("balanced") is BALANCED
        assert get_preset("lenient") is LENIENT

    def test_unknown_defaults_balanced(self) -> None:
        assert get_preset("unknown") is BALANCED

    def test_empty_defaults_balanced(self) -> None:
        assert get_preset("") is BALANCED
