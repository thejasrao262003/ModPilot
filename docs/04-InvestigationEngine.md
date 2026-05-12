# 04 — Investigation Engine

> **Purpose:** The complete specification of the Investigation Engine — ModPilot's core reasoning system. Every component, contract, and control flow that turns a report into a verdict with an evidence trail lives here. When working anywhere under `engine/`, this is the doc to load alongside `06-AILayer.md`.
>
> **Status:** Living. The engine's structure is stable; prompts, tool implementations, and tier tuning evolve continuously.

---

## 1. What the Engine Is

The Investigation Engine is a stateless Python service that takes one input — a report from a Devvit trigger — and produces one output: a **Verdict** containing a recommendation, calibrated confidence, and a full **Investigation Timeline** of the evidence that supports it.

It is not a classifier. It does not score "toxic vs not toxic." It is an **adaptive investigation orchestrator** that mirrors how an experienced moderator thinks: assess risk, pick a depth of investigation, gather targeted evidence, reason from that evidence, and produce a recommendation alongside the reasoning trail.

The Engine has five major components, each owned by a single module under `engine/`:

| Component | Module | Role |
|---|---|---|
| **Strategy Selector** | `orchestrator/strategy_selector.py` | Chooses an investigation tier and tool plan |
| **Orchestrator** | `orchestrator/orchestrator.py` | Executes the investigation loop with budgets |
| **Tool Registry** | `tools/base.py` + `tools/*.py` | Typed evidence-gathering functions |
| **Reasoner** | `llm/prompts/reasoner.py` + `llm/validation.py` | Generates the final verdict from evidence |
| **Confidence Calibrator** | `orchestrator/confidence.py` | Combines signals into a calibrated confidence score |

Two cross-cutting concerns weave through all five: the **Evidence Accumulator** (the structured object that grows as tools run) and the **Timeline Recorder** (which captures every step for the UI). Both are utility modules used everywhere; neither owns a phase of the pipeline.

---

## 2. The Core Loop

The entire Engine is one async function. Read it; everything else in this doc is detail.

```python
async def investigate(report: Report, subreddit_profile: SubredditProfile) -> Verdict:
    correlation_id = report.correlation_id
    logger = make_logger(correlation_id)

    # 1. Pick a tier and tool plan based on risk + personality + cold-start state
    plan = strategy_selector.select(report, subreddit_profile, memory_layer)
    logger.info("strategy_selected", tier=plan.tier, tools=plan.tools)

    evidence = EvidenceAccumulator(report=report)
    timeline = TimelineRecorder(correlation_id=correlation_id)
    budget = BudgetTracker(tier=plan.tier)

    # 2. Run tools, accumulating evidence, with early-stop on convergence
    for tool_name in plan.tools:
        if budget.is_exceeded():
            timeline.record_budget_exit()
            break
        if evidence.has_converged(plan.early_stop_threshold):
            timeline.record_early_stop()
            break

        with budget.measure(tool_name), timeline.record(tool_name):
            try:
                result = await tool_registry[tool_name].run(report, evidence, context)
                evidence.add(tool_name, result)
            except ToolError as e:
                evidence.add_failure(tool_name, e)
                timeline.record_tool_failure(tool_name, e)

    # 3. Reason from accumulated evidence (LLM call with citation contract enforced)
    raw_verdict = await reasoner.decide(report, evidence, subreddit_profile)
    validated = validate_citations(raw_verdict, evidence)
    if not validated.passed:
        raw_verdict = await reasoner.retry_with_correction(raw_verdict, validated)
        # second failure → demote confidence to Low

    # 4. Calibrate confidence from multiple signals
    confidence = confidence_calibrator.calibrate(
        llm_self_report=raw_verdict.confidence,
        evidence_convergence=evidence.convergence_score(),
        historical_accuracy=memory_layer.subreddit_accuracy(report.subreddit_id),
        rule_match_strength=evidence.rule_match_strength(),
        validation_passed=validated.passed,
    )

    # 5. Assemble the final Verdict + Timeline + cost metrics
    return Verdict(
        recommendation=raw_verdict.recommendation,
        confidence=confidence,
        risk_tier=evidence.derived_risk_tier(),
        top_evidence=evidence.top_n(3),
        timeline=timeline.serialize(),
        rationale=raw_verdict.rationale,
        meta=InvestigationMeta(
            tier=plan.tier,
            tools_used=evidence.tools_used(),
            latency_ms=budget.elapsed_ms(),
            cost_usd=budget.cost_usd(),
            correlation_id=correlation_id,
        ),
    )
```

Every section below specifies one piece of this loop. Internalize the loop first; the details slot in.

---

## 3. Strategy Selector

The Strategy Selector is the single component responsible for ModPilot's "adaptive" claim. It is the difference between us and every other moderation tool.

### 3.1 What It Does

Given a report, the Strategy Selector returns a **plan**: a tier (Fast / Standard / Deep), an ordered list of tools to run, and an early-stop threshold for evidence convergence.

