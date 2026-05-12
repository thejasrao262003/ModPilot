# Specs.md

> **Consolidated technical specification for ModPilot.** One-page-above the 15 area docs. Defines invariants, contracts, and data shapes; defers detailed rationale to the area docs. If anything here conflicts with an area doc, the area doc wins — file an issue and re-sync this file.
>
> **Status:** Living. Re-sync after any Canon-tier doc change or ADR.
> **Last sync:** 2026-05-12.

---

## 1. Product

### 1.1 What it is

ModPilot is a **context-aware investigation engine for Reddit moderation**, built on Devvit. On every incoming report, ModPilot runs the five lookups an experienced moderator would do manually — user history, thread context, rule match, report patterns, prior actions — then surfaces a verdict with the full evidence trail. The moderator decides.

### 1.2 Thesis

> Most moderation tools classify content. ModPilot investigates context.

`report → investigate → reason → recommend → learn`. Classification is a byproduct of investigation, not the goal. See [01-Product.md](01-Product.md).

### 1.3 Non-goals

- Autonomous moderation actions. **Never.**
- Content classification as the primary product surface.
- Reinforcement-learning training on production traffic (banned terminology and banned mechanism).
- Multi-platform (Discord, Twitch, Slack) — Reddit-only for MVP.
- Local / open-weight models — Gemini-only at hackathon scale.
- Cross-subreddit data sharing without explicit opt-in.

### 1.4 Success milestones

1. **Install → first investigation in under 3 minutes.** Judged.
2. **First Verdict Card lands within view of an expanded Investigation Timeline.** The signature moment.
3. **First *"I'm unsure"* verdict appears within first day of install.** The trust moment.

---

## 2. Hard Invariants (must never be violated)

| # | Invariant | Enforced by |
|---|---|---|
| I-1 | Human-in-the-loop is mandatory; no autonomous mod action | UI (no auto-fire) + API contract |
| I-2 | Every verdict claim cites an evidence ID | Prompt + post-generation validator in `engine/llm/validation.py` |
| I-3 | Low confidence (<0.60) shows *"unsure"* — never a styled primary button | UI invariant; calibrator output |
| I-4 | Cold-start mode active until 50+ feedback events accumulate | `engine/memory/coldstart.py` |
| I-5 | Engine outage degrades gracefully; native mod queue keeps working | Devvit trigger fail-closed path |
| I-6 | Every recommendation is expandable into its Investigation Timeline | UI + verdict schema |
| I-7 | Every persisted query is `subreddit_id`-scoped | DB layer guard + lint |
| I-8 | `devvit-app/` never imports from `engine/` (or vice versa); `eval/` may import from `engine/` | Import lint rule |

Violating any of these is a bug, not a tradeoff.

---

## 3. Terminology Contract

**Banned** in user-facing code, UI, prompts, and docs: `RL`, `reinforcement learning`, `policy`, `reward`, `training`, `episode`, `action space`, `observation space`, `value function`, `agent`, `trajectory`.

**Translation table:**

| Internal concept | Product term |
|---|---|
| Action space | Tool Registry |
| Observation space | Evidence Accumulator |
| Trajectory | Investigation Timeline |
| Reward signal | Confidence Calibration |
| Policy | Investigation Strategy |
| Scenario generator | Evaluation Harness |
| Multi-step reasoning | Adaptive Investigation |

Backend service is the **Investigation Engine**, never the "AI backend." (Pending dedicated `Glossary.md`; this table is authority until then.)

---

## 4. System Architecture

### 4.1 Topology

Three services, two stores, one external API:

```
Reddit  →  Devvit App (TS, edge)  →  Investigation Engine (Python, FastAPI on Fly.io)
                  ↓                              ↓
              Devvit KV                Postgres (memory, feedback, audit)
                                       Redis (profile, summary, verdict cache)
                                       Gemini API (Reasoner + Summarizer)
```

Details in [02-Architecture.md](02-Architecture.md) and [13-Infra.md](13-Infra.md).

### 4.2 Layer rules

- `devvit-app/` (TypeScript) — Devvit-specific only. Triggers, settings, jobs, UI Blocks. Never imports from `engine/`.
- `engine/` (Python) — Investigation logic. Never imports from `devvit-app/`.
- `eval/` (Python) — Scenario harness. May import from `engine/` for in-process runs.
- `docs/` — Markdown only.

### 4.3 Data flow (canonical happy path)

