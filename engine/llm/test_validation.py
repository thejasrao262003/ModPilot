"""Citation validator tests — 100% coverage target (load-bearing per ADR-0003)."""

from __future__ import annotations

import pytest

from llm.validation import (
    ValidationResult,
    contains_ev_reference,
    is_substantive,
    parse_ev_references,
    split_sentences,
    uncited_substantive_sentences,
    validate_citations,
)
from orchestrator.tools import EvidenceAccumulator, ToolResult

# === Helpers =============================================================


def _result(
    tool: str = "policy_match",
    status: str = "success",
    summary: str = "ok",
) -> ToolResult:
    return ToolResult(
        tool=tool,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        summary=summary,
        latency_ms=10,
    )


def _acc(*results: ToolResult) -> EvidenceAccumulator:
    acc = EvidenceAccumulator()
    for r in results:
        acc.append(r)
    return acc


def _acc_3_success() -> EvidenceAccumulator:
    """Standard 3-entry accumulator: ev-1, ev-2, ev-3 all success."""
    return _acc(
        _result("policy_match", summary="rule matched"),
        _result("report_velocity", summary="3 reports in 5min"),
        _result("user_history", summary="2 prior violations"),
    )


# === parse_ev_references =================================================


class TestParseEvReferences:
    def test_single_reference(self) -> None:
        assert parse_ev_references("violated rule [ev-1]") == {"ev-1"}

    def test_multiple_references(self) -> None:
        text = "matched [ev-1] and history [ev-3] shows pattern [ev-2]"
        assert parse_ev_references(text) == {"ev-1", "ev-2", "ev-3"}

    def test_duplicate_references_deduplicated(self) -> None:
        text = "per [ev-1] and again [ev-1]"
        assert parse_ev_references(text) == {"ev-1"}

    def test_no_references(self) -> None:
        assert parse_ev_references("no citations here") == set()

    def test_empty_string(self) -> None:
        assert parse_ev_references("") == set()

    def test_malformed_not_matched(self) -> None:
        assert parse_ev_references("[ev-] [ev-abc] ev-1 [EV-1]") == set()

    def test_high_ids(self) -> None:
        assert parse_ev_references("[ev-42] [ev-100]") == {"ev-42", "ev-100"}

    def test_adjacent_references(self) -> None:
        assert parse_ev_references("[ev-1][ev-2]") == {"ev-1", "ev-2"}


# === split_sentences ======================================================


class TestSplitSentences:
    def test_basic_split(self) -> None:
        text = "First sentence. Second sentence. Third one."
        assert split_sentences(text) == [
            "First sentence.",
            "Second sentence.",
            "Third one.",
        ]

    def test_question_and_exclamation(self) -> None:
        text = "Is this spam? Yes it is! Clearly."
        result = split_sentences(text)
        assert len(result) == 3

    def test_single_sentence(self) -> None:
        assert split_sentences("Just one.") == ["Just one."]

    def test_empty_string(self) -> None:
        assert split_sentences("") == []

    def test_preserves_ev_references(self) -> None:
        text = "Matched rule [ev-1]. History shows [ev-2]."
        sentences = split_sentences(text)
        assert any("[ev-1]" in s for s in sentences)
        assert any("[ev-2]" in s for s in sentences)


# === is_substantive =======================================================


