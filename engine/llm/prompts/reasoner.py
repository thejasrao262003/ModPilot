"""Reasoner prompt v1.0 — produces a moderation recommendation from evidence.

Spec: docs/06-AILayer.md §4.2, docs/Specs.md §7.5 + §8.3.

The Reasoner is the single LLM call in the investigation pipeline.  It
consumes the Evidence Accumulator's successful entries and produces a
structured JSON recommendation with inline ``[ev-N]`` citations.

Temperature is fixed at 0.0 (deterministic).  The response is validated
by the citation validator (``engine/llm/validation.py``, ADR-0003) before
being accepted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

from llm.client import LLMClient, Message, Role

if TYPE_CHECKING:
    from orchestrator.tools import EvidenceAccumulator, EvidenceEntry

# === Response schema =====================================================

Recommendation = Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION"]
RiskTier = Literal["HIGH", "MEDIUM", "LOW"]


class ReasonerOutput(BaseModel):
    """Structured JSON output from the Reasoner LLM call.

    Validated post-generation by ``validate_citations()`` in
    ``engine/llm/validation.py``.
    """

    risk_tier: RiskTier
    recommendation: Recommendation
    rationale: str = Field(min_length=20, max_length=600)
    top_evidence_ids: list[str] = Field(max_length=3)
    raw_confidence: float = Field(ge=0.0, le=1.0)
    cited_evidence_ids: list[str]
    flags: list[str] = Field(default_factory=list)


# === Reasoner result =====================================================


@dataclass(frozen=True)
class ReasonerResult:
    """Parsed Reasoner output + LLM call metadata."""

    output: ReasonerOutput
    raw_text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int


# === Prompt template =====================================================

PROMPT_VERSION = "v1.0"

SYSTEM_PROMPT = """\
You are ModPilot's investigation Reasoner. Your role is to produce a moderation \
recommendation for a Reddit moderator based on accumulated evidence from an \
investigation.

You do not take actions. You make recommendations. The moderator decides.

CRITICAL CONSTRAINTS:

1. CITATION CONTRACT. Every factual claim in your rationale must cite an \
evidence ID in the format [ev-N], where N matches an evidence row provided \
in the Evidence Block. Unsupported claims are bugs and will fail validation.

2. NO INVENTED FACTS. You may only reason from evidence that appears in the \
Evidence Block. If evidence is insufficient or contradictory, say so and \
recommend NO_RECOMMENDATION with appropriately low confidence.

3. NO IDENTITIES. The Evidence Block uses anonymized references. Use those \
references in your rationale. Do not invent usernames or real-world identities.

4. PERSONALITY-AWARE. The subreddit's moderation personality affects when \
to recommend action versus no action:
   - Strict: lower threshold for removal, prioritize community safety.
   - Balanced: weigh evidence fairly, recommend action only with clear signals.
   - Lenient: higher threshold for removal, give benefit of the doubt.

5. CALIBRATED CONFIDENCE. Report raw_confidence in [0.0, 1.0]. This number \
will be combined with other signals downstream — it is not the final \
confidence shown to the moderator. Be honest. Low confidence is preferred \
over false certainty.

6. RISK TIER. Assign HIGH / MEDIUM / LOW based on the severity of the \
potential violation and strength of evidence:
   - HIGH: clear violation with strong corroborating evidence.
   - MEDIUM: probable violation but evidence is mixed or incomplete.
   - LOW: unlikely violation, or evidence is too weak to act on.

Your output must conform to the provided JSON schema. No prose outside it.
"""

_USER_TEMPLATE = """\
## Subreddit Context
Personality: {personality}
Region: {region}
Active rules:
{rules}

## Report Summary
Target: {target_kind} {target_id}
Reporter count: {reporter_count}

## Evidence Block
{evidence_block}

## Investigation State
Tier: {tier}
Tools run: {tools_run}
Partial investigation: {is_partial}
Cold-start: {cold_start}