```python
@dataclass
class InvestigationPlan:
    tier: Tier                         # FAST | STANDARD | DEEP
    tools: list[str]                   # ordered tool names
    early_stop_threshold: float        # 0.0-1.0; stop when convergence exceeds
    token_budget: int                  # max tokens across all LLM calls
    time_budget_ms: int                # max wall-clock ms
    tool_call_budget: int              # max number of tool invocations
```

### 3.2 Inputs

The selector receives:

- **Risk signals** (cheap, no LLM): report count, report velocity, content signals (regex hits, link density, slur detection), author risk score from memory, subreddit baseline risk.
- **Subreddit personality**: Strict / Balanced / Lenient or custom weights.
- **Cold-start state**: `feedback_events < COLD_START_THRESHOLD` triggers conservative defaults.
- **Feedback weights**: per-subreddit learned coefficients from nightly batch.

### 3.3 The Selection Logic

```python
def select(report: Report, profile: SubredditProfile, memory: MemoryLayer) -> InvestigationPlan:
    # Risk estimation (no LLM, ~5ms)
    risk = compute_risk(report, memory, profile)

    # Cold-start override: always at least STANDARD, never auto-prefill
    if profile.feedback_events < COLD_START_THRESHOLD:
        if risk < 0.6:
            return STANDARD_PLAN_COLD_START
        return DEEP_PLAN_COLD_START

    # Mature subreddit: cost-aware tiering
    if risk < profile.fast_tier_ceiling and looks_like_spam(report):
        return FAST_PLAN
    if risk < profile.deep_tier_floor:
        return STANDARD_PLAN
    return DEEP_PLAN
```

### 3.4 Risk Computation

```python
def compute_risk(report: Report, memory: MemoryLayer, profile: SubredditProfile) -> float:
    user_mem = memory.user(report.author_id, report.subreddit_id)

    risk = (
        0.30 * normalize(report.unique_reporter_count, max_val=10)
      + 0.20 * normalize(report.reports_per_minute, max_val=5)
      + 0.20 * user_mem.risk_score()           # 0.0-1.0, includes prior violations
      + 0.10 * profile.baseline_risk           # subreddit-level prior
      + 0.10 * content_signal_score(report)    # regex hits, link density, etc.
      + 0.10 * normalize(report.thread_velocity, max_val=20)
    )
    return min(max(risk, 0.0), 1.0)
```

The coefficients above are **starting values**. They are tunable per-subreddit by the nightly feedback batch (see Section 11). Never hardcode them in branches — always read from `profile.risk_weights`.

### 3.5 The Three Tiers

| Tier | Use case | Tools (default) | Token budget | Time budget | Tool calls | Cost target |
|---|---|---|---|---|---|---|
| **FAST** | Obvious spam, copy-paste violations, throwaway accounts | `policy_match`, `report_velocity` | 2,000 | 1,500 ms | 2 | <$0.005 |
| **STANDARD** | Rule violations needing context, repeat offenders, borderline | `policy_match`, `user_history`, `prior_actions`, `thread_context` | 8,000 | 5,000 ms | 4 | <$0.020 |
| **DEEP** | Harassment, brigading, escalation, novel/ambiguous cases | All five MVP tools + cross-user pattern | 25,000 | 10,000 ms | 7 | <$0.050 |

Tier definitions live in `personalities/presets.py` and `orchestrator/strategy_selector.py`. Changes to tier shape require an ADR.

### 3.6 What the Selector Is Not Allowed to Do

- It is **not** allowed to call an LLM. Risk estimation must be heuristic-only. Adding an LLM to tier selection would burn the latency and cost budgets the tiers are designed to control.
- It is **not** allowed to mutate memory or write to stores. It is a pure function of (report, profile, memory-read).
- It does **not** decide the verdict. It decides the *investigation depth*. The Reasoner decides the verdict.

---

## 4. Orchestrator

The Orchestrator is the loop. It is small, careful, and load-bearing.

### 4.1 Responsibilities

1. Execute tools in the order specified by the plan.
2. Enforce budgets at every step (time, tokens, tool calls).
3. Accumulate evidence after each tool succeeds.
4. Record every step into the timeline — successes, failures, skips, early stops.
5. Detect convergence and trigger early-stop when warranted.
6. Hand off to the Reasoner once gathering is complete.

### 4.2 The Loop Contract

A few invariants the orchestrator must preserve:

- **Every tool execution is timed and budget-checked.** A tool that exceeds its time budget is killed, recorded as a failure, and the loop continues.
- **A failed tool does not abort the investigation.** Other tools may still provide enough evidence. The Reasoner sees partial evidence and adjusts.
- **The timeline records every decision.** A skipped tool is recorded. An early-stopped loop is recorded. A budget-exhausted exit is recorded. The UI shows exactly what happened.
- **Parallelism is opt-in per tool**, not default. Some tools are read-after-write dependent (e.g., `prior_actions` reads `user_history` results). The default is sequential; parallel groups are declared in the plan.