class TestIsSubstantive:
    def test_factual_claim_is_substantive(self) -> None:
        assert is_substantive("Author has 3 prior removals in this subreddit") is True

    def test_framing_not_substantive(self) -> None:
        assert is_substantive("In summary, the evidence shows:") is False
        assert is_substantive("Based on the above, we conclude:") is False
        assert is_substantive("Overall, the analysis indicates:") is False
        assert is_substantive("In conclusion, this is clear.") is False
        assert is_substantive("To summarize, the pattern holds.") is False
        assert is_substantive("Given the above, removal is warranted.") is False
        assert is_substantive("Considering the evidence, this is clear.") is False

    def test_recommendation_not_substantive(self) -> None:
        assert is_substantive("Recommend: Remove this content.") is False
        assert is_substantive("Verdict: REMOVE") is False
        assert is_substantive("Action: Escalate to senior mod.") is False
        assert is_substantive("Suggestion: lock the thread.") is False

    def test_short_fragment_not_substantive(self) -> None:
        assert is_substantive("REMOVE") is False
        assert is_substantive("High risk.") is False
        assert is_substantive("See above.") is False
        assert is_substantive("No match found.") is False

    def test_six_word_sentence_is_substantive(self) -> None:
        assert is_substantive("The author posted spam three times") is True

    def test_case_insensitive_framing(self) -> None:
        assert is_substantive("IN SUMMARY, the evidence is clear.") is False
        assert is_substantive("BASED ON THE ABOVE, remove it.") is False


# === contains_ev_reference ================================================


class TestContainsEvReference:
    def test_has_reference(self) -> None:
        assert contains_ev_reference("history shows [ev-2]") is True

    def test_no_reference(self) -> None:
        assert contains_ev_reference("no citation here") is False

    def test_multiple_references(self) -> None:
        assert contains_ev_reference("[ev-1] and [ev-3]") is True


# === uncited_substantive_sentences ========================================


class TestUncitedSubstantiveSentences:
    def test_all_cited_returns_empty(self) -> None:
        text = "Author has 3 violations [ev-1]. Thread is heated [ev-2]."
        assert uncited_substantive_sentences(text) == []

    def test_uncited_claim_returned(self) -> None:
        text = (
            "Author has 3 violations [ev-1]. "
            "The content is clearly toxic and harmful to the community."
        )
        result = uncited_substantive_sentences(text)
        assert len(result) == 1
        assert "clearly toxic" in result[0]

    def test_framing_without_citation_ok(self) -> None:
        text = "In summary, the evidence is clear. Author violated rules [ev-1]."
        assert uncited_substantive_sentences(text) == []

    def test_recommendation_without_citation_ok(self) -> None:
        text = "Author has history [ev-1]. Recommend: Remove."
        assert uncited_substantive_sentences(text) == []

    def test_short_fragment_without_citation_ok(self) -> None:
        text = "Author has history [ev-1]. High risk."
        assert uncited_substantive_sentences(text) == []


# === ValidationResult =====================================================


class TestValidationResult:
    def test_ok(self) -> None:
        r = ValidationResult.ok()
        assert r.passed is True
        assert r.reason == ""

    def test_failed(self) -> None:
        r = ValidationResult.failed("bad", ids=["ev-99"])
        assert r.passed is False
        assert r.reason == "bad"
        assert r.details == {"ids": ["ev-99"]}

    def test_frozen(self) -> None:
        r = ValidationResult.ok()
        with pytest.raises(AttributeError):
            r.passed = False  # type: ignore[misc]


# === validate_citations (integration) =====================================