Produce your recommendation as a JSON object conforming to the schema.\
"""


# === Prompt builder ======================================================


def serialize_evidence(entries: list[EvidenceEntry]) -> str:
    """Render evidence entries as a text block for the LLM prompt.

    Only success-status entries should be passed (the Reasoner must not cite
    failures, and the validator rejects such citations).
    """
    if not entries:
        return "(no evidence collected)"

    lines: list[str] = []
    for entry in entries:
        detail_str = ", ".join(
            f"{k}={v}" for k, v in sorted(entry.detail.items())
        )
        lines.append(
            f"[{entry.id}] {entry.tool}: {entry.summary}"
            + (f" ({detail_str})" if detail_str else "")
        )
    return "\n".join(lines)


def build_messages(  # noqa: PLR0913
    *,
    accumulator: EvidenceAccumulator,
    personality: str,
    region: str,
    rules: str,
    target_kind: str,
    target_id: str,
    reporter_count: int,
    tier: str,
    tools_run: int,
    is_partial: bool,
    cold_start: bool,
) -> list[Message]:
    """Build the message list for an LLM ``complete()`` call.

    Returns ``[system, user]`` — the Reasoner is a single-turn call.
    """
    evidence_block = serialize_evidence(accumulator.successful_entries())

    user_content = _USER_TEMPLATE.format(
        personality=personality,
        region=region,
        rules=rules if rules.strip() else "(no rules configured)",
        target_kind=target_kind,
        target_id=target_id,
        reporter_count=reporter_count,
        evidence_block=evidence_block,
        tier=tier,
        tools_run=tools_run,
        is_partial=str(is_partial).lower(),
        cold_start=str(cold_start).lower(),
    )

    return [
        Message(role="system", content=SYSTEM_PROMPT),
        Message(role="user", content=user_content),
    ]


CORRECTIVE_SUFFIX = """\

## Validation Error

Your previous response failed citation validation:
Reason: {reason}
Details: {details}

Fix the issues and produce a corrected JSON response. Ensure every factual \
claim in the rationale cites an evidence ID from the Evidence Block, and \
that all cited IDs appear in the Evidence Block.\
"""


def build_corrective_messages(
    *,
    prior_messages: list[Message],
    prior_response: str,
    validation_reason: str,
    validation_details: str,
) -> list[Message]:
    """Build a corrective retry prompt after a validation failure.

    Appends the model's prior response and the validation error as
    additional turns, keeping the original system + user context.
    """
    corrective_user = CORRECTIVE_SUFFIX.format(
        reason=validation_reason,
        details=validation_details,
    )
    return [
        *prior_messages,
        Message(role="assistant", content=prior_response),
        Message(role="user", content=corrective_user),
    ]


# === Reasoner caller =====================================================


class Reasoner:
    """Calls the LLM client with the Reasoner prompt and parses the output.

    This is the thin glue between the prompt template and the LLM client.
    The orchestrator calls ``reason()`` and gets back a ``ReasonerOutput``
    plus cost/latency metadata.  Retry logic lives in the orchestrator
    (E-2.11), not here.
    """

    # Defaults per Specs §7.5; overridable for testing.
    MAX_TOKENS = 1024
    TIMEOUT_MS = 15_000
    TEMPERATURE = 0.0
    THINKING_BUDGET = 512

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    async def reason(
        self,
        *,
        messages: list[Message],
        correlation_id: str,
    ) -> ReasonerResult:
        """Single Reasoner call. Returns parsed output + metadata."""
        response = await self._llm.complete(
            role=Role.REASONER,
            messages=messages,
            response_schema=ReasonerOutput,
            max_tokens=self.MAX_TOKENS,
            temperature=self.TEMPERATURE,
            timeout_ms=self.TIMEOUT_MS,
            correlation_id=correlation_id,
            thinking_budget=self.THINKING_BUDGET,
        )

        if response.parsed is not None and isinstance(response.parsed, ReasonerOutput):
            output = response.parsed
        else:
            output = ReasonerOutput.model_validate_json(response.raw_text)

        return ReasonerResult(
            output=output,
            raw_text=response.raw_text,
            model=response.model,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            cost_usd=response.cost_usd,
            latency_ms=response.latency_ms,
        )