### 4.3 Convergence-Based Early Stop

The Orchestrator stops gathering early when accumulated evidence is decisive. Convergence is computed by the Evidence Accumulator (Section 7), not the Orchestrator. The Orchestrator just polls and exits when the threshold is hit.

```python
if evidence.convergence_score() >= plan.early_stop_threshold:
    timeline.record_early_stop(reason="convergence", score=...)
    break
```

Typical early-stop thresholds: FAST = 0.7, STANDARD = 0.8, DEEP = 0.9. Higher tiers demand more evidence before stopping.

### 4.4 Partial Verdicts

If budgets exhaust before convergence, the Orchestrator still produces a verdict — but the Reasoner is told the investigation was partial. The verdict is marked `is_partial=True`, and the Confidence Calibrator demotes the result accordingly. **A partial verdict is always better than no verdict** for a moderator who's waiting. Just label it honestly.

---

## 5. Tool Registry

The Tool Registry is the typed, contract-driven catalog of evidence-gathering functions. Every tool implements the same interface and obeys the same rules.

### 5.1 The Tool Interface

```python
class Tool(Protocol):
    name: str
    purpose: str
    latency_budget_ms: int
    requires: list[str]            # tool names this depends on (must run first)
    parallelizable: bool

    async def run(
        self,
        report: Report,
        evidence: EvidenceAccumulator,
        context: ToolContext,
    ) -> ToolResult:
        ...

@dataclass
class ToolResult:
    tool_name: str
    success: bool
    evidence_rows: list[EvidenceRow]
    summary: str                   # one-line summary for the timeline
    cost_usd: float
    latency_ms: int
    error: ToolError | None = None
```

### 5.2 The MVP Tools

Five tools ship in the MVP. Each has its own subsection below with full spec.

| Tool | When selected | Latency budget | Cost | LLM use |
|---|---|---|---|---|
| `policy_match` | Every investigation | 300 ms | ~$0 | None (embedding lookup) |
| `report_velocity` | Every investigation | 100 ms | $0 | None |
| `user_history` | Standard + Deep | 500 ms | ~$0 | None (memory layer read) |
| `prior_actions` | Standard + Deep | 300 ms | $0 | None |
| `thread_context` | Standard + Deep | 1,500 ms | ~$0.003 | Haiku for summarization |

Note that **most tools do not use an LLM.** This is deliberate. Tools gather facts; the Reasoner reasons. Conflating those two roles makes investigations slow, expensive, and harder to validate.

### 5.3 Tool Specifications

#### 5.3.1 `policy_match`

- **Purpose:** Determine which subreddit rules, if any, this content violates.
- **Inputs:** Report content, subreddit's `customRules` setting, optional region.
- **Mechanism:** At settings save time, the customRules text is split into rule chunks and embedded (one-time cost, cached forever in Redis under `policy_embed:<subredditId>:<ruleId>`). On each investigation, the content is embedded and matched against rule embeddings via cosine similarity. Top matches above 0.65 similarity are returned with their rule text.
- **Output:** Evidence rows like `{"type": "rule_match", "rule_id": "rule-2", "rule_text": "No personal attacks", "similarity": 0.81}`.
- **Failure mode:** If no rules are configured, returns an empty result with a soft warning. Investigation proceeds but loses a key signal.
- **Caching:** Rule embeddings cached forever; invalidated only when settings change.

#### 5.3.2 `report_velocity`

- **Purpose:** Detect coordinated or rapid reporting patterns.
- **Inputs:** Comment/post ID, current report metadata.
- **Mechanism:** Pure Redis read: `reports:<targetId>` returns a sliding-window count over the last 1m, 5m, 15m. Compares against subreddit baseline.
- **Output:** Evidence rows like `{"type": "velocity", "reports_in_5min": 4, "baseline": 0.3, "z_score": 6.2}`. High z-scores indicate unusual reporting activity (brigade or genuine outrage).
- **No LLM, no Postgres.** Purely Redis-backed.

#### 5.3.3 `user_history`

- **Purpose:** Surface the report author's longitudinal moderation history in this subreddit.
- **Inputs:** Author user ID, subreddit ID.
- **Mechanism:** Reads from the Memory Layer (`engine/memory/user.py`), which queries Postgres. Returns: prior violations count by category, borderline incidents, recent mod overrides in favor of the user, derived trust score, and any escalation pattern flags.
- **Output:** Evidence rows including:
  - `{"type": "prior_violations", "count": 3, "categories": ["harassment", "spam"], "window_days": 30}`
  - `{"type": "borderline_incidents", "count": 2, "trend": "increasing"}`
  - `{"type": "trust_score", "value": 0.34, "tier": "low"}` (only if not in cold-start)
- **PII rule:** User IDs are passed through anonymized in the prompt; UI re-hydrates the username. See `10-ReliabilityAndSafety.md`.

