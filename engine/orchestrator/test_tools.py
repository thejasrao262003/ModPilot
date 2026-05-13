"""Tool Registry + Evidence Accumulator tests."""

from __future__ import annotations

import pytest

from orchestrator.tools import (
    EvidenceAccumulator,
    Tool,
    ToolContext,
    ToolName,
    ToolRegistry,
    ToolResult,
)


def _result(tool: ToolName = "policy_match", **overrides: object) -> ToolResult:
    base: dict[str, object] = {
        "tool": tool,
        "status": "success",
        "summary": "matched rule 2",
        "latency_ms": 142,
        "detail": {},
        "error": None,
    }
    base.update(overrides)
    return ToolResult(**base)  # type: ignore[arg-type]


class _FakeTool:
    """In-test Tool implementation. Satisfies the runtime_checkable Protocol."""

    def __init__(self, name: ToolName, summary: str = "ok", status: str = "success") -> None:
        self._name = name
        self._summary = summary
        self._status = status

    @property
    def name(self) -> ToolName:
        return self._name

    async def run(self, context: ToolContext) -> ToolResult:
        return ToolResult(
            tool=self._name,
            status=self._status,  # type: ignore[arg-type]
            summary=self._summary,
            latency_ms=10,
        )


# === ToolRegistry =====================================================


def test_register_then_get() -> None:
    reg = ToolRegistry()
    t = _FakeTool("policy_match")
    reg.register(t)
    assert reg.get("policy_match") is t
    assert reg.has("policy_match")
    assert len(reg) == 1
    assert "policy_match" in reg


def test_register_duplicate_raises() -> None:
    reg = ToolRegistry()
    reg.register(_FakeTool("policy_match"))
    with pytest.raises(ValueError, match="already registered"):
        reg.register(_FakeTool("policy_match"))


def test_get_unknown_raises_keyerror() -> None:
    reg = ToolRegistry()
    with pytest.raises(KeyError, match="unknown tool"):
        reg.get("user_history")


def test_names_preserves_insertion_order() -> None:
    reg = ToolRegistry()
    reg.register(_FakeTool("policy_match"))
    reg.register(_FakeTool("report_velocity"))
    reg.register(_FakeTool("user_history"))
    assert reg.names() == ["policy_match", "report_velocity", "user_history"]


def test_has_returns_false_for_unregistered() -> None:
    reg = ToolRegistry()
    assert not reg.has("thread_context")
    assert "thread_context" not in reg


def test_fake_tool_satisfies_runtime_protocol() -> None:
    """The runtime_checkable @Protocol lets us isinstance() at construction time."""
    assert isinstance(_FakeTool("policy_match"), Tool)


@pytest.mark.asyncio
async def test_registered_tool_run_returns_result() -> None:
    reg = ToolRegistry()
    reg.register(_FakeTool("policy_match", summary="hello"))
    result = await reg.get("policy_match").run(
        ToolContext(
            subreddit_id="t5_x",
            correlation_id="inv-1",
            target_kind="post",
            target_id="t3_x",
        )
    )
    assert result.tool == "policy_match"
    assert result.status == "success"
    assert result.summary == "hello"


# === EvidenceAccumulator =============================================


def test_accumulator_mints_monotonic_ids() -> None:
    acc = EvidenceAccumulator()
    e1 = acc.append(_result(tool="policy_match"))
    e2 = acc.append(_result(tool="report_velocity"))
    e3 = acc.append(_result(tool="user_history"))
    assert [e.id for e in (e1, e2, e3)] == ["ev-1", "ev-2", "ev-3"]
    assert len(acc) == 3


def test_accumulator_distinct_instances_have_separate_counters() -> None:
    """A new investigation = a new accumulator = fresh ev-1 counter."""
    a = EvidenceAccumulator()
    b = EvidenceAccumulator()
    a.append(_result())
    a.append(_result())
    first_b = b.append(_result())
    assert first_b.id == "ev-1"


def test_by_id_lookup() -> None:
    acc = EvidenceAccumulator()
    acc.append(_result(tool="policy_match"))
    acc.append(_result(tool="report_velocity", summary="z=6"))
    hit = acc.by_id("ev-2")
    assert hit is not None
    assert hit.tool == "report_velocity"
    assert hit.summary == "z=6"


def test_by_id_miss_returns_none() -> None:
    acc = EvidenceAccumulator()
    acc.append(_result())
    assert acc.by_id("ev-7") is None
    assert acc.has("ev-7") is False
    assert acc.has("ev-1") is True


def test_failures_get_evidence_id_but_excluded_from_successful() -> None:
    """Failures appear in the Timeline (for transparency) but the Reasoner
    is not allowed to cite them — ADR-0003."""
    acc = EvidenceAccumulator()
    acc.append(_result(tool="policy_match", status="success"))
    acc.append(_result(tool="thread_context", status="timeout", summary="reddit api slow"))
    acc.append(_result(tool="user_history", status="failure", summary="db error"))
    assert len(acc) == 3
    successful = acc.successful_entries()
    assert len(successful) == 1
    assert successful[0].tool == "policy_match"


def test_entries_returns_defensive_copy() -> None:
    acc = EvidenceAccumulator()
    acc.append(_result())
    snapshot = acc.entries()
    snapshot.clear()
    assert len(acc) == 1, "mutating the returned list must not affect the accumulator"


def test_detail_is_copied_on_append() -> None:
    """Mutating the original detail dict after append should not corrupt evidence."""
    original_detail: dict[str, object] = {"z": 6.2}
    acc = EvidenceAccumulator()
    entry = acc.append(_result(detail=original_detail))
    original_detail["z"] = 999
    assert entry.detail == {"z": 6.2}


def test_iteration_protocol() -> None:
    acc = EvidenceAccumulator()
    acc.append(_result(tool="policy_match"))
    acc.append(_result(tool="report_velocity"))
    ids_via_iter = [e.id for e in acc]
    assert ids_via_iter == ["ev-1", "ev-2"]


# === ToolResult helpers ================================================


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("success", False),
        ("skipped", False),
        ("failure", True),
        ("timeout", True),
    ],
)
def test_is_terminal_failure(status: str, expected: bool) -> None:
    assert _result(status=status).is_terminal_failure() is expected
