"""policy_match tool — cosine similarity of content against subreddit rules.

Spec: docs/04-InvestigationEngine.md §5.3.1.

No LLM call.  Rule embeddings are cached in Redis (populated at settings-save
time or lazily on first investigation).  Content is embedded on every call.
Target: <200 ms p95.
"""

from __future__ import annotations

import math
import re
import time
from typing import TYPE_CHECKING, Protocol

from orchestrator.tools import ToolContext, ToolName, ToolResult
from store.redis import get_rule_embeddings, set_rule_embeddings

if TYPE_CHECKING:
    from redis.asyncio import Redis

# Similarity threshold — matches below this are discarded (spec §5.3.1).
_SIMILARITY_THRESHOLD = 0.65

# Max matches surfaced in the detail payload.
_MAX_MATCHES = 5


# === Embedding callable protocol =========================================


class EmbedFn(Protocol):
    """Async callable that turns text into a dense vector."""

    async def __call__(self, text: str) -> list[float]: ...


# === Pure helpers ========================================================


def split_rules(raw: str) -> list[tuple[str, str]]:
    """Split a subreddit's rules blob into ``(rule_id, rule_text)`` pairs.

    Handles common Reddit rule formats:
    - Numbered lines (``1. No spam``, ``2) Be civil``)
    - "Rule N:" prefix
    - Double-newline separated paragraphs (fallback)

    Returns an empty list when *raw* is blank or whitespace-only.
    """
    raw = raw.strip()
    if not raw:
        return []

    # Try numbered pattern first: "1. ...", "1) ...", "Rule 1: ..."
    chunks = re.split(r"(?m)^(?:\d+[\.\)]\s*|Rule\s+\d+[:\s])", raw)
    # re.split keeps the text *between* delimiters; first element is pre-text.
    chunks = [c.strip() for c in chunks if c.strip()]

    if len(chunks) >= 2:
        return [(f"rule-{i + 1}", text) for i, text in enumerate(chunks)]

    # Fallback: double-newline separated paragraphs.
    paragraphs = [p.strip() for p in raw.split("\n\n") if p.strip()]
    if len(paragraphs) >= 2:
        return [(f"rule-{i + 1}", text) for i, text in enumerate(paragraphs)]

    # Single blob — treat the whole thing as one rule.
    return [("rule-1", raw)]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors. Returns 0.0 on zero norms."""
    if len(a) != len(b):
        raise ValueError(f"dimension mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


# === Tool ================================================================


class PolicyMatchTool:
    """Matches content against subreddit rules via embedding cosine similarity.

    Injected at startup with:
    - ``redis``: for cached rule embeddings
    - ``embed``: async callable that embeds a text string
    - ``rules_text``: async callable that returns the raw rules blob for a subreddit
      (typically backed by ``store.postgres.get_subreddit_profile``)
    """

    def __init__(
        self,
        *,
        redis: Redis[str],
        embed: EmbedFn,
        rules_text: RulesTextFn,
    ) -> None:
        self._redis = redis
        self._embed = embed
        self._rules_text = rules_text

    @property
    def name(self) -> ToolName:
        return "policy_match"

    async def run(self, context: ToolContext) -> ToolResult:
        t0 = time.monotonic()
        try:
            return await self._run_inner(context, t0)
        except Exception as exc:
            return ToolResult(
                tool=self.name,
                status="failure",
                summary="rule matching failed",
                latency_ms=_elapsed_ms(t0),
                error=str(exc),
            )

    async def _run_inner(self, ctx: ToolContext, t0: float) -> ToolResult:
        # 1. Get or compute rule embeddings
        rule_entries = await self._ensure_rule_embeddings(ctx.subreddit_id)
        if not rule_entries:
            return ToolResult(
                tool=self.name,
                status="success",
                summary="no rules configured",
                latency_ms=_elapsed_ms(t0),
                detail={"matches": [], "rule_count": 0},
            )

        # 2. Embed the target content
        content = ctx.target_body
        if not content:
            return ToolResult(
                tool=self.name,
                status="success",
                summary="empty content — no rule match possible",
                latency_ms=_elapsed_ms(t0),
                detail={"matches": [], "rule_count": len(rule_entries)},
            )

        content_vec = await self._embed(content)

        # 3. Cosine similarity against each rule
        matches: list[dict[str, object]] = []
        for entry in rule_entries:
            raw_embedding = entry["embedding"]
            assert isinstance(raw_embedding, list)  # runtime guard
            rule_vec = [float(v) for v in raw_embedding]
            sim = cosine_similarity(content_vec, rule_vec)
            if sim >= _SIMILARITY_THRESHOLD:
                matches.append(
                    {
                        "rule_id": entry["id"],
                        "rule_text": entry["text"],
                        "similarity": round(sim, 4),
                    }
                )

        # Sort descending by similarity, keep top N
        matches.sort(key=lambda m: float(str(m["similarity"])), reverse=True)
        matches = matches[:_MAX_MATCHES]

        latency = _elapsed_ms(t0)

        if matches:
            top = matches[0]
            summary = (
                f"{len(matches)} rule(s) matched "
                f"(top: {_truncate(str(top['rule_text']), 40)} "
                f"{top['similarity']})"
            )
        else:
            summary = f"0 of {len(rule_entries)} rules matched"

        if len(summary) > 200:
            summary = summary[:200]

        return ToolResult(
            tool=self.name,
            status="success",
            summary=summary,
            latency_ms=latency,
            detail={
                "matches": matches,
                "rule_count": len(rule_entries),
                "threshold": _SIMILARITY_THRESHOLD,
            },
        )

    async def _ensure_rule_embeddings(
        self, subreddit_id: str
    ) -> list[dict[str, object]]:
        """Return cached rule embeddings, computing lazily if cache is cold."""
        cached = await get_rule_embeddings(self._redis, subreddit_id=subreddit_id)
        if cached is not None:
            return cached

        # Cache miss — fetch rules text and compute embeddings
        raw = await self._rules_text(subreddit_id)
        if not raw:
            return []

        rules = split_rules(raw)
        entries: list[dict[str, object]] = []
        for rule_id, rule_text in rules:
            vec = await self._embed(rule_text)
            entries.append({"id": rule_id, "text": rule_text, "embedding": vec})

        # Cache for next time
        await set_rule_embeddings(self._redis, subreddit_id=subreddit_id, rules=entries)
        return entries


class RulesTextFn(Protocol):
    """Async callable that returns the raw rules text for a subreddit."""

    async def __call__(self, subreddit_id: str) -> str: ...


# === Utilities ===========================================================


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def _truncate(text: str, length: int) -> str:
    text = text.replace("\n", " ")
    if len(text) <= length:
        return text
    return text[: length - 1] + "…"