#### 5.3.4 `prior_actions`

- **Purpose:** What did this subreddit's mod team do the last time they saw something similar from this user?
- **Inputs:** Author ID, subreddit ID.
- **Mechanism:** Postgres query against the audit log: most recent N moderation actions on this user, with ModPilot recommendation alignment markers.
- **Output:** Evidence rows summarizing the last 3 actions taken on the user in this subreddit: action type, when, whether ModPilot recommended it, whether the mod accepted/overrode.
- **Why this matters:** This is the single highest-signal evidence type for repeat offenders. A user with three Remove actions in 30 days is qualitatively different from a first-time reportee.

#### 5.3.5 `thread_context`

- **Purpose:** Understand the conversational arc around the reported content.
- **Inputs:** Comment ID (or post ID), depth limit.
- **Mechanism:**
  1. Fetch parent chain and sibling comments via Reddit API (called from Engine, not Devvit, since the Engine has its own Reddit credentials for context-gathering).
  2. If the thread is short (<10 turns), pass the raw text into the Reasoner along with other evidence.
  3. If the thread is long (≥10 turns), invoke Haiku to produce a structured summary: conversation arc, escalation points, instigator candidates, on-topic vs off-topic.
  4. Result is cached under `thread_summary:<postId>:<bucket>` where `bucket` rounds comment count to the nearest 10.
- **Output:** Either raw thread excerpt or structured summary; evidence rows for escalation markers.
- **Cost:** Up to ~$0.003 per uncached summarization. Cache hit rates target >70%.

### 5.4 Adding a New Tool

The contract every new tool must satisfy before it's registered:

1. Implements the `Tool` protocol completely.
2. Has a documented latency budget that fits within at least one tier's tool-call budget.
3. Has a failure mode that does not break the orchestrator.
4. Emits structured evidence rows that the Reasoner's prompt knows how to consume.
5. Has at least one scenario in the eval harness (`eval/scenarios/`) that exercises it.
6. Has a section added to this doc (or a corresponding tool-spec doc) describing it.

The Tool Registry is the heart of the system. New tools are how ModPilot grows in capability. But each one must clear the bar — adding a half-baked tool degrades the whole pipeline.

---

## 6. Evidence Accumulator

The Evidence Accumulator is the data structure that grows during investigation. It's how tools communicate findings, how the Reasoner sees the world, and how the UI renders the Timeline.

### 6.1 Schema

```python
@dataclass
class EvidenceRow:
    id: str                        # globally unique within this investigation
    tool_name: str
    type: str                      # e.g., "rule_match", "prior_violations"
    summary: str                   # short, human-readable
    detail: dict                   # structured payload
    weight: float                  # 0.0-1.0, contribution to convergence
    timestamp: datetime

class EvidenceAccumulator:
    rows: list[EvidenceRow]
    failures: list[ToolFailure]
    report: Report

    def add(self, tool_name: str, result: ToolResult) -> None: ...
    def add_failure(self, tool_name: str, error: ToolError) -> None: ...
    def convergence_score(self) -> float: ...
    def has_converged(self, threshold: float) -> bool: ...
    def top_n(self, n: int) -> list[EvidenceRow]: ...
    def rule_match_strength(self) -> float: ...
    def derived_risk_tier(self) -> RiskTier: ...
    def serialize_for_prompt(self) -> str: ...
    def serialize_for_ui(self) -> dict: ...
```

### 6.2 Convergence Scoring

Convergence is how the Accumulator answers: "Do the signals agree enough to stop investigating?"

```python
def convergence_score(self) -> float:
    if not self.rows:
        return 0.0

    # Group evidence rows by what they imply: REMOVE-ward vs APPROVE-ward
    remove_weight = sum(r.weight for r in self.rows if implies_remove(r))
    approve_weight = sum(r.weight for r in self.rows if implies_approve(r))
    total_weight = remove_weight + approve_weight

    if total_weight == 0:
        return 0.0

    # Convergence = how skewed the evidence is in one direction
    return abs(remove_weight - approve_weight) / total_weight
```

Convergence = 1.0 means all evidence points the same direction. Convergence = 0.0 means perfectly conflicting evidence. The Orchestrator uses this to decide whether to keep gathering or stop.

### 6.3 Contradiction Handling

When evidence rows disagree (e.g., `rule_match` says violation, `user_history` says trusted user with consistent good behavior), the Accumulator does not resolve the contradiction — that's the Reasoner's job. But it does flag it:

```python
def has_contradictions(self) -> bool:
    return self.convergence_score() < 0.4 and len(self.rows) >= 3
```

A contradiction flag enters the Reasoner's prompt and almost always demotes confidence to Medium or Low. This is by design. **The system should be less confident when evidence disagrees.** Pretending otherwise is the failure mode that destroys mod trust.

### 6.4 Serialization

Two serialization modes:

