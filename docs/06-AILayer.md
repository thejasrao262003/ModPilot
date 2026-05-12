# 06 — AI Layer

> **Purpose:** Specify everything LLM-related in ModPilot — the provider abstraction, model tiering, prompt library, evidence-citation contract, hallucination mitigation, caching, cost budgets, and latency targets. When working on prompts, model selection, or any LLM-adjacent code, this is the doc to load alongside `04-InvestigationEngine.md`.
>
> **Status:** Living. The structure is stable; prompts and tunables evolve continuously.

---

## 1. Philosophy

Three commitments shape every decision in this layer:

1. **LLMs reason; they don't gather.** Tools gather evidence (mostly with no LLM at all). The Reasoner reasons from that evidence. Conflating these roles makes investigations slow, expensive, and harder to validate. Use LLMs where their judgment matters; use deterministic code everywhere else.

2. **Every claim cites evidence.** The single most important reliability mechanism in ModPilot is the evidence-citation contract. The Reasoner cannot make a claim without referencing an evidence ID from the Accumulator. This is enforced in the prompt, validated post-generation, and demotes confidence on failure. No verdict ships without auditable evidence.

3. **Honest uncertainty over confident wrongness.** LLMs are overconfident by default. We discount their self-reported confidence heavily and require multiple converging signals before we trust a HIGH-confidence verdict. When evidence is ambiguous, the system says so — both in the verdict and in the UI.

These three commitments produce a system where moderators can audit every recommendation, trust the confidence labels, and understand why ModPilot reached its conclusion. The AI Layer's job is to make all three structurally enforceable, not aspirational.

---

## 2. Model Tiering

Every LLM call in the Engine is assigned to one of three roles. Each role has a fixed model assignment that we deviate from only with an ADR.

| Role | Model | Why | Used by |
|---|---|---|---|
| **Reasoner** | Gemini 2.5 Pro | Quality matters most here; the final verdict shapes everything downstream | Final verdict generation |
| **Summarizer** | Gemini 2.5 Flash | Latency and cost dominate quality concerns for compression tasks | `thread_context` tool when threads ≥10 comments |
| **No-LLM** | Deterministic code | Most tools don't need a model at all | `policy_match`, `report_velocity`, `user_history`, `prior_actions` |

### 2.1 Why Gemini 2.5 Pro for the Reasoner

The Reasoner does the single most consequential work in the system: producing a verdict and rationale from accumulated evidence, with citation enforcement. Quality here drives the entire user experience — if the rationale is sloppy, evidence citations are wrong, or recommendations don't track the evidence, the product fails regardless of how good everything else is.

Gemini 2.5 Pro's tradeoff (~2–4s latency, ~$0.01–0.03 per call at our token volumes) is well-matched to a Reasoner role where we make one call per investigation. We are not making this call thousands of times per second; we are making it once per report and getting it right.

### 2.2 Why Gemini 2.5 Flash for Summarization

Thread summarization is a compression task with a fixed structure. We don't need the model to reason creatively — we need it to extract conversation arc, escalation points, and instigator candidates from a transcript. Gemini 2.5 Flash is fast (~500ms), cheap (~$0.001 per call), and entirely sufficient for structured extraction with a tight prompt.

### 2.3 Why No LLM for Most Tools

This is the most important architectural choice in the AI Layer.

`policy_match` is an embedding similarity lookup. No LLM.
`report_velocity` is a Redis sliding-window count. No LLM.
`user_history` is a Postgres read of structured memory. No LLM.
`prior_actions` is a Postgres read of the audit log. No LLM.

Replacing any of these with an LLM call would 10x the cost and 5x the latency of an investigation while reducing reliability. Tools are facts; the Reasoner reasons. Hold this line.

### 2.4 What's Out of Scope

- **Fine-tuning.** Adaptation happens via personality config and prompt context, not model weights.
- **Multi-LLM ensembles for the Reasoner.** Tempting; defer until eval shows a single Gemini 2.5 Pro pass is insufficient.
- **Local/open-weight models.** Operational cost (hosting, latency variance, quality regression) exceeds API cost at our scale.

---

## 3. LLM Provider Abstraction

The Engine talks to LLMs through a provider-agnostic interface. Today that backs Google's Gemini API; tomorrow it could back OpenAI or anything else. The abstraction lives in `engine/llm/client.py`.

### 3.1 Interface

