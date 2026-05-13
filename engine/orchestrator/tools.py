"""Tool protocol, registry, and Evidence Accumulator.

Spec: docs/04-InvestigationEngine.md §4-5, docs/Specs.md §7.3-7.4.

A Tool is anything the Orchestrator can invoke that produces a `ToolResult`:
a deterministic check (policy_match, report_velocity) or an LLM call
(thread_context). The registry indexes them by canonical name; the
accumulator gives each result a stable `ev-N` id that the Reasoner cites
under ADR-0003.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

# Internal tool names — must match docs/Glossary.md §6 + store/models.py.
ToolName = Literal[
    "policy_match",
    "report_velocity",
    "user_history",
    "prior_actions",
    "thread_context",
]

ToolStatus = Literal["success", "failure", "skipped", "timeout"]


# === Tool execution context ============================================


@dataclass(frozen=True)
class ToolContext:
    """Read-only context handed to every tool invocation.

    Tools that need DB/Redis access receive those handles at construction
    time (via dependency injection at startup); this context only carries
    the per-investigation values.
    """

    subreddit_id: str
    correlation_id: str
    target_kind: Literal["comment", "post"]
    target_id: str
    target_body: str = ""
    target_author_id: str = ""
    # Cheap signals already computed by the Strategy Selector. Tools may
    # piggyback (e.g. report_velocity reads its own z-score, but
    # policy_match can look at rule_match_score to short-circuit).
    reporter_count: int = 0
    rule_match_score: float = 0.0


# === Tool result =======================================================


@dataclass(frozen=True)
class ToolResult:
    """One tool invocation's outcome. Specs §7.3."""

    tool: ToolName
    status: ToolStatus
    summary: str  # ≤200 chars — renders in Verdict Card evidence rows
    latency_ms: int
    detail: dict[str, object] = field(default_factory=dict)
    error: str | None = None

    def is_terminal_failure(self) -> bool:
        """True when this result should NOT produce evidence for the Reasoner."""
        return self.status in ("failure", "timeout")


# === Tool protocol =====================================================


@runtime_checkable
class Tool(Protocol):
    """The contract every tool implementation honours.

    Concrete classes hold their DB/Redis/LLM clients as instance state
    (injected at startup). The Orchestrator only sees this Protocol.
    """

    @property
    def name(self) -> ToolName: ...

    async def run(self, context: ToolContext) -> ToolResult: ...


# === Registry ==========================================================


class ToolRegistry:
    """Maps `ToolName` -> `Tool` instance. Built at engine startup."""

    def __init__(self) -> None:
        self._tools: dict[ToolName, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name!r}")
        self._tools[tool.name] = tool

    def get(self, name: ToolName) -> Tool:
        try:
            return self._tools[name]
        except KeyError as e:
            raise KeyError(f"unknown tool: {name!r}") from e

    def has(self, name: ToolName) -> bool:
        return name in self._tools

    def names(self) -> list[ToolName]:
        """Stable insertion order — useful for deterministic Orchestrator plans."""
        return list(self._tools.keys())

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: object) -> bool:
        return name in self._tools


# === Evidence Accumulator ==============================================


@dataclass(frozen=True)
class EvidenceEntry:
    """One entry in the Evidence Accumulator. Has a stable `ev-N` id that
    the Reasoner cites in `rationale` per ADR-0003."""

    id: str  # "ev-N"
    tool: ToolName
    status: ToolStatus
    summary: str
    detail: dict[str, object]
    latency_ms: int
    error: str | None = None


class EvidenceAccumulator:
    """Append-only collection of tool results with monotonic id minting.

    Each call to `append(result)` mints the next `ev-N` id (starting at 1)
    and returns the persisted entry. The id is stable for the lifetime of
    the investigation — the Reasoner's `[ev-N]` citations resolve against
    this collection during validation (ADR-0003).

    NOTE: even FAILURE / TIMEOUT results get an evidence id. We surface
    them in the Investigation Timeline so the moderator can see what
    didn't run. The Reasoner is instructed not to cite failures, and the
    validator rejects rationales that do (E-2.9).
    """

    def __init__(self) -> None:
        self._entries: list[EvidenceEntry] = []

    def append(self, result: ToolResult) -> EvidenceEntry:
        entry = EvidenceEntry(
            id=self._next_id(),
            tool=result.tool,
            status=result.status,
            summary=result.summary,
            detail=dict(result.detail),  # defensive copy
            latency_ms=result.latency_ms,
            error=result.error,
        )
        self._entries.append(entry)
        return entry

    def _next_id(self) -> str:
        return f"ev-{len(self._entries) + 1}"

    def by_id(self, ev_id: str) -> EvidenceEntry | None:
        for entry in self._entries:
            if entry.id == ev_id:
                return entry
        return None

    def has(self, ev_id: str) -> bool:
        return self.by_id(ev_id) is not None

    def entries(self) -> list[EvidenceEntry]:
        """Defensive shallow copy — callers can iterate without mutation risk."""
        return list(self._entries)

    def successful_entries(self) -> list[EvidenceEntry]:
        """The subset the Reasoner is allowed to cite."""
        return [e for e in self._entries if e.status == "success"]

    def __len__(self) -> int:
        return len(self._entries)

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self._entries)


__all__ = [
    "EvidenceAccumulator",
    "EvidenceEntry",
    "Tool",
    "ToolContext",
    "ToolName",
    "ToolRegistry",
    "ToolResult",
    "ToolStatus",
]
