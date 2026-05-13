"""LLM client protocol — provider-agnostic interface.

Spec: docs/Specs.md §8.2, docs/06-AILayer.md §3.1.
Today's only implementation is `engine/llm/gemini.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from pydantic import BaseModel


class Role(StrEnum):
    """LLM call role — drives model selection and prompt scaffolding."""

    REASONER = "reasoner"
    SUMMARIZER = "summarizer"


@dataclass(frozen=True)
class Message:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass
class LLMResponse:
    """Outcome of a single LLM call. `parsed` is populated when a response_schema was provided."""

    raw_text: str
    input_tokens: int
    output_tokens: int
    model: str
    latency_ms: int
    cost_usd: float
    parsed: BaseModel | None = None


class LLMClient(Protocol):
    """The contract every LLM provider implementation honours."""

    async def complete(  # noqa: PLR0913 — keyword-only contract from Specs §8.2
        self,
        *,
        role: Role,
        messages: list[Message],
        response_schema: type[BaseModel] | None = None,
        max_tokens: int,
        temperature: float = 0.0,
        timeout_ms: int,
        correlation_id: str,
        # Gemini-2.5 internal "thinking" tokens count against max_tokens. Set 0
        # to disable (Flash summarization, simple structured extraction). Leave
        # None for the default behavior (Reasoner verdicts benefit from thinking).
        thinking_budget: int | None = None,
    ) -> LLMResponse: ...
