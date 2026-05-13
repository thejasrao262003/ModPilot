"""policy_match tool tests — pure functions + mocked Redis/embed."""

from __future__ import annotations

import math
from unittest.mock import AsyncMock, patch

import pytest

from orchestrator.policy_match import (
    _MAX_MATCHES,
    _SIMILARITY_THRESHOLD,
    PolicyMatchTool,
    cosine_similarity,
    split_rules,
)
from orchestrator.tools import Tool, ToolContext

# === Helpers =============================================================


def _ctx(**overrides: object) -> ToolContext:
    base: dict[str, object] = {
        "subreddit_id": "t5_abc",
        "correlation_id": "inv-1",
        "target_kind": "comment",
        "target_id": "t1_xyz",
        "target_body": "you are an idiot",
    }
    base.update(overrides)
    return ToolContext(**base)  # type: ignore[arg-type]


def _unit_vec(dim: int, index: int) -> list[float]:
    """Unit vector with 1.0 at *index*, 0.0 elsewhere."""
    v = [0.0] * dim
    v[index] = 1.0
    return v


def _normalized(values: list[float]) -> list[float]:
    """Return L2-normalized copy."""
    norm = math.sqrt(sum(x * x for x in values))
    return [x / norm for x in values] if norm else values


# === split_rules (pure function) ========================================


class TestSplitRules:
    def test_empty_string(self) -> None:
        assert split_rules("") == []

    def test_whitespace_only(self) -> None:
        assert split_rules("   \n\n  ") == []

    def test_numbered_dot(self) -> None:
        rules = split_rules("1. No spam\n2. Be civil\n3. No NSFW")
        assert len(rules) == 3
        assert rules[0] == ("rule-1", "No spam")
        assert rules[1] == ("rule-2", "Be civil")
        assert rules[2] == ("rule-3", "No NSFW")

    def test_numbered_paren(self) -> None:
        rules = split_rules("1) No spam\n2) Be civil")
        assert len(rules) == 2

    def test_rule_prefix(self) -> None:
        rules = split_rules("Rule 1: No spam\nRule 2: Be civil")
        assert len(rules) == 2
        assert rules[0][1] == "No spam"

    def test_paragraph_fallback(self) -> None:
        rules = split_rules("No spam or self-promotion.\n\nBe respectful to others.")
        assert len(rules) == 2
        assert rules[0] == ("rule-1", "No spam or self-promotion.")
        assert rules[1] == ("rule-2", "Be respectful to others.")

    def test_single_blob(self) -> None:
        rules = split_rules("No spam")
        assert rules == [("rule-1", "No spam")]


# === cosine_similarity (pure function) ===================================


class TestCosineSimilarity:
    def test_identical_vectors(self) -> None:
        v = [1.0, 2.0, 3.0]
        assert cosine_similarity(v, v) == pytest.approx(1.0)

    def test_orthogonal_vectors(self) -> None:
        a = _unit_vec(3, 0)
        b = _unit_vec(3, 1)
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_opposite_vectors(self) -> None:
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        assert cosine_similarity(a, b) == pytest.approx(-1.0)

    def test_zero_vector_returns_zero(self) -> None:
        assert cosine_similarity([0.0, 0.0], [1.0, 2.0]) == 0.0

    def test_dimension_mismatch_raises(self) -> None:
        with pytest.raises(ValueError, match="dimension mismatch"):
            cosine_similarity([1.0], [1.0, 2.0])

    def test_known_similarity(self) -> None:
        a = _normalized([1.0, 1.0, 0.0])
        b = _normalized([1.0, 0.0, 0.0])
        # cos(45°) ≈ 0.7071
        assert cosine_similarity(a, b) == pytest.approx(math.cos(math.pi / 4), abs=1e-4)


# === Protocol compliance =================================================


def test_satisfies_tool_protocol() -> None:
    tool = PolicyMatchTool(
        redis=AsyncMock(),
        embed=AsyncMock(return_value=[1.0]),
        rules_text=AsyncMock(return_value=""),
    )
    assert isinstance(tool, Tool)


def test_name_is_policy_match() -> None:
    tool = PolicyMatchTool(
        redis=AsyncMock(),
        embed=AsyncMock(return_value=[1.0]),
        rules_text=AsyncMock(return_value=""),
    )
    assert tool.name == "policy_match"


# === Tool.run() — happy path ============================================


@pytest.mark.asyncio
async def test_matches_similar_rule() -> None:
    """Content vector is close to one rule embedding → match returned."""
    # Rule embedding: nearly identical to what content will return
    rule_vec = _normalized([1.0, 0.8, 0.0])
    content_vec = _normalized([1.0, 0.9, 0.0])

    cached_rules = [{"id": "rule-1", "text": "No personal attacks", "embedding": rule_vec}]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(return_value=content_vec),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert result.status == "success"
    matches = result.detail["matches"]
    assert len(matches) == 1  # type: ignore[arg-type]
    assert matches[0]["rule_id"] == "rule-1"  # type: ignore[index]
    assert matches[0]["similarity"] >= _SIMILARITY_THRESHOLD  # type: ignore[index]