- **For the prompt** (`serialize_for_prompt`) — produces a structured, model-readable representation with evidence IDs that the Reasoner must cite. Includes evidence type, summary, and key detail fields. Anonymizes usernames.
- **For the UI** (`serialize_for_ui`) — produces the data shape the Timeline component renders: ordered list of evidence rows with friendly labels and re-hydrated usernames.

The two representations share IDs. The Reasoner cites `evidence_id="ev-7"`; the UI shows row 7 with that same ID. This is what makes the evidence-citation contract auditable end-to-end.

---

## 7. Timeline Recorder

The Timeline Recorder is what makes the Investigation Timeline UI possible. It records every step the Orchestrator takes — successes, failures, skips, early stops — along with timings.

### 7.1 What Gets Recorded

For every tool invocation:

```python
@dataclass
class TimelineEntry:
    sequence: int                  # ordinal in this investigation
    tool_name: str
    started_at: datetime
    duration_ms: int
    status: Literal["success", "failure", "skipped", "timeout"]
    summary: str                   # one-line user-facing summary
    evidence_ids: list[str]        # which evidence rows resulted from this step
    error_summary: str | None      # one-line on failure, never raw stack traces
```

Plus meta-events:

- `early_stop` — convergence threshold reached
- `budget_exit` — budget exhausted before plan finished
- `partial_verdict` — verdict produced from incomplete evidence

### 7.2 What Does Not Get Recorded

- Raw LLM outputs (those are logged separately for debugging, not surfaced in the timeline)
- Stack traces (errors get a friendly summary; full traces go to logs)
- PII (usernames are re-hydrated only in the UI layer, not stored in the timeline payload)
- Internal scoring weights (the UI shows what was found, not the math)

### 7.3 UI Contract

The Timeline component in Devvit Blocks (`InvestigationTimeline.tsx`) consumes the serialized timeline directly. Schema is locked. Adding a new field requires a coordinated change between `engine/orchestrator/timeline.py` and the Devvit UI.

This is the single most important UI feature in the product. The Recorder's job is to make sure it can be rendered honestly, with no fudging.

---

## 8. Reasoner

The Reasoner is the LLM-powered verdict generator. It is the only place in the Engine where a Sonnet-class model is invoked. Everything else uses cheaper models or no model.

### 8.1 Responsibilities

1. Consume the accumulated evidence.
2. Produce a structured verdict: recommendation, rationale, self-reported confidence.
3. Cite every claim with evidence IDs.
4. Honor the subreddit's personality (Strict / Balanced / Lenient) in its threshold for recommending action.

### 8.2 Input Shape

```python
@dataclass
class ReasonerInput:
    report_summary: str
    evidence: str                  # serialize_for_prompt() output
    subreddit_rules: str           # from settings
    personality: Personality       # affects prompt phrasing
    region: Region                 # affects legal/cultural hints
    cold_start: bool               # affects threshold language
    is_partial: bool               # affects the prompt explicitly
```

### 8.3 Output Schema

```python
@dataclass
class ReasonerOutput:
    recommendation: Recommendation    # REMOVE | APPROVE | ESCALATE | LOCK | NO_ACTION
    confidence: float                 # 0.0-1.0, self-reported (will be discounted)
    rationale: str                    # 1-3 sentences, must cite evidence
    cited_evidence_ids: list[str]     # parsed from rationale
    flags: list[str]                  # any signals the Reasoner wants to surface
```

The output is a structured response (JSON-mode or tool-use), never free-form prose. Strict schema enforcement prevents downstream parsing errors.

### 8.4 Prompt Structure

The Reasoner prompt is defined in `engine/llm/prompts/reasoner.py` and versioned. It contains five sections, in this order:

1. **Role and Constraint Preamble** — "You are an investigation reasoner for Reddit moderators. You do not take actions; you make recommendations. Every claim you make must cite an evidence ID."
2. **Evidence-Citation Contract** — explicit instruction that every factual claim references `[ev-N]` where N is an evidence ID, and that unfounded claims are bugs.
3. **Subreddit Context** — rules, personality, region.
4. **Evidence Block** — the serialized Evidence Accumulator output.
5. **Output Schema** — exact JSON shape required.

The prompt does not include the original Reddit content directly. The content is summarized in the Evidence Block, anonymized of PII. **The Reasoner never sees raw usernames.** This is enforced at the evidence-serialization layer.

The full prompt lives in `06-AILayer.md`. This section is about what the Reasoner *does*; the wording belongs to the AI Layer.

### 8.5 Validation: The Evidence-Citation Contract

After the Reasoner returns a response, the validator (`engine/llm/validation.py`) enforces:

1. **Every claim in `rationale` cites at least one evidence ID.** Heuristic: split rationale into sentences; each sentence containing factual assertions must contain a `[ev-N]` reference or be a generic framing sentence.
2. **Every cited ID exists in the Evidence Accumulator.** Hallucinated evidence IDs are a critical failure.
3. **The output schema parses cleanly.** Type errors are critical failures.
4. **The recommendation is consistent with the cited evidence.** E.g., a `REMOVE` rec with only `APPROVE`-ward evidence triggers a warning flag.