```python
class LLMClient(Protocol):
    async def complete(
        self,
        *,
        role: Role,                # REASONER | SUMMARIZER
        messages: list[Message],
        response_schema: type[BaseModel] | None = None,
        max_tokens: int,
        temperature: float = 0.0,
        timeout_ms: int,
        correlation_id: str,
    ) -> LLMResponse: ...

@dataclass
class LLMResponse:
    parsed: BaseModel | None       # populated if response_schema provided
    raw_text: str
    input_tokens: int
    output_tokens: int
    model: str
    latency_ms: int
    cost_usd: float
```

### 3.2 Implementation: Gemini

The default implementation (`engine/llm/gemini.py`) wraps the `google-genai` SDK. Two model identifiers are pinned in config (never hardcoded inline):

```python
MODEL_REASONER   = "gemini-2.5-pro"
MODEL_SUMMARIZER = "gemini-2.5-flash"
```

Model strings are read from environment variables with these as defaults. Bumping a model version is a config change plus an ADR.

### 3.3 Retry and Fallback

The client implements a simple, predictable retry policy:

- **Timeout retry:** one retry on a timeout, with the timeout cut to 70% of the original.
- **5xx retry:** up to 2 retries with exponential backoff (250ms, 750ms).
- **Rate limit:** respect `retry-after` header up to 3s; fail past that.
- **4xx (except 429):** no retry. Surface the error.

If all retries fail, the Reasoner role returns a structured `LLMFailure` that the orchestrator handles as a rule-based fallback (see Section 8). The Summarizer role degrades gracefully: if Gemini 2.5 Flash fails, `thread_context` falls back to passing raw thread excerpts to the Reasoner.

### 3.4 Why a Provider Abstraction at MVP

For a 14-day project, a one-provider direct integration would be faster. We're taking the abstraction cost upfront because:

- It forces clean separation of "what the Engine wants" from "what Gemini's API expects."
- It makes prompt templates portable.
- It makes testing dramatically easier — we can mock `LLMClient` cleanly without mocking HTTP.
- Provider lock-in is a real production risk we don't want baked into the architecture from day one.

The abstraction is small (~150 LOC for the interface + Gemini impl). The cost is negligible; the upside is structural.

---

## 4. Prompt Library

All prompts live in `engine/llm/prompts/` as versioned Python modules. Never inline a prompt string in business logic.

### 4.1 Prompt Structure

Every prompt module exports:

```python
@dataclass
class PromptTemplate:
    name: str                          # "reasoner", "summarizer"
    version: str                       # "v1.0.0"
    role: Role
    system: str                        # static role/constraint preamble
    user_template: Template            # parameterized user message
    response_schema: type[BaseModel]   # required output shape
    eval_baseline: str | None          # which eval run last validated this version
```

Prompt versioning is semantic but informal. Bumping minor versions (v1.0 → v1.1) requires an eval run against the scenario library before merging. Bumping major versions (v1 → v2) requires an ADR.

### 4.2 The Reasoner Prompt (v1.0)

The most important prompt in the system. Located at `engine/llm/prompts/reasoner.py`.

**System prompt (static):**

```
You are ModPilot's investigation Reasoner. Your role is to produce a moderation
recommendation for a Reddit moderator based on accumulated evidence from an
investigation.

You do not take actions. You make recommendations. The moderator decides.

CRITICAL CONSTRAINTS:

1. CITATION CONTRACT. Every factual claim in your rationale must cite an
   evidence ID in the format [ev-N], where N matches an evidence row provided
   in the Evidence Block. Unsupported claims are bugs and will fail validation.

2. NO INVENTED FACTS. You may only reason from evidence that appears in the
   Evidence Block. If evidence is insufficient or contradictory, say so and
   recommend NO_ACTION with appropriately low confidence.

3. NO IDENTITIES. The Evidence Block uses anonymized user tokens (u_a, u_b,
   etc.). Use those tokens in your rationale. Do not invent usernames or
   real-world identities.

4. PERSONALITY-AWARE. The subreddit's moderation personality affects when
   to recommend action versus no action. Follow the personality guidance
   provided in the Subreddit Context.

5. CALIBRATED CONFIDENCE. Report a confidence in [0.0, 1.0]. This number
   will be combined with other signals downstream — it is not the final
   confidence shown to the moderator. Be honest. Low confidence is preferred
   over false certainty.

Your output must conform to the provided JSON schema. No prose outside it.
```

**User template (parameterized):**