class TestValidateCitations:
    def test_valid_rationale_passes(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has 3 prior violations in this subreddit [ev-3]. "
            "Report velocity is elevated at 3 in 5 min [ev-2]. "
            "Content matches Rule 2 against personal attacks [ev-1]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is True

    def test_empty_rationale_fails(self) -> None:
        result = validate_citations("", _acc_3_success())
        assert result.passed is False
        assert result.reason == "empty_rationale"

    def test_whitespace_rationale_fails(self) -> None:
        result = validate_citations("   \n  ", _acc_3_success())
        assert result.passed is False
        assert result.reason == "empty_rationale"

    def test_no_citations_fails(self) -> None:
        rationale = "The author has a long history of violations and should be removed."
        result = validate_citations(rationale, _acc_3_success())
        assert result.passed is False
        assert result.reason == "no_citations"

    def test_hallucinated_id_fails(self) -> None:
        acc = _acc_3_success()  # has ev-1, ev-2, ev-3
        rationale = (
            "Author has violations [ev-1] and thread context [ev-7] is concerning. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "hallucinated_evidence_ids"
        assert "ev-7" in result.details["ids"]  # type: ignore[operator]

    def test_citing_failure_evidence_fails(self) -> None:
        acc = _acc(
            _result("policy_match", status="success", summary="matched"),
            _result("user_history", status="failure", summary="db error"),
        )
        rationale = (
            "Rule matched against personal attacks [ev-1]. "
            "User history shows concerning pattern [ev-2]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "cited_non_success_evidence"
        assert "ev-2" in result.details["ids"]  # type: ignore[operator]

    def test_citing_timeout_evidence_fails(self) -> None:
        acc = _acc(
            _result("policy_match", status="success"),
            _result("thread_context", status="timeout", summary="slow"),
        )
        rationale = (
            "Rule matched [ev-1]. Thread context timed out but shows [ev-2]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "cited_non_success_evidence"

    def test_citing_skipped_evidence_fails(self) -> None:
        acc = _acc(
            _result("policy_match", status="success"),
            _result("prior_actions", status="skipped"),
        )
        rationale = (
            "Rule matched [ev-1]. Prior actions show pattern [ev-2]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "cited_non_success_evidence"

    def test_uncited_claim_fails(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has 3 prior violations [ev-3]. "
            "The content is clearly toxic and harmful to the community."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "uncited_claims"

    def test_cited_field_mismatch_fails(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has violations [ev-3]. "
            "Content matches rules [ev-1]. "
            "Recommend: Remove."
        )
        # Declare ev-2 but it's not in the rationale
        result = validate_citations(
            rationale, acc, cited_evidence_ids=["ev-1", "ev-2", "ev-3"]
        )
        assert result.passed is False
        assert result.reason == "cited_field_mismatch"

    def test_cited_field_match_passes(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has violations [ev-3]. "
            "Content matches rules [ev-1]. "
            "Recommend: Remove."
        )
        result = validate_citations(
            rationale, acc, cited_evidence_ids=["ev-1", "ev-3"]
        )
        assert result.passed is True

    def test_cited_field_none_skips_check(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has violations [ev-3]. "
            "Content matches rules [ev-1]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc, cited_evidence_ids=None)
        assert result.passed is True

    def test_framing_sentences_dont_need_citations(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has 3 prior violations [ev-3]. "
            "Report velocity is elevated [ev-2]. "
            "In summary, the evidence clearly supports removal. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is True

    def test_short_fragments_dont_need_citations(self) -> None:
        acc = _acc_3_success()
        rationale = (
            "Author has 3 prior violations [ev-3]. "
            "High risk. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is True

    def test_multiple_hallucinated_ids_all_reported(self) -> None:
        acc = _acc(_result("policy_match"))  # only ev-1
        rationale = (
            "Rule matched [ev-1] and history [ev-5] with context [ev-9]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is False
        assert result.reason == "hallucinated_evidence_ids"
        ids = result.details["ids"]
        assert "ev-5" in ids  # type: ignore[operator]
        assert "ev-9" in ids  # type: ignore[operator]

    def test_single_entry_accumulator_valid(self) -> None:
        acc = _acc(_result("policy_match", summary="matched rule"))
        rationale = (
            "Content clearly violates the no-spam rule [ev-1]. "
            "Recommend: Remove."
        )
        result = validate_citations(rationale, acc)
        assert result.passed is True

    def test_failure_reason_priority_hallucinated_before_uncited(self) -> None:
        """Hallucinated IDs are checked before uncited claims."""
        acc = _acc(_result("policy_match"))  # ev-1 only
        rationale = (
            "Rule matched [ev-99]. "  # hallucinated
            "Author has a pattern of abuse."  # uncited
        )
        result = validate_citations(rationale, acc)
        assert result.reason == "hallucinated_evidence_ids"