If validation fails:

- **First failure** → fire a corrective retry with the validation errors in the prompt. One retry only.
- **Second failure** → accept the verdict but **demote confidence to Low**, mark `validation_failed=True` in the Verdict meta, log a warning. The UI flags this with a subtle "ModPilot is unsure about this analysis" badge.

The contract is the single most important reliability mechanism in the Engine. It is the difference between a hallucinating LLM wrapper and a system moderators can audit.

### 8.6 Personality Application

Personality affects the Reasoner via the prompt, not via post-processing. Example phrasing differences:

- **Strict**: "If the evidence suggests a possible violation, lean toward recommending action."
- **Balanced**: "Recommend action when evidence supports it; recommend no action when evidence is mixed."
- **Lenient**: "Only recommend action when evidence clearly supports it. When in doubt, recommend no action."

The personality string is injected into the prompt's Subreddit Context section. The Calibrator then applies a second-pass threshold adjustment downstream.

---

## 9. Confidence Calibrator

LLM-reported confidence is unreliable. The Confidence Calibrator's job is to produce an honest, deployable confidence number.

### 9.1 Inputs

```python
@dataclass
class CalibrationInputs:
    llm_self_report: float            # 0.0-1.0, from Reasoner
    evidence_convergence: float       # 0.0-1.0, from Accumulator
    historical_accuracy: float        # 0.0-1.0, subreddit-level ModPilot accuracy
    rule_match_strength: float        # 0.0-1.0, max similarity from policy_match
    validation_passed: bool
    cold_start: bool
    is_partial: bool
```

### 9.2 The Formula

```python
def calibrate(inputs: CalibrationInputs) -> CalibratedConfidence:
    # Discount the LLM's self-report heavily; LLMs are overconfident
    llm_signal = 0.5 + (inputs.llm_self_report - 0.5) * 0.4

    base = (
        0.25 * llm_signal
      + 0.30 * inputs.evidence_convergence
      + 0.20 * inputs.historical_accuracy
      + 0.25 * inputs.rule_match_strength
    )

    # Demotions
    if not inputs.validation_passed:
        base *= 0.6
    if inputs.is_partial:
        base *= 0.8
    if inputs.cold_start:
        base *= 0.85    # extra caution before feedback is established

    base = clamp(base, 0.0, 1.0)
    tier = tier_for(base)   # HIGH ≥ 0.85, MEDIUM ≥ 0.60, LOW < 0.60
    return CalibratedConfidence(value=base, tier=tier, inputs=inputs)
```

### 9.3 Tier Mapping

| Tier | Range | UI behavior |
|---|---|---|
| **HIGH** | ≥ 0.85 | Recommendation surfaced prominently; action buttons defaulted to recommended action |
| **MEDIUM** | 0.60 – 0.85 | Recommendation surfaced normally; no defaulting |
| **LOW** | < 0.60 | **No recommendation shown.** UI displays evidence with "ModPilot is unsure — your call" |

The LOW tier behavior is the most important UX rule in the entire product. It is the trust-building mechanism. When ModPilot doesn't know, it says so. The Calibrator is the component that makes this honest.

### 9.4 Why These Coefficients

The weights (0.25, 0.30, 0.20, 0.25) and the LLM discount (factor of 0.4) are starting values chosen for the MVP. They are tunable via the eval harness; changing them requires a regression run against the scenario library. The values live in `personalities/presets.py`, never inline in the calibrator.

---

## 10. Budgets and Cost Control

Budgets are first-class architectural concerns, not afterthoughts. The Engine enforces three budgets per investigation: **time, tokens, tool calls**.

### 10.1 BudgetTracker

```python
class BudgetTracker:
    def __init__(self, tier: Tier):
        self.tier = tier
        self.limits = TIER_LIMITS[tier]
        self.time_started = monotonic()
        self.tokens_used = 0
        self.tool_calls = 0
        self.cost_usd = 0.0

    def is_exceeded(self) -> bool: ...
    def measure(self, label: str) -> ContextManager: ...
    def record_llm(self, tokens_in: int, tokens_out: int, model: Model) -> None: ...
    def cost_usd(self) -> float: ...
    def elapsed_ms(self) -> int: ...
```

### 10.2 Per-Tier Limits

| Tier | Time | Tokens | Tool calls | Cost ceiling |
|---|---|---|---|---|
| FAST | 1,500 ms | 2,000 | 2 | $0.005 |
| STANDARD | 5,000 ms | 8,000 | 4 | $0.020 |
| DEEP | 10,000 ms | 25,000 | 7 | $0.050 |

When a budget is exceeded mid-investigation, the Orchestrator stops calling new tools and proceeds to the Reasoner with whatever evidence is accumulated. The verdict is marked `is_partial=True`.

