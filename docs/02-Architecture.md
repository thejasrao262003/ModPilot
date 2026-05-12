# 02 — Architecture

> **Purpose:** The single source-of-truth architectural map for ModPilot. When in doubt about how components interact, what runs where, or what shape the data takes — this is the doc that settles it.
>
> **Status:** Canon. Mostly static. Changes here require an ADR in `docs/adr/`.

---

## 1. Architectural Philosophy

Three commitments shape every decision below:

1. **Thin edge, thick core.** The Devvit app is intentionally thin — it captures events, enriches cheaply, calls the Engine, and renders results. All non-trivial reasoning, state, and orchestration live in the Investigation Engine. This keeps Devvit's runtime constraints from leaking into our architecture.
2. **Investigation is the unit of work.** Not a request, not a classification, not a "moderation decision." A single investigation is the atomic operation that flows through the system end-to-end. Every component is defined by its role in producing or consuming investigations.
3. **Production-readiness over sophistication.** Graceful degradation, idempotency, cost budgets, and observability are first-class concerns from Day 1. A clever feature that can't fail safely is a worse feature than a simple one that can.

---

## 2. Cognition Model

Before describing how services are arranged, describe what the system *thinks*. This diagram is the conceptual backbone of ModPilot. Everything else exists to serve it.

```
                    ┌─────────────────────────────┐
                    │     Report Arrives          │
                    │  (signal: content + context)│
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Risk Estimation           │
                    │  cheap heuristics, ~50ms    │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Investigation Strategy     │
                    │      Selection              │◄──── Subreddit Personality
                    │  (Fast / Standard / Deep)   │      Cold-Start Safety Rules
                    │                             │      Feedback weights
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Evidence Gathering        │
                    │  (Tool Registry execution)  │◄──── Moderation Memory
                    │  early-stop on convergence  │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Evidence Convergence      │
                    │  agreement / contradiction  │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Confidence Calibration    │
                    │  calibrated, multi-signal   │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Action Recommendation     │
                    │  with full evidence trail   │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Moderator Decision        │
                    │   (human-in-the-loop)       │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │   Feedback Ingestion        │──► Strategy weights update
                    │   accept/reject/override    │    Personality refines
                    │                             │    Memory grows
                    └─────────────────────────────┘
```

**Read this top-to-bottom and you've understood ModPilot.** Every service, schema, and UI component below is in service to one of these steps.

---

## 3. System Architecture

The physical arrangement of services.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          REDDIT PLATFORM                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Triggers         │  │  Mod Queue       │  │ Custom Post UI       │ │
│  │ (Report, Action, │  │  (native)        │  │ (ModPilot Dashboard) │ │
│  │  Install, etc.)  │  │                  │  │                      │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘ │
└───────────┼─────────────────────┼───────────────────────┼──────────────┘
            │                     │                       │
            ▼                     ▼                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    DEVVIT APP (edge functions, TS)                      │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  Trigger Handlers → Cheap Enrichment → Priority Score → Enqueue  │ │
│  │  Menu Actions  →  Engine RPC  →  Devvit KV write  →  UI render   │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  Devvit Redis: hot queue, recent verdicts, mod preferences       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS (HMAC-signed)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│              INVESTIGATION ENGINE (Python / FastAPI, Fly.io)            │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  API Layer  (POST /investigate, /feedback, /health)              │ │
│  └────────────────────────────┬─────────────────────────────────────┘ │
│                               ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │           Strategy Selector  (Fast / Standard / Deep)            │ │
│  │   inputs: risk, sub profile, cold-start state, feedback weights  │ │
│  └────────────────────────────┬─────────────────────────────────────┘ │
│                               ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    Investigation Orchestrator                    │ │
│  │  • tool sequencer with budget enforcement                        │ │
│  │  • evidence accumulator                                          │ │
│  │  • convergence detector / early-stop                             │ │
│  │  • timeline recorder (drives the UI feature)                     │ │
│  └────┬───────────────────────┬───────────────────────┬─────────────┘ │
│       │                       │                       │                │
│       ▼                       ▼                       ▼                │
│  ┌──────────┐         ┌──────────────┐        ┌──────────────────┐    │
│  │   Tool   │         │   Reasoner   │        │   Confidence     │    │
│  │ Registry │         │   (Sonnet,   │        │   Calibrator     │    │
│  │ (typed)  │         │ evidence-    │        │   (multi-signal) │    │
│  │          │         │  cited)      │        │                  │    │
│  └──────────┘         └──────────────┘        └──────────────────┘    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  Moderation Memory Layer  (user / thread / subreddit)            │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  Feedback Ingestor → Strategy weights → Subreddit Personality    │ │
│  │  (nightly batch update; not online RL)                           │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  Evaluation Harness (OpenENV-derived scenarios, offline)         │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│         ┌────────────────┐                ┌────────────────┐           │
│         │   Postgres     │                │   Redis cache  │           │
│         │  (memory,      │                │  (profiles,    │           │
│         │   feedback,    │                │   summaries,   │           │
│         │   audit log,   │                │   embeddings,  │           │
│         │   analytics)   │                │   verdicts)    │           │
│         └────────────────┘                └────────────────┘           │
└────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │
                                    ▼
                          ┌──────────────────┐
                          │   LLM Providers  │
                          │  Gemini 2.5 Pro, │
                          │  Gemini 2.5 Flash│
                          └──────────────────┘
