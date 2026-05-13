"""Citation validator — enforces ADR-0003 evidence-citation contract.

Spec: docs/06-AILayer.md §5, docs/Specs.md §8.3, docs/04-InvestigationEngine.md §8.5.

Every factual claim in the Reasoner's ``rationale`` must cite at least one
``[ev-N]`` evidence ID that exists in the Evidence Accumulator *and* has
status ``success``.  This module is the **post-generation** enforcement layer
(Layer 2 of the three-layer scheme from ADR-0003).

The validator is a pure function — no I/O, no side-effects.  It takes the
rationale string and the accumulator, and returns a ``ValidationResult``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from orchestrator.tools import EvidenceAccumulator

# === Patterns =============================================================

# Matches [ev-1], [ev-42], etc.
_EV_REF_RE = re.compile(r"\[ev-(\d+)\]")

# Sentence splitter — split on `. `, `! `, `? ` or end-of-string after `.!?`
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")

# Framing / transition phrases that don't need citations.
_FRAMING_PREFIXES = (
    "in summary",
    "based on the above",
    "based on this evidence",
    "overall",
    "in conclusion",
    "to summarize",
    "given the above",
    "taking everything into account",
    "considering the evidence",
)

# Recommendation verbs — sentences that are purely prescriptive, not factual.
_RECOMMENDATION_PATTERNS = re.compile(
    r"^(recommend|suggestion|action|verdict)[:\s]",
    re.IGNORECASE,
)


# === Result types =========================================================


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of citation validation."""

    passed: bool
    reason: str = ""
    details: dict[str, object] = field(default_factory=dict)

    @staticmethod
    def ok() -> ValidationResult:
        return ValidationResult(passed=True)

    @staticmethod
    def failed(reason: str, **details: object) -> ValidationResult:
        return ValidationResult(passed=False, reason=reason, details=dict(details))


# === Public API ===========================================================


def validate_citations(
    rationale: str,
    accumulator: EvidenceAccumulator,
    *,
    cited_evidence_ids: list[str] | None = None,
) -> ValidationResult:
    """Run the full citation contract against a rationale.

    Checks (in order, short-circuits on first failure):
    1. All ``[ev-N]`` references resolve to existing evidence entries.
    2. No cited ID points to a failure/timeout/skipped entry.
    3. Every substantive sentence contains at least one ``[ev-N]``.
    4. If ``cited_evidence_ids`` is provided, it must match the parsed set.

    Parameters
    ----------
    rationale:
        The Reasoner's rationale text with inline ``[ev-N]`` citations.
    accumulator:
        The Evidence Accumulator for this investigation.
    cited_evidence_ids:
        Optional explicit list from the Reasoner's structured output.
        When provided, must match the set parsed from the rationale.
    """
    # --- Early rejections ---
    if not rationale.strip():
        return ValidationResult.failed("empty_rationale")

    refs = parse_ev_references(rationale)
    if not refs:
        return ValidationResult.failed("no_citations", rationale_length=len(rationale))

    # --- ID membership checks (hallucinated → non-success) ---
    failure = _check_ids(refs, accumulator)
    if failure is not None:
        return failure

    # --- Sentence-level + field-match checks ---
    uncited = uncited_substantive_sentences(rationale)
    if uncited:
        return ValidationResult.failed("uncited_claims", sentences=uncited)

    if cited_evidence_ids is not None and set(cited_evidence_ids) != refs:
        return ValidationResult.failed(
            "cited_field_mismatch",
            declared=sorted(set(cited_evidence_ids)),
            parsed=sorted(refs),
        )

    return ValidationResult.ok()


def _check_ids(
    refs: set[str], accumulator: EvidenceAccumulator
) -> ValidationResult | None:
    """Return a failure result if any cited ID is invalid, else None."""
    all_ids = {e.id for e in accumulator.entries()}
    hallucinated = sorted(refs - all_ids)
    if hallucinated:
        return ValidationResult.failed("hallucinated_evidence_ids", ids=hallucinated)

    success_ids = {e.id for e in accumulator.successful_entries()}
    non_success = sorted(refs - success_ids)
    if non_success:
        return ValidationResult.failed("cited_non_success_evidence", ids=non_success)

    return None


# === Parsing helpers (public for direct testing) ==========================


def parse_ev_references(text: str) -> set[str]:
    """Extract all unique ``[ev-N]`` references from *text*.

    Returns a set of strings like ``{"ev-1", "ev-3"}``.
    """
    return {f"ev-{m.group(1)}" for m in _EV_REF_RE.finditer(text)}


def split_sentences(text: str) -> list[str]:
    """Split text into sentences. Keeps non-empty, stripped results."""
    raw = _SENTENCE_RE.split(text)
    return [s.strip() for s in raw if s.strip()]


def is_substantive(sentence: str) -> bool:
    """Return True if *sentence* makes a factual claim that needs a citation.

    Non-substantive sentences:
    - Framing / transition phrases ("In summary:", "Based on the above:")
    - Pure recommendation statements ("Recommend Remove.")
    - Very short fragments (≤5 words) that are typically labels/headers
    """
    lower = sentence.lower().strip().rstrip(".")
    # Framing phrases
    for prefix in _FRAMING_PREFIXES:
        if lower.startswith(prefix):
            return False
    # Recommendation statements
    if _RECOMMENDATION_PATTERNS.match(sentence.strip()):
        return False
    # Very short fragments — likely labels, not claims
    return len(sentence.split()) > 5


def contains_ev_reference(sentence: str) -> bool:
    """Return True if *sentence* contains at least one ``[ev-N]`` token."""
    return bool(_EV_REF_RE.search(sentence))


def uncited_substantive_sentences(rationale: str) -> list[str]:
    """Return substantive sentences that lack any ``[ev-N]`` citation."""
    sentences = split_sentences(rationale)
    return [
        s for s in sentences
        if is_substantive(s) and not contains_ev_reference(s)
    ]