### 10.3 Subreddit-Level Caps

Beyond per-investigation budgets, there are per-subreddit caps:

- **Daily cap:** $5 per subreddit per day for MVP. Enforced via Redis counter.
- **Hourly cap:** $1 per subreddit per hour, to smooth bursts.

When a subreddit hits its cap, new investigations are deferred (queued for next window) rather than dropped. The UI surfaces a banner: "ModPilot is throttled for this hour to stay within budget."

These limits are configurable per-deployment and are documented in `13-Infra.md`.

---

## 11. Feedback Loop and Adaptation

The Engine does not train models. It adapts through feedback-weighted heuristics updated nightly. This is what we mean by "adaptive intelligence" in the product copy.

### 11.1 What Feedback Captures

When a mod takes an action on a ModPilot-investigated item (`onModAction` in Devvit), the Engine receives:

```python
@dataclass
class FeedbackEvent:
    verdict_id: str
    subreddit_id: str
    mod_action: ModAction
    recommendation: Recommendation
    alignment: Alignment    # ACCEPTED | REJECTED | OVERRIDDEN | CONFIRMED_NO_ACTION
    timestamp: datetime
```

This row is persisted to Postgres in the `feedback` table immediately. No batching, no async — feedback is durable on receipt.

### 11.2 What the Nightly Batch Does

`engine/jobs/feedback_rollup.py` runs once per day per subreddit and updates:

1. **Strategy Selector weights** (`profile.risk_weights`): if FAST tier verdicts on this sub are getting overridden more often, increase the threshold to FAST. If DEEP tier verdicts are accepted at high rates, lower the threshold to DEEP.
2. **Confidence calibration** (`profile.historical_accuracy`): recompute the per-sub ModPilot accuracy as `accepted / (accepted + rejected + overridden)` over the last 30 days.
3. **Subreddit baseline risk** (`profile.baseline_risk`): if action-rate on the sub is high, the baseline risk floor rises.
4. **Cold-start transition**: if `feedback_events ≥ COLD_START_THRESHOLD` (default 50), exit cold-start mode for the sub.

### 11.3 What It Deliberately Doesn't Do

- It does **not** train a model.
- It does **not** modify prompts.
- It does **not** make changes that take effect mid-day. All adaptation is batched, predictable, and explainable to mods.
- It does **not** cross subreddits. Each sub's weights are computed from its own feedback only.

Adaptation here is **boring, predictable, and auditable**. Mods can see in the analytics dashboard that "ModPilot's accuracy in this subreddit is currently 87% — based on the last 30 days of your feedback." That's the entire story.

---

## 12. Caching Strategy

The Engine's caches are documented fully in `06-AILayer.md`; this section summarizes how the Orchestrator interacts with them.

| Cache | Key | TTL | Used by |
|---|---|---|---|
| User profile | `user_profile:<userId>:<subredditId>` | 1 hour | `user_history`, `prior_actions` |
| Thread summary | `thread_summary:<postId>:<bucket>` | 24 hours | `thread_context` |
| Policy embeddings | `policy_embed:<subredditId>:<ruleId>` | until settings change | `policy_match` |
| Verdict | `verdict:<targetId>` | 10 minutes | re-report short-circuit |
| Cross-user pattern | `pattern:<subredditId>:<window>` | 15 minutes | brigading detection (post-MVP) |

The Orchestrator does not implement caching itself. Each tool calls into the cache layer. Cache misses are normal and don't trigger warnings; cache stampedes on hot keys are mitigated by Redis single-flight locks where it matters.

---

## 13. Failure Modes

The Engine has a small number of well-defined failure modes, each with a defined behavior.

| Failure | Behavior |
|---|---|
| A single tool fails | Logged in timeline; investigation continues; Reasoner sees fewer evidence rows |
| Multiple tools fail (≥half of plan) | Investigation marked partial; Reasoner told explicitly; confidence demoted |
| LLM provider returns 5xx | Retry once with shorter timeout; on second failure, return a rule-based verdict with LOW confidence |
| LLM provider returns malformed output | Validation catches; one corrective retry; second failure demotes to LOW |
| Postgres unreachable | Memory tools fail gracefully (return empty results); investigation still runs |
| Redis unreachable | All caches miss; latency and cost spike; investigation still completes |
| Budget exceeded mid-investigation | Stop new tools, proceed to Reasoner with partial evidence, mark partial |
| Validation fails twice | Verdict shipped with LOW confidence and validation_failed flag; UI surfaces uncertainty |
| Total Engine timeout (Devvit-side) | Devvit returns no-verdict to UI; verdict shows up via dashboard once the Engine finishes |

The unifying principle: **the system always returns something honest, or it returns nothing.** It never lies confidently.

---

## 14. Observability

Every investigation emits structured logs and metrics. The minimum required signal:

**Per investigation:**
- `investigation.started` with tier, plan, correlation_id
- `investigation.tool.completed` per tool with success/failure, duration, cost
- `investigation.validation.failed` if applicable
- `investigation.completed` with verdict tier, confidence, total cost, total latency