```
## Subreddit Context
Personality: {personality_phrasing}
Region: {region}
Active rules:
{subreddit_rules}

## Report Summary
{report_summary}

## Evidence Block
{evidence_serialized}

## Investigation State
Tier: {tier}
Tools used: {tools_used}
Partial investigation: {is_partial}
Cold-start: {cold_start}

Produce your recommendation as a JSON object conforming to the schema.
```

**Response schema:**

```python
class ReasonerOutput(BaseModel):
    recommendation: Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_ACTION"]
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=20, max_length=600)
    cited_evidence_ids: list[str]
    flags: list[str] = Field(default_factory=list)
```

### 4.3 What the Reasoner Prompt Deliberately Doesn't Include

- **Raw content from Reddit.** The Reasoner sees evidence rows derived from the content, not the content itself. This keeps prompts compact, anonymizes naturally, and prevents the Reasoner from "re-investigating" instead of reasoning.
- **Raw usernames.** Anonymized to tokens (see Section 7).
- **Score weights, calibration math, or any internal signals.** The Reasoner doesn't need them; the Calibrator does its own work downstream.
- **Few-shot examples.** Sonnet does not need them for this task; few-shot bloats the prompt and biases toward the example shapes. Skip them.

### 4.4 The Summarizer Prompt (v1.0)

Located at `engine/llm/prompts/summarizer.py`. Invoked by `thread_context` when threads are large.

**System prompt:**

```
You are ModPilot's thread Summarizer. Compress a Reddit thread into a structured
summary that helps a moderator understand the conversation's trajectory.

Output JSON conforming to the schema. Be concise. Be factual. Do not editorialize.

PRINCIPLES:
- Identify the conversation arc in 1-2 sentences.
- Mark escalation points (turns where temperature rose sharply).
- Identify instigator candidates (users who turned calm exchanges hot).
- Flag if the thread is off-topic relative to the post.
- Do not infer intent. Describe behavior.
- Use anonymized user tokens (u_a, u_b, etc.).
```

**Response schema:**

```python
class ThreadSummary(BaseModel):
    arc: str = Field(max_length=200)
    escalation_points: list[EscalationPoint]
    instigator_candidates: list[str]   # anonymized tokens
    off_topic: bool
    notable_quotes: list[str] = Field(max_items=3)   # short, anonymized
```

Notable quotes are paraphrased, not verbatim — copyrighted content reproduction is not appropriate.

### 4.5 Prompt Maintenance Rules

- Every prompt change must be accompanied by an eval run against the scenario library (`eval/scenarios/`). Regressions block the merge.
- Prompt versions are immutable once shipped. Changes produce a new version.
- The `eval_baseline` field tracks which eval run last validated a version. PRs that bump prompts must update this field.
- No prompt may exceed 4,000 tokens in the system + user-template baseline (before evidence injection). Larger prompts indicate scope drift.

---

## 5. The Evidence-Citation Contract

This is the most important section in this document. The citation contract is what makes ModPilot's outputs **auditable**, and auditability is what makes them **trustworthy**.

### 5.1 What the Contract Says

Every factual claim in the Reasoner's `rationale` field must reference at least one evidence ID from the Evidence Block. Generic framing sentences ("Based on the investigation:") are allowed without citations; substantive claims are not.

Examples of compliant rationale text:

> "Author has 3 prior removals in this subreddit within the last 30 days [ev-2], including two for harassment [ev-3]. The current thread shows escalating personal attacks beginning at turn 8 [ev-5]. Combined with a clear match against Rule 2 [ev-1], this fits the established pattern of harassment violations."

Examples of non-compliant rationale text:

> "Author has prior history in this subreddit." (No citation — what history? where?)
>
> "This is clearly harassment." (Substantive claim with no evidence reference.)
>
> "The user @example_username has been warned." (Real identity instead of anonymized token; no citation.)

### 5.2 How It's Enforced

Three layers of enforcement, in order:

**Layer 1: Prompt instruction.** The system prompt's first constraint articulates the contract explicitly. This catches ~90% of compliance issues.

**Layer 2: Post-generation validation.** Located at `engine/llm/validation.py`. After the Reasoner returns:

