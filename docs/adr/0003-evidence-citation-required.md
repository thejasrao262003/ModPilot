# ADR 0003: Evidence Citation Required for Every Verdict Claim

Status: Accepted
Date: 2026-05-12

## Context

LLMs hallucinate. They produce plausible-sounding rationales that reference facts the model invented. In a moderation product where every recommendation could result in a removed comment or banned user, hallucinated evidence is unacceptable.

The Investigation Timeline collects concrete, deterministic facts (tool results). The Reasoner produces a rationale. The risk is a Reasoner that writes a confident rationale citing facts that aren't actually in the evidence.

## Decision

Every assertion in the Reasoner's `rationale` field must carry an inline citation in the form `[ev-N]`. The citation must resolve to an evidence ID that was produced by a tool and stored in the Evidence Accumulator for this investigation.

Enforcement is multi-layered:

1. **Prompt instruction.** The Reasoner system prompt explicitly requires citations and shows examples. Located at [`engine/llm/prompts/reasoner.py`](../engine/llm/prompts/reasoner.py).
2. **Response schema.** The Reasoner output is Pydantic-validated; `rationale` must contain at least one `[ev-N]` token; `top_evidence_ids` and `citation_check` must both be populated.
3. **Post-generation validator.** [`engine/llm/validation.py`](../engine/llm/validation.py) parses `rationale` for `[ev-N]` patterns and verifies every cited ID exists in the accumulator AND is listed in `top_evidence_ids`.
4. **Retry policy.** Validation failure triggers one corrective retry with a targeted prompt. A second failure produces a fallback verdict with `validation_flag=true` and an amber UI banner.

Coverage target for `engine/llm/validation.py`: **100%** (load-bearing).

## Consequences

- Every verdict shown in the UI is auditable. The moderator can click an `[ev-N]` chip and jump to the underlying tool result.
- Reasoner prompts are more constrained — less creative rationale writing, more structured citation. This is the right tradeoff for moderation.
- Validator rejects + retries add a small latency budget (one extra LLM call in the worst case). Capped by the orchestrator's time budget per tier.
- The system can never "hallucinate evidence into existence." A rationale that references `[ev-7]` when no `ev-7` exists is structurally impossible to ship.

## Alternatives Considered

- **Trust the model.** Rejected: hallucination rates on factual claims are non-zero, and the cost of one wrong removal exceeds the cost of validation infrastructure.
- **Lightweight regex only, no accumulator check.** Rejected: catches malformed `[ev-N]` syntax but not invented IDs.
- **LLM-as-judge for self-validation.** Rejected: doubles inference cost, slower, and the failure modes of an LLM-judge are correlated with the failure modes of the Reasoner itself.

## Related

- [06-AILayer.md §3.3](../06-AILayer.md) — citation contract details
- [Specs.md §8.3](../Specs.md) — citation contract at higher altitude
- [Specs.md §17](../Specs.md) — acceptance criteria per surface