1. Reddit fires `CommentReport` → Devvit trigger.
2. Trigger dedupes (10-min window in Devvit KV), enriches with cheap context, calls `POST /investigate` over HMAC-signed HTTPS.
3. Engine: Strategy Selector picks tier (Fast/Standard/Deep) → Orchestrator drives Tool Registry → tools populate Evidence Accumulator → Reasoner generates verdict with citations → Calibrator adjusts confidence.
4. Engine returns `Verdict` JSON. Devvit writes to KV, renders Verdict Card.
5. Moderator clicks an action → Reddit API call + `onModAction` trigger captures alignment as feedback.
6. Nightly batch refines subreddit personality weights.

---

## 5. Tech Stack (locked — changes require ADR)

| Concern | Choice |
|---|---|
| Devvit app | TypeScript, Devvit SDK, Devvit Blocks UI |
| Engine | Python 3.11, FastAPI, asyncio |
| Hosting | Fly.io (Engine + Worker), Devvit platform (app) |
| Reasoner LLM | **Gemini 2.5 Pro** (`gemini-2.5-pro`) |
| Summarizer / Planner LLM | **Gemini 2.5 Flash** (`gemini-2.5-flash`) |
| SDK | `google-genai` |
| Postgres | Supabase or Neon (free tier MVP) |
| Redis | Upstash (free tier MVP) |
| Observability | Structured JSON logs + Grafana Cloud |
| Lint | `ruff` + `mypy --strict` (Python); `eslint` + `tsc --noEmit` (TS) |
| Tests | `pytest` (Python); `jest` (TS) |

---

## 6. Devvit App Spec

Detail: [03-Devvit.md](03-Devvit.md).

### 6.1 Triggers (subscribed)

| Trigger | Purpose |
|---|---|
| `CommentReport` | Primary investigation entry point |
| `PostReport` | Same path, post-shaped target |
| `ModAction` | Captures moderator decision → feedback record |
| `AppInstall` | Bootstraps personality config + wizard state |
| `AppUpgrade` | Schema migrations, no behavior change |

### 6.2 Settings (per-subreddit)

- `personality` — `strict | balanced | lenient` (default `balanced`)
- `rules` — paragraph text (pre-filled from `modwiki` if available)
- `region` — `US | EU | UK | IN | Global` (default `Global`)
- `showCostInDashboard` — boolean (default `false`)
- `killSwitch` — boolean (default `false`); when true, engine calls suspend
- `tierOverride` — `auto | fast | standard | deep` (default `auto`)

### 6.3 Scheduled jobs

- `priority-rollup` — every 5 min; re-sorts pending queue by velocity.
- `feedback-batch` — nightly; aggregates `ModAction` feedback into personality weights.

### 6.4 UI components (see §11 for layout)

`VerdictCard`, `InvestigationTimeline`, `ConfidenceBadge`, `RiskPill`, `EvidenceRow`, `ActionBar`, `ColdStartBadge`, `ModDashboard`, `FirstRunWizard`, `MemoryView`, `ThreadSummaryView`, `Banner`. All consume `ui/tokens.ts` and `ui/copy.ts`. No inline strings or colors.

---

## 7. Investigation Engine Spec

Detail: [04-InvestigationEngine.md](04-InvestigationEngine.md).

### 7.1 Strategy Selector

Cheap heuristic (~50ms, no LLM) that picks an investigation tier from report metadata + cached signals:

| Tier | Tool budget | Time budget | Cost budget | Reasoner? |
|---|---|---|---|---|
| **FAST** | 1–2 tools | 800 ms | $0.003 | Optional, rule-shortcut allowed |
| **STANDARD** | 4 tools (4 or 5 — *open question*) | 3 s | $0.012 | Always |
| **DEEP** | 5+ tools, may re-loop | 6 s | $0.030 | Always |

Inputs: report count, report velocity z-score, author trust tier, rule-match precheck, subreddit personality.

### 7.2 Orchestrator

Async loop. For each step: picks next tool, runs it, appends result to Evidence Accumulator, decides to continue / early-stop / budget-exit. Hard caps from tier budgets are non-negotiable.

### 7.3 Tool Registry

Fixed five tools at MVP. Internal name (snake_case) maps to UI verb (see §11.5):

| Tool | LLM? | Latency target |
|---|---|---|
| `policy_match` | No (embedding similarity over rules) | <200 ms |
| `report_velocity` | No (Redis sliding-window count) | <30 ms |
| `user_history` | No (Postgres read of memory) | <120 ms |
| `prior_actions` | No (Postgres read of audit log) | <120 ms |
| `thread_context` | **Yes** (Gemini 2.5 Flash; only if thread ≥10 comments) | <1.5 s |