```python
def validate_citations(output: ReasonerOutput, evidence: EvidenceAccumulator) -> ValidationResult:
    # 1. Parse evidence ID references from rationale
    references = parse_ev_references(output.rationale)   # finds [ev-N] patterns

    # 2. Every cited ID must exist in evidence
    valid_ids = {row.id for row in evidence.rows}
    hallucinated_ids = set(references) - valid_ids
    if hallucinated_ids:
        return ValidationResult.failed(reason="hallucinated_evidence_ids", details=hallucinated_ids)

    # 3. Every substantive sentence must contain at least one reference
    substantive_sentences = extract_substantive_sentences(output.rationale)
    uncited = [s for s in substantive_sentences if not contains_ev_reference(s)]
    if uncited:
        return ValidationResult.failed(reason="uncited_claims", details=uncited)

    # 4. cited_evidence_ids field must match what's in the rationale
    if set(output.cited_evidence_ids) != set(references):
        return ValidationResult.failed(reason="cited_field_mismatch")

    return ValidationResult.passed()
```

**Layer 3: Corrective retry.** On first validation failure, re-prompt the Reasoner with the validation errors:

```
Your previous output failed validation:
{validation_errors}

Produce a revised output that:
- Cites only evidence IDs present in the Evidence Block
- Includes [ev-N] references in every substantive sentence
- Keeps the same recommendation if the evidence supports it
```

One retry only. If it fails again:

- The verdict is **shipped with the partially-valid rationale.**
- Confidence is **demoted to LOW** (multiplier of 0.6 in the Calibrator).
- A `validation_failed=True` flag is attached to the verdict meta.
- The UI surfaces a subtle "ModPilot is unsure about this analysis" badge.
- A warning log fires with correlation ID, raw output, and validation errors.

### 5.3 What "Substantive Sentence" Means

The validator's substantive-sentence heuristic is in `engine/llm/validation.py` and uses:

- Sentence contains factual assertions about the user, content, thread, or pattern
- Sentence is not a framing/transition sentence ("In summary:", "Based on the above:")
- Sentence is not a recommendation statement ("Recommend Remove.")

The heuristic is imperfect; we tune it via the eval harness. If too many false positives surface in regression runs, we relax it; if hallucinations slip through, we tighten it.

### 5.4 Why This Matters

The citation contract is the answer to the question "Why should moderators trust ModPilot's recommendations?"

The honest answer is: because every claim is grounded in evidence the mod can verify, and every recommendation is traceable from "this fact in the system" through "this reasoning step" to "this recommendation." Without the contract, ModPilot is a generic LLM wrapper. With it, it's an auditable investigation system.

Every other reliability claim in the product depends on this. Treat the contract as load-bearing.

---

## 6. Hallucination Mitigation Stack

Beyond citation enforcement, the AI Layer has several other defenses against LLM fabrication.

### 6.1 Structured Output Only

