"""Summarizer prompt — Gemini 2.5 Flash structured thread summarization.

Spec: docs/06-AILayer.md §2.2, docs/04-InvestigationEngine.md §5.3.5.

The Summarizer condenses a Reddit thread (post + recent comments) into a
fixed structure the Reasoner can cite: conversation arc, escalation turn
(if any), instigator candidates, off-topic flag. Flash with
`thinking_budget=0` per the production insight from F-0.8 — summarization
doesn't benefit from chain-of-thought and we want the call snappy.

Target latency: <1.5s. Cached for 24h under Redis `summary:{thread_id}`.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field

from llm.client import LLMClient, Message, Role

PROMPT_VERSION = "v1.0"


# === Response schema =====================================================


class ThreadSummary(BaseModel):
    """Structured output the Summarizer returns. Matches docs/09-UX.md §9.2."""

    arc: str = Field(min_length=1, max_length=240)
    escalation_turn: int | None = Field(default=None, ge=0)
    instigator_candidates: list[str] = Field(default_factory=list, max_length=5)
    off_topic: bool = False
    total_turns: int = Field(ge=0)


# === Result with LLM metadata ============================================


@dataclass(frozen=True)
class SummarizerResult:
    summary: ThreadSummary
    raw_text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int


# === Prompt ==============================================================


SYSTEM_PROMPT = """\
You summarize a Reddit thread for a moderator. Output exactly the JSON \
schema requested — no prose, no markdown, no preamble.

Field guidance:
- `arc`: one short sentence describing the conversation's shape. Examples:
  "civil debate that stays on topic", "Q&A that becomes a roast",
  "back-and-forth that escalates to personal attacks at turn 8".
- `escalation_turn`: the 0-indexed comment number where tone shifts toward \
hostility, harassment, or rule violation. Null if no escalation.
- `instigator_candidates`: usernames who appear to drive escalation. Empty \
list if no clear instigators.
- `off_topic`: true if the thread substantially drifts from the original \
post's subject.
- `total_turns`: total number of comments provided.

Be conservative. Prefer null/empty over guessing. Do not invent usernames \
or escalation that isn't visible in the excerpts.
"""


def build_messages(*, post_body: str, comments: tuple[str, ...] | list[str]) -> list[Message]:
    """Build the user-side messages from the thread excerpts.

    Comments are joined with explicit turn numbers so the model can refer
    to specific turns in `escalation_turn`.
    """
    excerpt_lines = [f"[turn {i}] {c}" for i, c in enumerate(comments)]
    excerpt_block = "\n".join(excerpt_lines) if excerpt_lines else "(no comments provided)"

    user = (
        "POST BODY:\n"
        f"{post_body or '(empty)'}\n\n"
        "COMMENT EXCERPTS:\n"
        f"{excerpt_block}\n\n"
        f"Summarize this thread per the JSON schema. total_turns must equal {len(comments)}."
    )

    return [
        Message(role="system", content=SYSTEM_PROMPT),
        Message(role="user", content=user),
    ]


# === Caller ==============================================================


class Summarizer:
    """Wraps the LLM call. Flash with thinking disabled per F-0.8 insight."""

    MAX_TOKENS = 512
    TIMEOUT_MS = 5_000
    TEMPERATURE = 0.0
    THINKING_BUDGET = 0  # Flash supports disabling thinking; keeps latency tight.

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    async def summarize(
        self,
        *,
        post_body: str,
        comments: tuple[str, ...] | list[str],
        correlation_id: str,
    ) -> SummarizerResult:
        messages = build_messages(post_body=post_body, comments=comments)
        response = await self._llm.complete(
            role=Role.SUMMARIZER,
            messages=messages,
            response_schema=ThreadSummary,
            max_tokens=self.MAX_TOKENS,
            temperature=self.TEMPERATURE,
            timeout_ms=self.TIMEOUT_MS,
            correlation_id=correlation_id,
            thinking_budget=self.THINKING_BUDGET,
        )

        if response.parsed is not None and isinstance(response.parsed, ThreadSummary):
            summary = response.parsed
        else:
            summary = ThreadSummary.model_validate_json(response.raw_text)

        return SummarizerResult(
            summary=summary,
            raw_text=response.raw_text,
            model=response.model,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            cost_usd=response.cost_usd,
            latency_ms=response.latency_ms,
        )


__all__ = [
    "PROMPT_VERSION",
    "Summarizer",
    "SummarizerResult",
    "ThreadSummary",
    "build_messages",
]