```

---

## 4. Service Topology

Three services + two stores. Nothing more.

### 4.1 Devvit App (`devvit-app/`)

- **Runtime:** Reddit's Devvit serverless platform
- **Language:** TypeScript
- **Responsibilities:**
  - Receive triggers (report, mod action, install, upgrade)
  - Run cheap enrichment (reporter count, post age, author karma — all free via Reddit API)
  - Compute initial priority score for queue ordering
  - Call the Investigation Engine over signed HTTPS
  - Persist verdicts to Devvit Redis for UI rendering
  - Render Verdict Card + Investigation Timeline in the mod queue
  - Render the custom-post ModPilot Dashboard
  - Capture mod actions as feedback signals and forward to the Engine
- **Explicitly not responsible for:** LLM calls, multi-step reasoning, long-running work, durable analytics state.

### 4.2 Investigation Engine (`engine/`)

- **Runtime:** Fly.io (single region for MVP; multi-region post-hackathon)
- **Language:** Python 3.11 with FastAPI and asyncio
- **Responsibilities:**
  - Expose `POST /investigate`, `POST /feedback`, `GET /health` endpoints
  - Run the Strategy Selector → Orchestrator → Reasoner → Calibrator pipeline
  - Manage the Tool Registry and execute investigation tools
  - Read and write moderation memory
  - Call LLM providers with provider-agnostic abstraction
  - Enforce cost, latency, and tool-call budgets
  - Persist investigations, verdicts, and feedback for audit and analytics
- **Explicitly not responsible for:** Direct Reddit API calls for moderation actions (Devvit handles those), session-level state (stateless between requests; all state in stores).

### 4.3 Background Workers (`engine/jobs/`)

- **Runtime:** Same Fly.io app as the Engine, separate process
- **Language:** Python
- **Responsibilities:**
  - Nightly batch update of subreddit personality feedback weights
  - Hourly analytics rollup
  - Periodic eviction of stale cache entries
  - Retry of failed investigations
- **Explicitly not responsible for:** Real-time work, anything user-facing.

### 4.4 Postgres

- **Provider:** Supabase or Neon (free tier)
- **Holds:** Moderation memory, feedback log, audit log, analytics rollups, subreddit personality configuration
- **Access pattern:** Strongly consistent reads from the Engine; batch writes from workers; never accessed directly by Devvit

### 4.5 Redis

- **Provider:** Upstash (free tier)
- **Holds:** User profile cache, thread summary cache, policy embedding cache, verdict cache, cross-user pattern cache, rate-limit counters
- **Access pattern:** Read-heavy from the Engine; opportunistic writes; tolerant to eviction

### Communication Matrix

| From | To | Protocol | Sync/Async | Notes |
|---|---|---|---|---|
| Reddit | Devvit | Trigger invocation | Sync | Devvit platform-managed |
| Devvit | Engine | HTTPS POST, HMAC-signed | Sync (with timeout) | Falls back gracefully if Engine unreachable |
| Engine | LLM provider | HTTPS API call | Sync | With retry and fallback chain |
| Engine | Postgres | TCP, pooled | Sync | Strongly consistent |
| Engine | Redis | TCP, pooled | Sync | Cache-aside pattern |
| Engine | Devvit KV (verdict push) | Via Devvit response payload | Sync | Engine returns verdict; Devvit stores |
| Workers | Postgres | TCP | Async (batch) | Nightly + hourly |

**No message queue in MVP.** All work is either synchronous request/response or scheduled batch. If we need durable async work post-MVP, add a queue then.

---

## 5. End-to-End Data Flow

The canonical flow for a single report. Memorize this — every feature touches some subset of it.

### 5.1 Report Arrives

```
1. User clicks "Report" on a comment in r/example
2. Reddit fires CommentReport trigger → Devvit app
3. Devvit handler runs (target: under 500ms total):
   a. Extract: comment_id, author_id, reporter_id, reason, subreddit_id
   b. Fetch cheap enrichment via Reddit API:
      - Reporter's karma and account age
      - Author's karma and account age
      - Post age, comment depth, score
   c. Compute initial priority score (heuristic, no LLM):
      priority = w1*report_count + w2*velocity + w3*author_risk_signal + w4*recency
   d. Write `pending_investigation:<comment_id>` to Devvit Redis
   e. Fire async call to Engine: POST /investigate with the enrichment payload