@pytest.mark.asyncio
async def test_filters_below_threshold() -> None:
    """Orthogonal vectors → similarity ~0 → no match."""
    rule_vec = _unit_vec(3, 0)
    content_vec = _unit_vec(3, 2)  # orthogonal

    cached_rules = [{"id": "rule-1", "text": "No spam", "embedding": rule_vec}]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(return_value=content_vec),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert result.status == "success"
    assert result.detail["matches"] == []


@pytest.mark.asyncio
async def test_sorts_by_similarity_descending() -> None:
    """Multiple matches are returned highest-similarity first."""
    content_vec = _normalized([1.0, 1.0, 0.0])
    # rule-1: very close, rule-2: close but less so
    rule_1_vec = _normalized([1.0, 0.95, 0.0])
    rule_2_vec = _normalized([1.0, 0.7, 0.1])

    cached_rules = [
        {"id": "rule-1", "text": "Be civil", "embedding": rule_1_vec},
        {"id": "rule-2", "text": "No attacks", "embedding": rule_2_vec},
    ]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(return_value=content_vec),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    matches = result.detail["matches"]
    assert len(matches) == 2  # type: ignore[arg-type]
    assert matches[0]["similarity"] >= matches[1]["similarity"]  # type: ignore[index]


@pytest.mark.asyncio
async def test_max_matches_cap() -> None:
    """At most _MAX_MATCHES rules are returned."""
    dim = 4
    content_vec = _normalized([1.0] * dim)
    # Create more rules than the cap, all very similar to content
    cached_rules = [
        {
            "id": f"rule-{i + 1}",
            "text": f"Rule {i + 1}",
            "embedding": _normalized([1.0 + i * 0.001] * dim),
        }
        for i in range(_MAX_MATCHES + 3)
    ]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(return_value=content_vec),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert len(result.detail["matches"]) <= _MAX_MATCHES  # type: ignore[arg-type]


# === Edge cases ==========================================================


@pytest.mark.asyncio
async def test_no_rules_configured() -> None:
    """Subreddit has no rules → success with empty matches."""
    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=[],
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert result.status == "success"
    assert "no rules" in result.summary
    assert result.detail["matches"] == []


@pytest.mark.asyncio
async def test_empty_content_body() -> None:
    """Empty target_body → success with no matches, embed not called."""
    embed_mock = AsyncMock()
    cached_rules = [{"id": "rule-1", "text": "No spam", "embedding": [1.0, 0.0]}]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=embed_mock,
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx(target_body=""))

    assert result.status == "success"
    assert "empty content" in result.summary
    embed_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_cache_miss_computes_and_stores() -> None:
    """When Redis cache is empty, rules are fetched, embedded, and cached."""
    embed_mock = AsyncMock(return_value=_normalized([1.0, 1.0, 0.0]))
    rules_text_mock = AsyncMock(return_value="1. No spam\n2. Be civil")
    set_mock = AsyncMock()

    with (
        patch(
            "orchestrator.policy_match.get_rule_embeddings",
            new_callable=AsyncMock,
            return_value=None,  # cache miss
        ),
        patch(
            "orchestrator.policy_match.set_rule_embeddings",
            set_mock,
        ),
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=embed_mock,
            rules_text=rules_text_mock,
        )
        result = await tool.run(_ctx(subreddit_id="t5_test"))

    # Rules text fetched
    rules_text_mock.assert_awaited_once_with("t5_test")
    # Each rule embedded + the content itself
    assert embed_mock.await_count == 3  # 2 rules + 1 content
    # Cached for next time
    set_mock.assert_awaited_once()
    assert set_mock.call_args.kwargs["subreddit_id"] == "t5_test"
    assert result.status == "success"


# === Error handling ======================================================


@pytest.mark.asyncio
async def test_embed_failure_returns_failure() -> None:
    cached_rules = [{"id": "rule-1", "text": "No spam", "embedding": [1.0, 0.0]}]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(side_effect=RuntimeError("API down")),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert result.status == "failure"
    assert "API down" in (result.error or "")


@pytest.mark.asyncio
async def test_redis_failure_returns_failure() -> None:
    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        side_effect=ConnectionError("redis unreachable"),
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert result.status == "failure"
    assert "redis unreachable" in (result.error or "")


# === Detail schema =======================================================


@pytest.mark.asyncio
async def test_detail_contains_expected_keys() -> None:
    cached_rules = [
        {"id": "rule-1", "text": "No spam", "embedding": _normalized([1.0, 1.0])}
    ]

    with patch(
        "orchestrator.policy_match.get_rule_embeddings",
        new_callable=AsyncMock,
        return_value=cached_rules,
    ):
        tool = PolicyMatchTool(
            redis=AsyncMock(),
            embed=AsyncMock(return_value=_normalized([1.0, 1.0])),
            rules_text=AsyncMock(return_value=""),
        )
        result = await tool.run(_ctx())

    assert set(result.detail.keys()) == {"matches", "rule_count", "threshold"}
    assert result.detail["threshold"] == _SIMILARITY_THRESHOLD
