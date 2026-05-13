"""F-0.8 smoke test — hits the real Gemini API.

Gated behind ENABLE_LIVE_LLM_TESTS=true. CI skips by default.
Run locally with:
    cd engine && uv run pytest llm/test_gemini.py -v
(assumes GEMINI_API_KEY is set in engine/.env and ENABLE_LIVE_LLM_TESTS=true)
"""

import os

import pytest

from api.config import get_settings
from llm.client import Message, Role
from llm.gemini import GeminiClient

pytestmark = pytest.mark.skipif(
    os.getenv("ENABLE_LIVE_LLM_TESTS", "false").lower() not in ("true", "1", "yes"),
    reason="set ENABLE_LIVE_LLM_TESTS=true to hit the live Gemini API",
)


@pytest.mark.asyncio
async def test_gemini_flash_returns_text_within_budget() -> None:
    get_settings.cache_clear()
    settings = get_settings()
    assert settings.gemini_api_key, "GEMINI_API_KEY must be set in engine/.env"

    client = GeminiClient(settings)

    response = await client.complete(
        role=Role.SUMMARIZER,  # Flash — fastest + cheapest
        messages=[
            Message(role="system", content="You answer with one short word."),
            Message(role="user", content="What color is the sky on a clear day?"),
        ],
        max_tokens=32,
        temperature=0.0,
        timeout_ms=10_000,
        correlation_id="smoke-test-flash",
        thinking_budget=0,  # Flash allows disabling thinking — the right default for summarization.
    )

    assert response.raw_text.strip(), "expected non-empty response text"
    assert response.input_tokens > 0
    assert response.output_tokens > 0
    assert response.model == settings.model_summarizer == "gemini-2.5-flash"
    assert response.latency_ms < 10_000
    assert response.cost_usd >= 0.0


@pytest.mark.asyncio
async def test_gemini_pro_reasoner_path() -> None:
    get_settings.cache_clear()
    settings = get_settings()
    assert settings.gemini_api_key

    client = GeminiClient(settings)

    response = await client.complete(
        role=Role.REASONER,
        messages=[
            Message(
                role="system",
                content="Respond with one short sentence. No explanation.",
            ),
            Message(role="user", content="Reply with exactly: pong"),
        ],
        # 2.5 Pro is thinking-only (`thinking_budget=0` is rejected by the API).
        # Give it enough output budget to cover the minimum thinking burn + answer.
        max_tokens=512,
        temperature=0.0,
        timeout_ms=45_000,
        correlation_id="smoke-test-pro",
        # 128 is the smallest budget that lets Pro produce a token; using it to
        # keep the smoke test snappy. Real Reasoner calls leave this unset.
        thinking_budget=128,
    )

    assert response.raw_text.strip()
    assert response.model == settings.model_reasoner == "gemini-2.5-pro"
    assert "pong" in response.raw_text.lower()