**Aggregated metrics** (exposed to Grafana):
- p50/p95/p99 latency per tier
- Cost per investigation per tier
- Validation failure rate
- Cold-start exit rate
- Per-tool failure rate
- LLM call count and token usage per investigation

These are how the analytics dashboard derives the "time saved" and "cost" tiles in the UI. Documented in `12-Analytics.md`.

---

## 15. Engine Invariants

Properties that must always hold. Each is enforceable by code and tested.

1. **Every verdict ships with a non-empty timeline.** Even a single-step FAST investigation has at least one timeline entry.
2. **Every claim in `rationale` cites at least one evidence ID.** Enforced by validation.
3. **Every cited evidence ID exists in the Evidence Accumulator.** Enforced by validation.
4. **No tool runs longer than its declared latency budget.** Enforced by Orchestrator timeouts.
5. **No investigation exceeds its tier's cost ceiling by more than 20%.** Enforced by BudgetTracker.
6. **The Engine never sees a raw username in an LLM prompt.** Enforced at evidence-serialization.
7. **The Engine never executes a Reddit moderation action.** It returns recommendations only. Enforced by absence of any Reddit-write code path in the engine module.
8. **No data crosses subreddit boundaries.** Every store query is filtered by `subreddit_id`. Enforced by query lint rules and store-layer assertions.
9. **The Engine is stateless between requests.** No in-memory state survives a request. Enforced by code review and the absence of module-level mutable state.

Violating any of these is a bug, not a feature toggle.

---

## 16. Implementation Order

For the engine sprint, build in this order. Each step is a working end-to-end slice.

1. **API skeleton + `/health`** — Engine deploys, Devvit can ping it.
2. **EvidenceAccumulator + TimelineRecorder + BudgetTracker** — the substrate. No real intelligence yet.
3. **`policy_match` and `report_velocity`** — the two LLM-free tools. Returns evidence from real Reddit data.
4. **Orchestrator with FAST tier only** — full loop runs for obvious spam cases.
5. **Reasoner with citation contract + validation** — Sonnet generates verdicts; validation enforces.
6. **Confidence Calibrator** — calibrated confidence tier appears in the verdict.
7. **`user_history` and `prior_actions`** — Memory Layer wired in.
8. **STANDARD tier** — full Standard investigations work end-to-end.
9. **`thread_context` with Haiku summarization + caching** — last MVP tool.
10. **DEEP tier** — full pipeline.
11. **`/feedback` endpoint + nightly batch worker** — adaptation loop closes.
12. **Subreddit-level cost caps + circuit-breaker behaviors** — production readiness pass.

Steps 1–5 are blocking for any Devvit-side demo. Steps 6–10 are the depth of the demo. Steps 11–12 are what makes the system honest in front of judges.

---

## 17. What's Deliberately Out of Scope

These are tempting and rejected for MVP. Each has rationale documented in an ADR or this section.

- **Multi-LLM ensemble Reasoner.** Tempting; expensive and slow; defer.
- **Tool result re-ranking before Reasoner.** Defer until eval shows the Reasoner is sensitive to evidence ordering.
- **Online weight updates from feedback** (versus nightly batch). Adds operational complexity without proportional benefit at MVP scale.
- **Tool-result embeddings for semantic retrieval.** Premature; current evidence volume per investigation is small.
- **A separate "Planner" LLM that designs custom tool plans per report.** The Strategy Selector's heuristic tiering is sufficient and cheaper.
- **Multi-step Reasoner with internal scratchpad.** Adds latency; current single-pass with structured evidence is sufficient.
- **Cross-subreddit pattern detection (sockpuppets across subs).** Important; out of MVP scope; tracked in roadmap.

When any of these become necessary, they ship with an ADR and an eval comparison.

---

## 18. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — Where the Engine sits in the system topology.
- [`03-Devvit.md`](03-Devvit.md) — The trigger/HTTP boundary that calls the Engine.
- [`05-Memory.md`](05-Memory.md) — The Memory Layer that `user_history` and `prior_actions` query.
- [`06-AILayer.md`](06-AILayer.md) — Prompts, citation contract enforcement, model tiering.
- [`07-DataLayer.md`](07-DataLayer.md) — Postgres schemas backing memory, feedback, and audit.
- [`08-API.md`](08-API.md) — Full request/response specs for `/investigate`, `/feedback`.
- [`09-UX.md`](09-UX.md) — How the Verdict, Timeline, and Confidence Tier render.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Graceful degradation, PII handling, the human-in-the-loop invariant.
- [`11-Evaluation.md`](11-Evaluation.md) — Scenario harness for testing the Engine.
- [`12-Analytics.md`](12-Analytics.md) — Metrics emitted from investigations.
- [`14-Engineering.md`](14-Engineering.md) — Python conventions, async patterns, testing strategy.