4. Devvit handler returns; trigger completes
```

### 5.2 Engine Investigates

```
5. Engine receives POST /investigate (HMAC-validated)
6. Strategy Selector evaluates:
   - Risk inputs (report count, velocity, content signals, author signal, sub baseline)
   - Subreddit personality (Strict/Balanced/Lenient/custom)
   - Cold-start state (feedback_events < 50 → conservative)
   - Returns: tier ∈ {Fast, Standard, Deep} + tool plan
7. Orchestrator runs the investigation loop:
   for each tool in plan:
     if budget exceeded → break with partial verdict
     if evidence converged → early-stop
     run tool → append to Evidence Accumulator → record in Timeline
8. Reasoner (Sonnet) generates verdict from accumulated evidence:
   - Prompt enforces evidence-citation contract
   - Output validated post-generation against evidence IDs
   - Validation failure → demote confidence, retry once
9. Confidence Calibrator combines:
   - LLM self-reported confidence (heavily discounted)
   - Evidence convergence score
   - Historical subreddit accuracy
   - Rule-match strength
   - Returns calibrated confidence → tier (High/Medium/Low)
10. Engine persists to Postgres:
    - Investigation record (tier, tools used, latency, cost)
    - Verdict (recommendation, confidence, evidence IDs)
    - Timeline (for audit log)
11. Engine returns response to Devvit
```

### 5.3 Devvit Renders

```
12. Devvit receives Engine response
13. Devvit writes `verdict:<comment_id>` to Devvit Redis
14. When the mod opens the queue, the custom-post UI:
    - Reads pending verdicts from Devvit Redis
    - Renders Verdict Card (risk tier, suggested action, top-3 evidence, confidence)
    - Investigation Timeline available on expand
```

### 5.4 Mod Decides

```
15. Mod clicks Remove (or Approve / Escalate / Lock)
16. Devvit handler:
    a. Executes the actual Reddit moderation action via Reddit API
    b. Records the mod's decision locally
    c. Fires ModAction trigger
17. ModAction trigger handler:
    a. Compares mod decision to ModPilot's recommendation
    b. Fires async POST /feedback to Engine
18. Engine /feedback handler:
    a. Persists feedback row in Postgres
    b. Updates Moderation Memory (user/thread/subreddit)
    c. Returns ack
19. Nightly worker:
    a. Aggregates feedback into subreddit personality weight updates
    b. Refreshes cold-start state if threshold crossed