The Reasoner and Summarizer both use structured outputs (JSON schema enforced via the LLMClient's response_schema parameter). Free-form prose is not accepted. This eliminates an entire class of failures where the model decides to "be helpful" by adding unrequested fields, caveats, or restructured content.

### 6.2 Schema-Locked Recommendations

The `recommendation` field is a `Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_ACTION"]`. The model cannot return "perhaps remove" or "I would suggest removing." Either it picks one of five values or the response fails parsing.

### 6.3 Bounded Rationale Length

The `rationale` field is `min_length=20, max_length=600`. Short enough that the model can't pad with filler; long enough to fit 2–3 well-cited sentences. This bounds the surface area for hallucination.

### 6.4 Evidence-Only Context

The Reasoner sees evidence rows, not raw Reddit content. This is deliberate. Raw content invites the model to "re-investigate" instead of reasoning from what tools have found. By restricting the context to structured evidence, we make hallucination structurally harder — there's no raw text from which to invent details.

### 6.5 Contradiction Surfacing

When the Evidence Accumulator detects contradictions (convergence score < 0.4 with ≥3 rows), the prompt explicitly informs the Reasoner:

```
NOTE: Evidence in this investigation is contradictory. Multiple signals point
in different directions. You should reflect this uncertainty in your
recommendation and confidence. Recommending NO_ACTION with calibrated low
confidence is appropriate when signals genuinely disagree.
```

This nudges the model toward honesty rather than picking a side at random.

### 6.6 Temperature

All Reasoner and Summarizer calls run at `temperature=0.0`. Determinism is a feature here. The same evidence should produce the same verdict.

### 6.7 No Tool Use in the Reasoner

The Reasoner does not have access to tools at the LLM layer. It cannot "look something up" mid-reasoning. Everything it needs is in the evidence block. This eliminates a major hallucination vector (models inventing tool calls or imagining tool results).

---

## 7. PII Anonymization

The Engine never sends raw usernames to LLM providers. Period.

### 7.1 The Anonymization Layer

Located at `engine/llm/anon.py`. A `Anonymizer` instance is created per investigation:

```python
class Anonymizer:
    def __init__(self):
        self._map: dict[str, str] = {}    # real_id → token (e.g., u_a)
        self._reverse: dict[str, str] = {}
        self._counter = 0

    def token_for(self, user_id: str) -> str:
        if user_id not in self._map:
            token = f"u_{chr(ord('a') + self._counter)}"
            self._map[user_id] = token
            self._reverse[token] = user_id
            self._counter += 1
        return self._map[user_id]

    def rehydrate(self, text: str) -> str:
        for token, real_id in self._reverse.items():
            text = text.replace(token, real_id)
        return text
```

Tokens are local to each investigation. The author of the reported comment might be `u_a` in one investigation and `u_c` in another. No global mapping exists — there is no token-to-user map that could leak cross-subreddit info.

### 7.2 What Gets Anonymized

Anything user-identifying that flows into a prompt:

- The report author's user ID → `u_a`
- The reporter's user ID → `u_b` (if surfaced in evidence)
- Any user IDs appearing in thread context, prior actions, or memory rows
- Display names where they appear

### 7.3 What Doesn't Get Anonymized

- Subreddit IDs and names. Subreddit context is not PII; it's needed for the prompt.
- Rule text (subreddit rules are public).
- Region (country-level only, never finer).
- Timestamps (relative or absolute — pattern detection needs them).

### 7.4 Rehydration

The Reasoner produces a rationale containing tokens like `u_a`. Before storing or displaying the verdict, the Engine rehydrates the tokens back to real IDs in a dedicated step. The UI then maps real IDs to display names via Reddit API calls (cached) before rendering.

Critical: **rehydration happens before storage in the audit log.** We retain the readable rationale for moderators, not the tokenized one. The anonymized version exists only in the prompt-to-LLM boundary.

### 7.5 Audit

A test in `engine/llm/test_anon.py` runs a synthetic investigation and asserts that no Reddit user ID appears in any LLM request payload. CI enforces it on every PR. The invariant is structural, not aspirational.

---

## 8. Caching Strategy

Caching is non-negotiable. Without it, the Engine would be too slow and too expensive to run at scale. Every cache is documented here; every cache key follows a strict naming convention.

### 8.1 What's Cached

| Cache | Key | TTL | Hit-rate target | Backing store |
|---|---|---|---|---|
| User profile | `user_profile:<user_id>:<sub_id>` | 1 hour | >80% | Redis |
| Thread summary | `thread_summary:<post_id>:<bucket>` | 24 hours | >70% on active threads | Redis |
| Policy embeddings | `policy_embed:<sub_id>:<rule_id>` | Indefinite (until settings change) | >99% | Redis (with Postgres fallback) |
| Verdict | `verdict:<target_id>` | 10 minutes | High during brigades | Redis |
| Cross-user pattern | `pattern:<sub_id>:<window>` | 15 minutes | N/A (MVP-stub) | Redis |
| Subreddit config | `subreddit_config:<sub_id>` | 60 seconds | >95% | Redis |

### 8.2 Cache Key Naming Rules

- Colons separate semantic levels (`type:scope:id`).
- The first segment identifies the cache type (`user_profile`, `thread_summary`).
- The last segment is always the most specific identifier.
- Subreddit ID always appears in keys for any subreddit-scoped data. Cross-subreddit leakage is structurally impossible because no cache key omits `sub_id` for sub-scoped data.

### 8.3 Why Each TTL

- **User profile (1h):** User memory changes when the user acts or gets moderated. A 1-hour staleness is acceptable. Pinpoint invalidation on `onModAction` updates the cache immediately for affected users.
- **Thread summary (24h):** Threads cool fast. A 24-hour TTL with bucket-based keying (`comment_count // 10 * 10`) ensures summaries refresh on meaningful growth without re-summarizing on every new comment.
- **Policy embeddings (indefinite):** Subreddit rules change rarely; when they do, the settings handler invalidates. Outside that, recomputing embeddings is wasteful.
- **Verdict (10min):** Same content getting re-reported within 10 minutes hits the cache. The verdict comes with a "this comment has been re-reported N times" annotation. Beyond 10 minutes, situation may have evolved (escalation, etc.) — re-investigate.
- **Cross-user pattern (15min):** Brigade windows are short; patterns expire quickly. Stub for MVP; real implementation in post-hackathon roadmap.
- **Subreddit config (60s):** Settings changes propagate within a minute. Faster invalidation isn't worth the cost.

### 8.4 Invalidation

Caches are invalidated by:

- **TTL expiry.** Default path.
- **Targeted invalidation:** `onModAction` invalidates `user_profile:<user>:<sub>` and `verdict:<target>`. Settings changes invalidate `policy_embed:<sub>:*` and `subreddit_config:<sub>`.
- **Manual flush:** A debug endpoint (admin-only) flushes a sub's caches. Used after major rule changes.

### 8.5 Cache Stampede Mitigation

For high-traffic hot keys (e.g., a thread summary during a viral thread), we use Redis's `SET NX` pattern to serialize concurrent misses:

```python
async def get_or_compute(key: str, ttl: int, compute: Callable):
    cached = await redis.get(key)
    if cached:
        return deserialize(cached)

    lock_key = f"lock:{key}"
    got_lock = await redis.set(lock_key, "1", nx=True, ex=5)
    if got_lock:
        try:
            value = await compute()
            await redis.setex(key, ttl, serialize(value))
            return value
        finally:
            await redis.delete(lock_key)
    else:
        # Wait briefly, then re-read cache
        await asyncio.sleep(0.1)
        cached = await redis.get(key)
        if cached:
            return deserialize(cached)
        # Fall through and compute anyway — better than waiting forever
        return await compute()
```

This is in `engine/store/redis.py` and used for the two most expensive caches (thread summary, policy embeddings).

### 8.6 Cache Miss Behavior

A cache miss is not an error. It's a normal event. The system always has a path to compute the missed value. The only places where a cache miss carries a hidden cost are:

- **Thread summary miss:** triggers a Haiku call (~$0.003, ~500ms).
- **Policy embedding miss:** triggers an embedding API call (~$0.0001, ~100ms per chunk).

Both are budgeted and bounded.

---

## 9. Cost Budgets

Cost is a first-class architectural concern. Every layer of the system has a budget; the AI Layer enforces the LLM portion.

### 9.1 Per-Investigation Budgets

From `04-InvestigationEngine.md`, the tier ceilings:

| Tier | Total cost ceiling | LLM cost share | Tool cost share |
|---|---|---|---|
| FAST | $0.005 | $0 (no LLM) | <$0.001 (embedding match) |
| STANDARD | $0.020 | ~$0.015 (Reasoner only) | <$0.005 (embedding + DB reads) |
| DEEP | $0.050 | ~$0.040 (Reasoner + maybe Summarizer) | <$0.010 |

The Reasoner is always the dominant cost line. Cost discipline begins with prompt size discipline.

### 9.2 Per-Subreddit Budgets

| Window | Cap | Behavior on cap hit |
|---|---|---|
| Hourly | $1.00 per subreddit | New investigations deferred to next window; banner in dashboard |
| Daily | $5.00 per subreddit | Same; daily total also visible to head mods |

These are MVP defaults. Adjustable per-deployment; documented in `13-Infra.md`. When a subreddit consistently hits caps, that's a signal to upgrade their tier (post-MVP feature).

### 9.3 Cost Tracking

Every `LLMResponse` carries a `cost_usd` field. This is propagated up through the orchestrator's `BudgetTracker` and persisted on every investigation row. Daily rollups aggregate per-subreddit costs for the dashboard.

### 9.4 Cost Optimization Levers

When latency or cost regresses, the levers (in order of preference):

1. **Increase cache hit rate.** Free latency and cost reduction.
2. **Trim prompt size.** Removing 1K tokens from the Reasoner prompt is real money at scale.
3. **Tighten early-stop thresholds.** Stops investigation sooner when evidence converges.
4. **Downshift tier defaults for the subreddit.** Per-sub `risk_weights` tuning.
5. **Skip Summarizer when threads are <15 comments.** Pass raw text to Reasoner instead.
6. Last resort: **switch a role to a cheaper model.** Requires ADR + eval validation.

---

## 10. Latency Targets

Latency is what moderators feel. We instrument and budget it aggressively.

### 10.1 Per-Investigation Targets

| Tier | p50 target | p95 target | p99 budget |
|---|---|---|---|
| FAST | 800ms | 1.5s | 2s (hard cap) |
| STANDARD | 3s | 5s | 7s (hard cap) |
| DEEP | 6s | 10s | 12s (hard cap) |

The hard cap is enforced by the orchestrator's BudgetTracker. Exceeding it triggers a partial-verdict exit.

### 10.2 Per-Call LLM Targets

| Role | p50 target | p95 target |
|---|---|---|
| Reasoner (Sonnet) | 2.5s | 5s |
| Summarizer (Haiku) | 500ms | 1.2s |

These are end-to-end (request → parsed response), not pure API latency. Includes retry overhead.

### 10.3 Latency Optimization Levers

In order of preference when latency regresses:

1. **Parallel tool execution where dependencies allow.** Many tools are independent; running them in parallel halves orchestration latency.
2. **Cache warmth.** Same lever as cost; helps everywhere.
3. **Smaller prompts.** Sonnet latency scales with input tokens; trim.
4. **Tighter timeouts on retries.** First retry runs at 70% of original timeout; tunes the latency tail.
5. **Tier downshift.** Less depth = less work = lower latency.

### 10.4 Streaming Decision

We do **not** stream LLM responses to the UI in MVP. The verdict is built atomically: gather evidence, reason, calibrate, return one final object to Devvit. Streaming would add complexity to validation (we can't validate citations mid-stream) and would only marginally affect perceived latency since most of the wait happens before the Reasoner runs (tool execution).

Post-MVP, consider streaming the Investigation Timeline as tools complete — that's a UX win without breaking validation.

---

## 11. Failure Modes

How the AI Layer fails, and what happens when it does.

| Failure | Detection | Behavior |
|---|---|---|
| LLM provider 5xx | HTTP status | Retry per policy; fallback to rule-based verdict with LOW confidence if all retries fail |
| LLM provider timeout | Async timeout | Retry once with 70% timeout; fallback to rule-based verdict |
| LLM returns malformed JSON | Schema parse fails | Corrective retry with parse error in prompt; second failure → demote confidence to LOW |
| Validation fails (citations) | Post-generation check | Corrective retry; second failure → ship partial verdict with LOW confidence + validation_failed flag |
| Anonymization layer error | Test/assertion | Hard failure — don't ship verdicts that may leak PII |
| Cache backend down | Redis unreachable | Bypass cache; latency and cost spike; alerts fire |
| Cost ceiling exceeded mid-investigation | BudgetTracker | Stop new LLM calls; produce partial verdict from current evidence |
| Prompt template missing/corrupted | Startup load | Service refuses to start; CI catches; not a runtime failure |

### 11.1 The Rule-Based Fallback Verdict

When the Reasoner is fully unavailable (all retries failed, provider down), the Engine still produces a verdict using a heuristic fallback:

```python
def rule_based_fallback(evidence: EvidenceAccumulator, profile: SubredditProfile) -> ReasonerOutput:
    # Use rule_match_strength + report_velocity as the primary signal
    if evidence.rule_match_strength() > 0.8 and evidence.has_high_velocity():
        recommendation = "REMOVE"
        confidence = 0.55
        rationale = (
            f"Strong policy match [ev-1] and elevated report velocity [ev-2] indicate "
            f"likely violation. Reasoner unavailable; recommendation based on rule signals only."
        )
    elif evidence.rule_match_strength() < 0.3:
        recommendation = "APPROVE"
        confidence = 0.50
        rationale = (
            f"No strong policy match [ev-1]. Reasoner unavailable; recommendation "
            f"based on rule signals only."
        )
    else:
        recommendation = "NO_ACTION"
        confidence = 0.40
        rationale = (
            f"Evidence is ambiguous and the Reasoner is currently unavailable. "
            f"Recommend manual review."
        )

    return ReasonerOutput(...)
```

Fallback verdicts are always marked `fallback=True` and demoted to at most MEDIUM confidence. The UI surfaces them clearly: "ModPilot's reasoning service is degraded — this verdict is based on basic signals only."

Critical: **fail closed, not open.** A NO_ACTION fallback verdict is acceptable. A confidently-wrong REMOVE fallback verdict is not. The thresholds above are deliberately conservative.

---

## 12. Observability

Every LLM call emits structured logs and metrics.

### 12.1 Required Log Fields

For every LLM call:

- `correlation_id` — threads through Devvit → Engine → LLM
- `role` — reasoner / summarizer
- `model` — actual model string used
- `prompt_version` — for ablation
- `input_tokens`, `output_tokens`
- `latency_ms`
- `cost_usd`
- `validation_passed` (Reasoner only)
- `validation_failures` (Reasoner only, if any)
- `subreddit_id` (for cost attribution)

These flow into Grafana for dashboards and into the analytics tables for the mod-facing dashboard.

### 12.2 Required Metrics

- `llm.calls.total{role, model, status}`
- `llm.latency_ms{role, model}` (histogram)
- `llm.cost_usd{role, subreddit_id}` (counter)
- `llm.tokens{role, direction}` (counter; direction = input/output)
- `validation.passed_rate{prompt_version}` (gauge)
- `validation.failed_count{reason}` (counter)
- `cache.hit_rate{cache_name}` (gauge)

### 12.3 Per-Investigation Audit

Every investigation row in Postgres stores:

```
investigations
├── reasoner_input_tokens
├── reasoner_output_tokens
├── reasoner_latency_ms
├── reasoner_cost_usd
├── reasoner_prompt_version
├── summarizer_tokens (if used)
├── validation_passed
└── validation_retry_count
```

This is what powers the "ModPilot's accuracy in your subreddit" and "cost this week" tiles in the mod dashboard.

---

## 13. Evaluation Hooks

Every prompt version is validated against the scenario library before shipping. The full eval system is documented in `11-Evaluation.md`; this section covers the AI Layer's contribution.

### 13.1 Eval Inputs

Each scenario in `eval/scenarios/` provides:

- A simulated report
- A simulated set of tool results (so the Reasoner is the only variable)
- An expected recommendation and confidence range
- An expected validation result

### 13.2 Eval Metrics

For each prompt version against the scenario library:

- **Recommendation accuracy** — % of scenarios where the recommendation matches expected
- **Confidence calibration** — RMSE between predicted and expected confidence
- **Validation pass rate** — % of scenarios where validation passes on first try
- **Cost regression** — average cost vs. baseline
- **Latency regression** — average latency vs. baseline

### 13.3 Eval Gates

PRs that modify prompts cannot merge unless:

- Recommendation accuracy ≥ baseline – 2%
- Validation pass rate ≥ 95%
- Cost regression ≤ +10%
- Latency regression ≤ +15%

These gates are enforced by CI on every PR touching `engine/llm/prompts/`.

---

## 14. AI Layer Invariants

Properties that must always hold. Each is tested.

1. **No raw user ID ever appears in an LLM request payload.** Enforced by `test_anon.py`.
2. **No prompt module loads without a `response_schema`.** Enforced by module import-time assertion.
3. **No Reasoner verdict ships without a citation validation result attached.** Enforced by orchestrator pipeline.
4. **No LLM call lacks a correlation ID.** Enforced by `LLMClient` interface.
5. **Cost is recorded on every successful LLM call.** Enforced by `LLMClient` post-processing.
6. **Models are read from config, not hardcoded.** Enforced by code review and grep CI check.
7. **No prompt exceeds 4,000 baseline tokens.** Enforced by import-time check on `PromptTemplate`.
8. **Every prompt change ships with an eval baseline reference.** Enforced by CI on `engine/llm/prompts/` changes.

Violating any of these is a bug.

---

## 15. Open Questions

Decisions deferred until evidence arrives:

- **Should the Summarizer use streaming for very long threads?** Defer until we see latency complaints on 100+ comment threads.
- **Is a "Planner" LLM (designing custom tool plans per report) worth the latency?** Currently no — the Strategy Selector's heuristic tiering performs well in eval. Revisit if eval shows tier mismatches.
- **Should we A/B test prompt versions in production?** Tempting; defer until traffic supports statistical power. For MVP, eval harness is the validation tool.
- **At what scale does it pay to self-host an embedding model?** Currently embeddings hit the LLM provider; cost is trivial. Reassess at 1M+ investigations/month.

Tracked in root `CLAUDE.md`.

---

## 16. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — Where the AI Layer sits in the system.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — How the Reasoner integrates with orchestration, calibration, and validation.
- [`05-Memory.md`](05-Memory.md) — How memory-derived evidence flows into prompts.
- [`07-DataLayer.md`](07-DataLayer.md) — Postgres + Redis backing for caches and audit.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Graceful degradation, hallucination as a safety concern, PII rules.
- [`11-Evaluation.md`](11-Evaluation.md) — Scenario harness that gates prompt changes.
- [`12-Analytics.md`](12-Analytics.md) — How LLM metrics feed the mod-facing dashboard.
- [`14-Engineering.md`](14-Engineering.md) — Python async patterns, testing for LLM-adjacent code.
- [`Glossary.md`](Glossary.md) — Terminology rules; the banned-words list.