Tool result shape:

```python
@dataclass
class ToolResult:
    tool: str
    success: bool
    evidence_id: str          # "ev-N", monotonic per investigation
    summary: str              # ≤200 chars; renders in Verdict Card
    detail: dict              # arbitrary, surfaces in Timeline expansion
    latency_ms: int
    error: str | None = None
```

### 7.4 Evidence Accumulator

Append-only list of `ToolResult`. IDs are stable for the lifetime of the investigation and referenced by the Reasoner. Validator enforces every `[ev-N]` in the verdict resolves to an entry here.

### 7.5 Reasoner

Single Gemini 2.5 Pro call. Inputs: accumulated evidence, subreddit personality, rules, target snippet. Output is JSON-shaped (Pydantic schema) with:

```python
class ReasonerOutput(BaseModel):
    risk_tier: Literal["HIGH", "MEDIUM", "LOW"]
    recommendation: Literal["REMOVE", "APPROVE", "ESCALATE", "LOCK", "NO_RECOMMENDATION"]
    rationale: str                              # citations inline
    top_evidence_ids: list[str]                 # max 3, ordered
    raw_confidence: float                       # 0..1, self-report
    citation_check: list[str]                   # IDs the model claims to have used
```

Post-generation validator: every `[ev-N]` in `rationale` must appear in `top_evidence_ids` AND in the accumulator. Mismatch → reject and retry once with a corrective prompt.

### 7.6 Confidence Calibrator

Four inputs, weighted blend → calibrated confidence:

| Input | Source |
|---|---|
| LLM self-report | `raw_confidence` (discounted by historic over-confidence factor for this subreddit) |
| Evidence convergence | Agreement score across tool outputs |
| Subreddit accuracy (30d) | Acceptance rate of recent ModPilot verdicts in this subreddit |
| Rule-match strength | Embedding similarity score from `policy_match` |

Tiers: HIGH ≥0.80, MEDIUM 0.60–0.80, LOW <0.60. LOW → `NO_RECOMMENDATION` and the "I'm unsure" UX (§11.4).

---

## 8. AI Layer

Detail: [06-AILayer.md](06-AILayer.md).

### 8.1 Role assignments

| Role | Model | Use |
|---|---|---|
| Reasoner | `gemini-2.5-pro` | Final verdict generation |
| Summarizer | `gemini-2.5-flash` | `thread_context` for threads ≥10 comments |
| No-LLM | Deterministic Python | All other tools |

Model strings live in env vars `MODEL_REASONER` and `MODEL_SUMMARIZER`. Bumping a model requires an ADR.

### 8.2 Provider abstraction

```python
class LLMClient(Protocol):
    async def complete(
        self, *, role: Role, messages: list[Message],
        response_schema: type[BaseModel] | None = None,
        max_tokens: int, temperature: float = 0.0,
        timeout_ms: int, correlation_id: str,
    ) -> LLMResponse: ...
```

Default implementation `engine/llm/gemini.py` wraps `google-genai`.

### 8.3 Citation contract (load-bearing)

Every assertion in `rationale` carries `[ev-N]`. Enforced by:
1. Prompt instruction with examples.
2. JSON-schema `response_schema` (Pydantic).
3. Post-generation regex + accumulator membership check.

A verdict that fails validation triggers one corrective retry; second failure → fallback verdict (rule-based) with `validation_flag = true` and an amber UI banner.

### 8.4 Retry / fallback policy

| Failure | Policy |
|---|---|
| Timeout | 1 retry at 70% timeout |
| 5xx | up to 2 retries with backoff (250ms, 750ms) |
| 429 | respect `retry-after` up to 3s |
| Other 4xx | no retry; surface error |
| Reasoner total failure | Rule-based fallback verdict + `degraded = true` |
| Summarizer total failure | `thread_context` passes raw excerpts to Reasoner |

---

## 9. Data Model

Detail: [07-DataLayer.md](07-DataLayer.md). Every table has `subreddit_id`.

### 9.1 Postgres tables (canonical)

| Table | Purpose |
|---|---|
| `subreddit_profile` | personality, rules, region, cold-start counter, calibration weights |
| `user_memory` | per-(subreddit, user): risk tier, prior violations, last seen |
| `thread_memory` | per-(subreddit, thread): escalation flag, summary cache key, last activity |
| `investigation` | one row per Engine call: correlation_id, tier, latency, cost, verdict |
| `evidence` | child of `investigation`: tool name, summary, detail (JSONB), latency |
| `feedback` | mod alignment with ModPilot's recommendation; drives cold-start counter |
| `audit_log` | every recommendation + every mod action; immutable, queryable |

