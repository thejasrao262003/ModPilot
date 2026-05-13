"""Gemini implementation of the LLMClient protocol.

Spec: docs/Specs.md §8, docs/06-AILayer.md §3.2.
Wraps `google-genai` for both Reasoner (gemini-2.5-pro) and Summarizer (gemini-2.5-flash) roles.

Thinking-budget reality (validated 2026-05-13 against the live API):
- `gemini-2.5-pro` is **thinking-only**. Passing `thinking_budget=0` returns
  HTTP 400 "Budget 0 is invalid. This model only works in thinking mode."
  Reasoner calls must allocate budget for thinking + output.
- `gemini-2.5-flash` allows `thinking_budget=0` to skip thinking entirely.
  Summarizer calls and other Flash-backed structured extraction should
  pass 0 unless the task genuinely benefits from chain-of-thought.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

import structlog
from google import genai
from google.genai import types
from pydantic import BaseModel

from llm.client import LLMClient, LLMResponse, Message, Role

if TYPE_CHECKING:
    from api.config import Settings

logger = structlog.get_logger(__name__)

# Per-model USD rate per 1M tokens — used for cost surfacing in the Verdict
# Timeline + dashboard. Source: ai.google.dev pricing as of 2026-05-13.
# These are approximate; the audit log persists raw token counts so we can
# re-cost retroactively when rates change.
_PRICE_PER_M_TOKENS: dict[str, tuple[float, float]] = {
    # model_id → (input $/1M, output $/1M)
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash": (0.075, 0.30),
}


def _model_for_role(settings: Settings, role: Role) -> str:
    if role is Role.REASONER:
        return settings.model_reasoner
    if role is Role.SUMMARIZER:
        return settings.model_summarizer
    raise ValueError(f"unmapped role {role!r}")


def _cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    rates = _PRICE_PER_M_TOKENS.get(model)
    if rates is None:
        return 0.0
    in_rate, out_rate = rates
    return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000


def _split_messages(messages: list[Message]) -> tuple[str | None, list[types.Content]]:
    """Split into (system_instruction, contents-list-for-generate_content)."""
    system_parts: list[str] = []
    contents: list[types.Content] = []
    for msg in messages:
        if msg.role == "system":
            system_parts.append(msg.content)
        elif msg.role in ("user", "assistant"):
            role = "user" if msg.role == "user" else "model"
            contents.append(
                types.Content(role=role, parts=[types.Part.from_text(text=msg.content)])
            )
    system_instruction = "\n\n".join(system_parts) if system_parts else None
    return system_instruction, contents


class GeminiClient(LLMClient):
    """Default LLMClient — talks to Google's Gemini API."""

    def __init__(self, settings: Settings) -> None:
        if not settings.gemini_api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is empty — set it in engine/.env or environment"
            )
        self._settings = settings
        self._client = genai.Client(api_key=settings.gemini_api_key)

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
        thinking_budget: int | None = None,
    ) -> LLMResponse:
        model = _model_for_role(self._settings, role)
        system_instruction, contents = _split_messages(messages)

        thinking_config = (
            types.ThinkingConfig(thinking_budget=thinking_budget)
            if thinking_budget is not None
            else None
        )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_tokens,
            response_mime_type="application/json" if response_schema is not None else None,
            response_schema=response_schema,
            thinking_config=thinking_config,
        )

        log = logger.bind(correlation_id=correlation_id, role=role.value, model=model)
        log.info("llm.call.started", input_messages=len(messages), max_tokens=max_tokens)

        started = time.perf_counter()
        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(
                    model=model,
                    contents=contents,
                    config=config,
                ),
                timeout=timeout_ms / 1000.0,
            )
        except TimeoutError:
            log.warning("llm.call.timeout", timeout_ms=timeout_ms)
            raise
        latency_ms = int((time.perf_counter() - started) * 1000)

        usage = response.usage_metadata
        input_tokens = getattr(usage, "prompt_token_count", 0) or 0
        output_tokens = getattr(usage, "candidates_token_count", 0) or 0
        cost = _cost_usd(model, input_tokens, output_tokens)
        raw_text = response.text or ""
        # response.parsed can be BaseModel | dict | Enum | None depending on schema;
        # we only surface it when callers asked for a Pydantic-typed result.
        parsed_raw = response.parsed if response_schema is not None else None
        parsed: BaseModel | None = parsed_raw if isinstance(parsed_raw, BaseModel) else None

        log.info(
            "llm.call.succeeded",
            latency_ms=latency_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=round(cost, 6),
        )

        return LLMResponse(
            raw_text=raw_text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
            latency_ms=latency_ms,
            cost_usd=cost,
            parsed=parsed,
        )