```

That's the entire loop. Every feature is either an extension of one of these steps or an optimization (cache, batch, retry) of one of these steps.

---

## 6. Tech Stack (Locked)

Each choice has been made deliberately. Replacing any of these requires an ADR.

### Devvit App
- **TypeScript** — Devvit's first-class language; type safety matters at the trigger boundary
- **Devvit SDK** — required platform abstraction
- **Devvit Blocks** — UI primitives; no external React tree

### Investigation Engine
- **Python 3.11** — best LLM ecosystem support; team familiarity; async story is mature
- **FastAPI** — async-native, automatic OpenAPI, minimal boilerplate
- **asyncio** — concurrency model for parallel tool execution and LLM calls
- **Pydantic v2** — schema enforcement at every API and tool boundary

### Data
- **Postgres** (Supabase or Neon) — strongly consistent, free tier sufficient, familiar
- **Redis** (Upstash) — cache layer, simple key-value, free tier sufficient
- **No queue, no search engine, no vector DB** — embeddings stored as Postgres `vector` columns (pgvector) for the policy-match tool

### LLM Layer
- **Gemini 2.5 Pro** — Reasoner role. Final verdict generation. Quality matters here.
- **Gemini 2.5 Flash** — Planner and summarizer roles. Latency and cost matter here.
- **Provider-agnostic abstraction** — `LLMClient` interface; swappable to OpenAI if needed
- **No fine-tuning** — adaptation happens via prompts, evidence injection, and personality config

### Infrastructure
- **Fly.io** — Engine and worker deployment. Easy multi-region path post-MVP.
- **GitHub Actions** — CI for tests, linting, eval harness on PRs
- **Grafana Cloud (free tier)** — metrics and logs aggregation

### Observability
- **Structured JSON logs** with correlation IDs threaded through every investigation
- **Metrics** emitted to Grafana via Prometheus exposition format
- **No APM/tracing in MVP** — added if latency debugging requires it

---

## 7. Repository Layout

The authoritative top-level structure. New files go where this layout says they go.

```
modpilot/
├── CLAUDE.md                          # root system memory
├── README.md                          # public landing
├── LICENSE
├── .github/
│   └── workflows/
│       ├── devvit-ci.yml
│       └── engine-ci.yml
│
├── devvit-app/                        # Devvit application
│   ├── devvit.yaml                    # manifest, permissions, HTTP allowlist
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts                    # entry: registers triggers, menu, jobs
│       ├── triggers/
│       │   ├── onCommentReport.ts
│       │   ├── onPostReport.ts
│       │   ├── onModAction.ts
│       │   ├── onAppInstall.ts
│       │   └── onAppUpgrade.ts
│       ├── menu/
│       │   ├── investigate.ts
│       │   ├── summarizeThread.ts
│       │   └── showMemory.ts
│       ├── jobs/
│       │   ├── reprioritizeQueue.ts
│       │   └── retryFailed.ts
│       ├── ui/
│       │   ├── ModDashboard.tsx       # custom post
│       │   ├── VerdictCard.tsx
│       │   ├── InvestigationTimeline.tsx
│       │   └── FirstRunWizard.tsx
│       ├── services/
│       │   ├── engineClient.ts        # HTTP client to Engine
│       │   ├── redditContext.ts       # wraps Reddit API
│       │   └── stateStore.ts          # Devvit Redis abstraction
│       ├── domain/
│       │   ├── types.ts               # Verdict, Evidence, Investigation
│       │   ├── priority.ts            # cheap heuristic scoring
│       │   └── confidence.ts          # UI threshold mapping
│       └── settings.ts                # Devvit.addSettings schema
│
├── engine/                            # Investigation Engine
│   ├── pyproject.toml
│   ├── api/
│   │   ├── main.py                    # FastAPI app
│   │   ├── routes/
│   │   │   ├── investigate.py
│   │   │   ├── feedback.py
│   │   │   └── health.py
│   │   └── auth.py                    # HMAC verification
│   ├── orchestrator/
│   │   ├── strategy_selector.py
│   │   ├── orchestrator.py            # the investigation loop
│   │   ├── evidence.py                # Evidence Accumulator
│   │   ├── timeline.py                # Timeline Recorder
│   │   ├── convergence.py
│   │   └── budgets.py
│   ├── tools/
│   │   ├── base.py                    # Tool interface, registry
│   │   ├── user_history.py
│   │   ├── thread_context.py
│   │   ├── policy_match.py
│   │   ├── report_velocity.py
│   │   └── prior_actions.py
│   ├── llm/
│   │   ├── client.py                  # provider-agnostic client
│   │   ├── claude.py                  # Claude implementation
│   │   ├── prompts/                   # prompt templates
│   │   │   ├── reasoner.py
│   │   │   ├── planner.py
│   │   │   └── summarizer.py
│   │   └── validation.py              # evidence-citation enforcement
│   ├── memory/
│   │   ├── user.py
│   │   ├── thread.py
│   │   └── subreddit.py
│   ├── personalities/
│   │   ├── presets.py                 # Strict / Balanced / Lenient
│   │   └── cold_start.py
│   ├── store/
│   │   ├── postgres.py
│   │   ├── redis.py
│   │   └── schemas.py                 # Pydantic + SQLAlchemy models
│   ├── jobs/
│   │   ├── feedback_rollup.py         # nightly
│   │   └── analytics_rollup.py        # hourly
│   └── observability/
│       ├── logging.py
│       └── metrics.py
│
├── eval/                              # Evaluation harness
│   ├── scenarios/                     # JSON scenarios derived from use cases
│   ├── harness.py                     # runs scenarios against Engine
│   ├── openenv_adapter.py
│   └── reports/                       # generated eval reports
│
├── docs/                              # this entire doc system
│   ├── README.md
│   ├── 01-Product.md
│   ├── 02-Architecture.md             # ← you are here
│   ├── ... (16 more)
│   ├── Glossary.md
│   └── adr/
│
└── scripts/                           # one-off ops scripts
    ├── seed_demo_subreddit.py
    └── reset_local.sh