Migrations via Alembic. Every schema change updates `07-DataLayer.md` in the same PR.

### 9.2 Redis keyspace

| Key pattern | Value | TTL |
|---|---|---|
| `profile:{sub_id}:{user_id}` | cached `user_memory` row | 1h |
| `summary:{thread_id}` | thread summary blob | 24h |
| `velocity:{sub_id}:{target_id}` | sliding-window report count | 1h |
| `verdict:{correlation_id}` | full verdict for "Explain last call" menu | 7d |
| `wizard_state:{sub_id}` | onboarding wizard progress | 30d |
| `embedding:{rule_id}` | precomputed rule embedding | 30d |

---

## 10. API Surface

Detail: [08-API.md](08-API.md). All requests HMAC-signed with a shared secret per subreddit install.

### 10.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/investigate` | Primary call — report in, verdict out |
| POST | `/feedback` | Records mod action alignment |
| POST | `/explain` | Re-fetches a cached verdict by `correlation_id` |
| GET | `/health` | Liveness + readiness + model identifiers |
| GET | `/config/:sub_id` | Returns server-side config snapshot for the subreddit |

### 10.2 `/investigate` shape

**Request:**
```json
{
  "correlation_id": "uuid",
  "subreddit_id": "t5_xxx",
  "target": { "kind": "comment", "id": "t1_xxx", "body": "...", "author": "u/..." },
  "report": { "reasons": ["spam", "harassment"], "reporter_count": 4, "first_at": "...", "last_at": "..." },
  "context": { "thread_id": "t3_xxx", "thread_excerpts": [...] }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "correlation_id": "uuid",
    "tier": "DEEP",
    "verdict": {
      "risk_tier": "HIGH",
      "recommendation": "REMOVE",
      "calibrated_confidence": 0.92,
      "rationale": "Author has [ev-2] three prior removals; thread escalates [ev-5]...",
      "top_evidence": [ { "id": "ev-4", "summary": "...", "tool": "report_velocity" }, ... ],
      "timeline": [ { "tool": "policy_match", "verb": "Matched against rules", "latency_ms": 142, "evidence_ids": ["ev-1"] }, ... ],
      "confidence_breakdown": {
        "llm_self_report": 0.95,
        "evidence_convergence": 0.88,
        "subreddit_accuracy": 0.87,
        "rule_match_strength": 0.96
      },
      "model_reasoner": "gemini-2.5-pro",
      "model_summarizer": "gemini-2.5-flash",
      "cost_usd": 0.018,
      "validation_flag": false,
      "degraded": false,
      "cold_start": false
    }
  }
}
```

### 10.3 Error envelope

```json
{ "ok": false, "error": { "code": "ENGINE_DEGRADED", "message": "...", "retryable": true } }
```

Codes: `BAD_REQUEST`, `UNAUTHORIZED`, `RATE_LIMITED`, `BUDGET_EXHAUSTED`, `ENGINE_DEGRADED`, `TIMEOUT`, `INTERNAL`.

---

## 11. UI Surfaces

Detail: [09-UX.md](09-UX.md). Wireframe: [`mockups/moderator-ui.html`](../mockups/moderator-ui.html).

### 11.1 Verdict Card

One-glance triage. Inline on every report in the mod queue. Layout:

```
Risk pill          Recommendation (or "🌱 unsure — your call")          Confidence badge
─────────────────────────────────────────────────────────────────────────────────────
• Top evidence 1                                                         [ev-N]
• Top evidence 2                                                         [ev-N]
• Top evidence 3                                                         [ev-N]
─────────────────────────────────────────────────────────────────────────────────────
[ Remove ]  [ Approve ]  [ Escalate ]  [ Lock ]                  View reasoning ▾
```

- Primary action button is filled **only** for HIGH-confidence verdicts AND not cold-start.
- LOW confidence: no primary styling; marginalia note appears above evidence.
- Exactly 3 evidence rows when available; never pad.
- Confidence shown as percentage + tier indicator (▲ HIGH, ● MEDIUM, ▼ LOW).

### 11.2 Investigation Timeline

Expandable below the card. Forensic ledger: one row per tool with status icon, verb (past tense, never raw tool name), latency, evidence chips. Sticky Verdict Block with rationale + model + cost + four-bullet confidence breakdown. Animated atomic render at MVP (streaming is post-MVP).