```

**Conventions:**

- Anything Devvit-specific lives under `devvit-app/`. The Engine never imports from there.
- Anything Engine-specific lives under `engine/`. Devvit never imports from there.
- Shared data shapes (Verdict, Evidence) are defined twice — once in TS, once in Python — and validated at the API boundary. **Do not** build a shared schema package; the duplication is intentional and worth the cost.
- Tests live alongside code (`*.test.ts`, `test_*.py`), not in a separate `tests/` folder.

---

## 8. Cross-Cutting Concerns

These concerns span every component. Each gets its own doc; this section is the map.

### 8.1 Reliability

- Graceful degradation: if the Engine is unreachable, the mod queue must still work normally. Devvit handlers must never throw on Engine failure.
- Timeouts: 8-second hard cap on `/investigate`; 2-second cap on individual tool calls; 30-second cap on background work.
- Retries: idempotent endpoints retry with exponential backoff; non-idempotent operations require idempotency keys.
- Kill switch: a subreddit setting that pauses all Engine calls; propagates within 60 seconds.

→ See `10-ReliabilityAndSafety.md`.

### 8.2 Safety

- Human-in-the-loop is non-negotiable. No autonomous moderation actions, ever.
- Evidence-citation contract: every verdict claim cites an evidence ID. Enforced in prompts and validated post-generation.
- PII handling: usernames anonymized in LLM prompts; re-hydrated in UI. No real-name PII ever stored.
- Audit log: every recommendation and every mod action is logged immutably.

→ See `10-ReliabilityAndSafety.md`.

### 8.3 Cost & Latency

- Per-tier budgets: Fast (under 1s, <$0.005), Standard (under 5s, <$0.02), Deep (under 10s, <$0.05).
- Caching is mandatory: user profiles (1h), thread summaries (keyed by post + comment count bucket), policy embeddings (forever), verdicts (10min window for re-reports).
- Model tiering: Sonnet only for the Reasoner; Haiku for planning and summarization; no LLM for most tools.

→ See `06-AILayer.md`.

### 8.4 Observability

- Every investigation gets a correlation ID propagated through Devvit → Engine → LLM → store.
- Structured JSON logging at info/warn/error; debug only locally.
- Metric emission on every investigation: tier, latency, cost, confidence, validation pass/fail.
- Mod-facing analytics derived from these metrics (see `12-Analytics.md`).

### 8.5 Configuration

- Subreddit-level config lives in `Devvit.addSettings` and is synced to Postgres on change.
- No runtime feature flags in MVP; gating happens at deploy time. Post-MVP, add LaunchDarkly-style flags.
- Secrets via Fly.io secrets; never committed.

---

## 9. Scalability Considerations

Not a load-tested production system yet, but here's the scaling story when the hackathon ends.

| Bottleneck | MVP capacity | Mitigation when exceeded |
|---|---|---|
| Engine throughput | ~10 investigations/sec on a single Fly machine | Horizontal scale — Engine is stateless |
| LLM latency | Sonnet ~2–4s, Haiku ~500ms | Aggressive caching; parallel tool calls; tier downshift |
| LLM cost | ~$0.01–0.05 per investigation | Subreddit-level rate limits; cold-start tighter; eviction of low-value caches |
| Postgres load | Trivial at MVP scale | Read replicas; partition memory tables by subreddit |
| Redis memory | Caches are bounded by TTL | Move to Upstash paid tier; tighter TTLs |
| Devvit limits | Per-invocation timeout ~30s | Already mitigated by external Engine; never do heavy work in-Devvit |

The architecture scales linearly with subreddit count and report volume. The Engine is stateless, the stores are independently scalable, and Devvit handles its own scaling at the platform level.

---

## 10. Failure Modes & Mitigations

Things that *will* go wrong, and what happens when they do.

| Failure | What the user sees | What we do |
|---|---|---|
| Engine unreachable | Verdict Card hidden; native queue works normally | Devvit handler catches, logs, no-ops; retry next time mod opens queue |
| LLM provider down | Fallback to rules-only verdict; confidence demoted to Low | Engine catches, returns degraded verdict with explanation |
| Postgres unreachable | Investigation runs but isn't persisted; verdict shown ephemerally | Engine logs to disk fallback; reconciles on recovery |
| Redis unreachable | Cache bypassed; latency and cost spike | Engine continues; alerts fire; mods may notice slower investigations |
| Validation fails post-generation | Verdict demoted to Medium confidence at most; UI flags it | Built into Reasoner pipeline |
| Mod-action mismatch with recommendation | Recorded as feedback; recommendation surfaces "this was an override" | Standard feedback flow |
| Cost runaway on a subreddit | Rate-limit kicks in; new investigations queued or dropped | Per-subreddit budget enforcement |
| Bug pushes bad prompt | Eval harness regression catches before deploy | CI gate on eval scenarios |

The principle: **fail closed, not open.** A missing recommendation is acceptable; a wrong-but-confident recommendation is not.

---

## 11. What's Deliberately Not in the Architecture

Things we considered and rejected for MVP. Each has rationale.

- **Message queue (SQS / RabbitMQ / etc.)** — adds operational complexity; investigations are bounded enough to run synchronously; revisit if we need durable async fan-out.
- **Microservices split (Reasoner as separate service, Tool Runner as separate service)** — premature; the Engine is one service until contention proves otherwise.
- **Shared schema package between Devvit and Engine** — coupling cost exceeds duplication cost; validate at the API boundary instead.
- **A vector database (Pinecone, Weaviate)** — pgvector in Postgres is sufficient for policy embeddings at our scale.
- **Real-time event streaming (Kafka, Kinesis)** — unnecessary; Reddit's trigger system is the event stream.
- **Multi-region active-active** — overkill for MVP; single-region with documented failover is fine.
- **Service mesh** — three services don't need one.

Each rejection is recorded as an implicit "no, because [reason]." If circumstances change, add an ADR.

---

## 12. Architecture Invariants

These properties must always hold. They're the contract.

1. The Devvit app never makes LLM calls directly.
2. The Engine never makes Reddit moderation API calls; it returns recommendations, Devvit executes.
3. Every verdict has a corresponding evidence trail; no verdict without evidence.
4. Every cross-service call has a timeout.
5. Every persisted record has a `subreddit_id` foreign key; cross-subreddit data leakage is structurally impossible.
6. The Engine is stateless between requests; all state lives in Postgres or Redis.
7. The mod queue continues working when the Engine is down.
8. No new component is added without an ADR.

Violating any of these is an architectural bug, not a feature.

---

## 13. Open Architectural Questions

Decisions deferred until evidence arrives. These are explicit unknowns.

- **Should the Reasoner run on Sonnet or Sonnet + Haiku ensemble?** Defer until we have eval data showing Haiku alone is or isn't sufficient for borderline cases.
- **Should we add a dedicated cache-warming job, or rely on lazy population?** Defer until cache hit rates indicate a problem.
- **Should subreddit personality data be stored in Postgres or Devvit's own KV?** Currently Postgres for query flexibility; revisit if Devvit KV proves sufficient and cheaper.
- **How do we handle multi-language subreddits?** Out of scope for MVP; tracked as roadmap.

These are tracked in the root `CLAUDE.md` under "Open Questions."

---

## 14. Related Documents

- [`01-Product.md`](01-Product.md) — Why ModPilot exists. Drives every architectural choice.
- [`03-Devvit.md`](03-Devvit.md) — How the Devvit app is structured and what triggers handle what.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — Deep specification of the Engine's internals.
- [`05-Memory.md`](05-Memory.md) — Moderation memory, personalities, cold-start safety.
- [`06-AILayer.md`](06-AILayer.md) — LLM abstraction, prompts, citation contract.
- [`07-DataLayer.md`](07-DataLayer.md) — Postgres schema, Redis keyspace.
- [`08-API.md`](08-API.md) — Engine API surface.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Graceful degradation, HITL, PII.
- [`13-Infra.md`](13-Infra.md) — Deployment, secrets, observability.
- [`adr/`](adr/) — Architecture Decision Records.