### 11.3 Dashboard

Custom post, mod-only:
- Four tiles: investigated count, time saved, acceptance rate, today's cost (last hidden unless `showCostInDashboard`).
- Tier breakdown bar (Fast / Standard / Deep).
- Prioritized queue table.
- Cold-start badge if active.

### 11.4 Honest uncertainty UX

Triggers when calibrated confidence <0.60. Replaces recommendation chip with *"🌱 ModPilot is unsure — your call"*. All four action buttons visually equal. Evidence still surfaces. Copy (centralized in `ui/copy.ts`):

> "I found the following but I'm not confident enough to recommend an action. Your judgment matters here."

This is the single most demoable trust feature.

### 11.5 Tool verb map (UI-facing)

| Tool | UI verb |
|---|---|
| `policy_match` | "Matched against rules" |
| `report_velocity` | "Checked report velocity" |
| `user_history` | "Pulled author history" |
| `prior_actions` | "Reviewed prior mod actions" |
| `thread_context` | "Read thread context" |

Never expose raw tool names.

### 11.6 First-Run Wizard

Three steps, <3 min total: personality → rules + region → test investigation against the most recent unactioned report. Resumable via `wizard_state:{sub_id}` in Devvit KV.

### 11.7 Design tokens (visual)

Tokens live in `devvit-app/src/ui/tokens.ts`. Risk colors from §2 of [09-UX.md](09-UX.md):
- `color.riskHigh` `#D93025`
- `color.riskMedium` `#F9AB00`
- `color.riskLow` `#1E8E3E`

Wireframe at [`mockups/moderator-ui.html`](../mockups/moderator-ui.html) uses muted variants of these (forensic-dossier aesthetic) and the canonical hex values for badges.

---

## 12. Memory, Cold-Start, Personalities

Detail: [05-Memory.md](05-Memory.md).

### 12.1 Cold-start

New install runs in conservative mode until 50 feedback events accumulate:
- Action thresholds raised by +10 percentage points.
- No primary-action prefill regardless of confidence.
- Cold-start badge visible on every surface.
- Transition is automatic when counter crosses 50; reversible from settings.

### 12.2 Subreddit personalities

| Preset | Behavior |
|---|---|
| **Strict** | Lower remove threshold, higher escalate rate. r/AskHistorians, r/news. |
| **Balanced** | Default. Most general subreddits. |
| **Lenient** | Higher remove threshold, more approve recommendations. r/dankmemes, casual subs. |

Personality blends into confidence thresholds and Reasoner prompt context. Power-user customization deferred post-MVP.

### 12.3 Memory tiers (UI-facing)

User memory exposed only as tier labels: `new | trusted | neutral | watched`. Never as numeric scores. "Wipe this user's memory" is a soft delete with audit trail.

---

## 13. Reliability & Safety

Detail: [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md).

### 13.1 Degradation matrix

| Failure | UX | Mechanism |
|---|---|---|
| Engine unreachable | Card hidden; banner: "ModPilot temporarily unavailable" | Devvit catches HTTP error, falls through to native queue |
| Gemini Reasoner fails | Fallback verdict + amber footnote "Basic signals only" | Rule-based fallback in orchestrator |
| Gemini Summarizer fails | `thread_context` passes raw excerpts to Reasoner | Same investigation continues, lower confidence |
| Reddit API rejects mod action | Toast: "Reddit rejected the action. Try again or do it manually." | Verdict stays pending |
| Budget exhausted | Banner: "Throttled until HH:MM" | Daily cap in `engine/budget.py` |
| Kill switch on | Banner: "ModPilot is paused" | Setting `killSwitch=true` short-circuits the trigger |

### 13.2 Rate limits & budgets

Daily Gemini spend cap per subreddit (open question: exact value, tracked in [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)). When breached → `503 ENGINE_DEGRADED` until UTC midnight.

### 13.3 PII & data

- Comment bodies stored in `investigation.target_body` only for 30d (configurable retention).
- User memory keyed by Reddit `user_id`, not username.
- Audit log immutable, retained 90d.
- No cross-subreddit data sharing without explicit opt-in.

---

## 14. Cost & Performance Targets

| Metric | Target |
|---|---|
| Median investigation latency | 3.2 s |
| p95 latency | 6.8 s |
| Median cost / investigation | $0.01 |
| Daily hackathon spend | <$5/day across all installs |
| Engine cold-start time (Fly.io) | <8 s |
| CI total time (non-eval PR) | <5 min |
| CI total time (eval-gated PR) | <12 min |

Cost panel in dashboard surfaces these per-subreddit.

---

## 15. Observability

Structured JSON logs (Python: `engine/observability/logging.py` helpers; TS: `services/logger.ts`). Every log carries `correlation_id`. Grafana Cloud aggregates.

Key events:
- `investigation.started / .completed / .failed`
- `tool.called / .succeeded / .timeout`
- `llm.call.started / .succeeded / .retry / .fallback`
- `validation.passed / .rejected`
- `mod_action.recorded`
- `budget.exceeded`
- `kill_switch.toggled`

Dashboards: per-subreddit accuracy, latency p50/p95, cost rolling 24h, kill-switch state.

---

## 16. Evaluation

Detail: [11-Evaluation.md](11-Evaluation.md).

### 16.1 Eval harness

Scenario library (OpenENV-derived) under `eval/scenarios/`. Each scenario is a JSON fixture: report shape + thread context + expected verdict band (recommendation + acceptable confidence range).

### 16.2 Eval gate

CI runs the full harness when:
- A prompt module changes.
- The Orchestrator or Strategy Selector changes.
- The Calibrator changes.

Gate fails if recommendation accuracy drops by >3 percentage points vs. baseline or if calibration error widens by >5 percentage points.

### 16.3 Baselines pinned in `eval/baseline.json`. Updated only after eval gate review.

---

## 17. Acceptance Criteria (per surface)

A surface is "done" when:

| Surface | Done = |
|---|---|
| Devvit trigger | Receives event, dedupes within 10 min, calls Engine, writes verdict to KV |
| Engine `/investigate` | Returns valid `Verdict` JSON matching schema for all sample scenarios |
| Tool | Implements `ToolResult` contract, includes unit + integration test, listed in registry |
| Reasoner prompt | Eval harness passes; citation validator passes; verdict schema validates |
| Verdict Card | Renders all 8 states from [09-UX.md §4.6](09-UX.md); LOW conf shows unsure UX; matches mockup |
| Investigation Timeline | All tool results render with verbs from §11.5; evidence chips clickable |
| Dashboard | Four tiles populate from real DB; queue sorted by priority score |
| Wizard | Completes in <3 min; resumable; persists to KV |
| Eval | Baseline pinned; gate runs in CI; runs in <7 min |

---

## 18. Open Questions

Tracked in [CLAUDE.md](../CLAUDE.md) and the relevant area doc:

1. Standard tier defaults to 4 or 5 tools? → [04-InvestigationEngine.md](04-InvestigationEngine.md)
2. Exact daily Gemini spend cap per subreddit? → [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)
3. Cold-start "learning" badge final copy? → [09-UX.md](09-UX.md)
4. Whether `docs/Glossary.md` and `docs/adr/` get scaffolded in week 1?
5. Streaming Investigation Timeline rows (post-MVP — deferred).

Don't guess. Surface as `// TODO(open-question)` in code.

---

## 19. Related Documents

| Area | Doc |
|---|---|
| Product / personas | [01-Product.md](01-Product.md) |
| Architecture / topology | [02-Architecture.md](02-Architecture.md) |
| Devvit triggers / settings / UI primitives | [03-Devvit.md](03-Devvit.md) |
| Investigation Engine logic | [04-InvestigationEngine.md](04-InvestigationEngine.md) |
| Memory / personalities / cold-start | [05-Memory.md](05-Memory.md) |
| LLM / prompts / citation contract | [06-AILayer.md](06-AILayer.md) |
| Postgres schema / Redis keyspace | [07-DataLayer.md](07-DataLayer.md) |
| API surface | [08-API.md](08-API.md) |
| UX / Verdict Card / Timeline | [09-UX.md](09-UX.md) |
| Reliability / safety / degradation | [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md) |
| Evaluation harness | [11-Evaluation.md](11-Evaluation.md) |
| Analytics | [12-Analytics.md](12-Analytics.md) |
| Infra / deployment | [13-Infra.md](13-Infra.md) |
| Engineering standards / Claude Code workflow | [14-Engineering.md](14-Engineering.md) |
| Hackathon submission | [15-Hackathon.md](15-Hackathon.md) |
| Root operating contract | [../CLAUDE.md](../CLAUDE.md) |
| UI wireframe | [../mockups/moderator-ui.html](../mockups/moderator-ui.html) |
| Build status | [./Implementation Tracker.md](./Implementation%20Tracker.md) |
