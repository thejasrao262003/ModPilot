# 07 — Data Layer

> **Purpose:** Authoritative spec for every store ModPilot uses — Postgres schema, Redis keyspace, Devvit KV, retention, migrations, access patterns. Load this when touching any persistent or cached state.
>
> **Status:** Living. Evolves with every migration.

---

## 1. Store Map

| Store | Hosted on | Holds | Authority |
|---|---|---|---|
| **Postgres** | Supabase / Neon | Moderation memory, feedback, audit log, analytics, sub config | Source of truth |
| **Redis** (Engine) | Upstash | Hot caches, counters, ephemeral state | Derived; safe to evict |
| **Devvit KV** | Reddit platform | Per-sub queue state, verdicts for UI, wizard progress | Edge-only; subreddit-scoped |

**Rules:**
- Postgres owns truth. Anything that must survive eviction lives here.
- Redis is cache-aside; every read tolerates a miss.
- Devvit KV is for edge-side UI state only — never the source of truth for anything cross-subreddit.

---

## 2. Postgres Schema

All tables share two implicit conventions:
- `subreddit_id text NOT NULL` on every row (cross-sub isolation invariant).
- `created_at timestamptz NOT NULL DEFAULT now()` on every row.

### 2.1 `subreddit_config`

Per-subreddit operational state and learned weights.

```sql
CREATE TABLE subreddit_config (
  subreddit_id        text PRIMARY KEY,
  installed_at        timestamptz NOT NULL,
  config_version      int NOT NULL DEFAULT 1,
  active_personality  text NOT NULL DEFAULT 'balanced',  -- strict|balanced|lenient|custom
  region              text NOT NULL DEFAULT 'GLOBAL',
  custom_rules        text,
  enabled             boolean NOT NULL DEFAULT true,
  risk_weights        jsonb NOT NULL,                    -- tunable Strategy Selector weights
  baseline_risk       real NOT NULL DEFAULT 0.3,
  historical_accuracy real,                              -- nightly-derived
  feedback_events     int NOT NULL DEFAULT 0,
  cold_start          boolean NOT NULL DEFAULT true,
  pending_deletion    timestamptz,                       -- set on AppRemove + 30d
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 `user_memory`

Per-user-per-subreddit longitudinal state.

```sql
CREATE TABLE user_memory (
  user_id              text NOT NULL,
  subreddit_id         text NOT NULL,
  first_seen           timestamptz NOT NULL,
  last_seen            timestamptz NOT NULL,
  prior_violations     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {category: count}
  borderline_incidents int  NOT NULL DEFAULT 0,
  overrides_in_favor   int  NOT NULL DEFAULT 0,
  overrides_against    int  NOT NULL DEFAULT 0,
  escalation_flags     int  NOT NULL DEFAULT 0,
  trust_score          real NOT NULL DEFAULT 0.5,
  risk_tier            text NOT NULL DEFAULT 'new',         -- new|trusted|neutral|watched
  last_recomputed_at   timestamptz,
  PRIMARY KEY (subreddit_id, user_id)
);
CREATE INDEX user_memory_risk_idx ON user_memory (subreddit_id, risk_tier);
```

### 2.3 `thread_memory`

Per-post conversational state.

```sql
CREATE TABLE thread_memory (
  post_id              text NOT NULL,
  subreddit_id         text NOT NULL,
  last_activity_at     timestamptz NOT NULL,
  comment_count        int  NOT NULL,
  escalation_trajectory jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{turn, ts, temp, drivers}]
  peak_temperature     real NOT NULL DEFAULT 0,
  current_temperature  real NOT NULL DEFAULT 0,
  instigator_candidates text[] NOT NULL DEFAULT '{}',
  mod_actions_taken    jsonb NOT NULL DEFAULT '[]'::jsonb,
  off_topic_flag       boolean NOT NULL DEFAULT false,
  last_summary         text,
  last_summary_bucket  int,
  last_summary_at      timestamptz,
  PRIMARY KEY (subreddit_id, post_id)
);
CREATE INDEX thread_memory_activity_idx ON thread_memory (subreddit_id, last_activity_at);
```

### 2.4 `investigations`

One row per investigation. The audit backbone.

```sql
CREATE TABLE investigations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subreddit_id        text NOT NULL,
  target_id           text NOT NULL,        -- comment_id or post_id
  target_type         text NOT NULL,        -- 'comment' | 'post'
  author_id           text NOT NULL,
  correlation_id      uuid NOT NULL,
  tier                text NOT NULL,        -- FAST|STANDARD|DEEP
  tools_used          text[] NOT NULL,
  is_partial          boolean NOT NULL DEFAULT false,
  validation_passed   boolean NOT NULL,
  validation_retries  int  NOT NULL DEFAULT 0,
  latency_ms          int  NOT NULL,
  cost_usd            numeric(10,6) NOT NULL,
  reasoner_input_tok  int,
  reasoner_output_tok int,
  prompt_version      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigations_target_idx ON investigations (subreddit_id, target_id, created_at DESC);
CREATE INDEX investigations_author_idx ON investigations (subreddit_id, author_id, created_at DESC);
```

### 2.5 `verdicts`

One row per investigation; the recommendation and evidence trail.

```sql
CREATE TABLE verdicts (
  investigation_id   uuid PRIMARY KEY REFERENCES investigations(id) ON DELETE CASCADE,
  subreddit_id       text NOT NULL,
  recommendation     text NOT NULL,        -- REMOVE|APPROVE|ESCALATE|LOCK|NO_ACTION
  confidence         real NOT NULL,        -- calibrated, 0.0-1.0
  confidence_tier    text NOT NULL,        -- HIGH|MEDIUM|LOW
  risk_tier          text NOT NULL,        -- HIGH|MEDIUM|LOW
  rationale          text NOT NULL,        -- rehydrated (real IDs, not tokens)
  cited_evidence_ids text[] NOT NULL,
  fallback           boolean NOT NULL DEFAULT false,
  flags              text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verdicts_recommendation_idx ON verdicts (subreddit_id, recommendation, created_at DESC);
```

### 2.6 `evidence_rows`

Structured evidence per investigation. Backs both Reasoner prompts and the Timeline UI.

```sql
CREATE TABLE evidence_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id  uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  subreddit_id      text NOT NULL,
  ev_id             text NOT NULL,         -- 'ev-1', 'ev-2', ... unique within investigation
  tool_name         text NOT NULL,
  type              text NOT NULL,
  summary           text NOT NULL,
  detail            jsonb NOT NULL,
  weight            real NOT NULL,
  sequence          int  NOT NULL,
  UNIQUE (investigation_id, ev_id)
);
```

### 2.7 `timeline_entries`

Per-step trail for the Investigation Timeline UI.

```sql
CREATE TABLE timeline_entries (
  investigation_id uuid NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  sequence         int  NOT NULL,
  tool_name        text NOT NULL,
  started_at       timestamptz NOT NULL,
  duration_ms      int  NOT NULL,
  status           text NOT NULL,         -- success|failure|skipped|timeout
  summary          text NOT NULL,
  evidence_ids     text[] NOT NULL DEFAULT '{}',
  error_summary    text,
  PRIMARY KEY (investigation_id, sequence)
);
```

### 2.8 `feedback`

Durable on receipt. The adaptation signal.

```sql
CREATE TABLE feedback (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES investigations(id),
  subreddit_id     text NOT NULL,
  mod_id           text NOT NULL,
  mod_action       text NOT NULL,         -- the actual mod action taken
  recommendation   text NOT NULL,         -- ModPilot's recommendation
  alignment        text NOT NULL,         -- ACCEPTED|REJECTED|OVERRIDDEN|CONFIRMED_NO_ACTION
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_sub_time_idx ON feedback (subreddit_id, created_at DESC);
```

### 2.9 `audit_log`

Immutable record of every recommendation and mod action.

```sql
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subreddit_id   text NOT NULL,
  event_type     text NOT NULL,    -- investigation|recommendation|mod_action|memory_wipe|config_change
  target_id      text,
  actor_id       text,             -- mod_id for mod actions, NULL for system
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_sub_time_idx ON audit_log (subreddit_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (subreddit_id, target_id);
```

### 2.10 `policy_rules`

Embedded subreddit rules for `policy_match`.

```sql
CREATE TABLE policy_rules (
  subreddit_id  text NOT NULL,
  rule_id       text NOT NULL,
  rule_text     text NOT NULL,
  embedding     vector(1536) NOT NULL,    -- pgvector
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subreddit_id, rule_id)
);
CREATE INDEX policy_rules_embed_idx ON policy_rules
  USING hnsw (embedding vector_cosine_ops);
```

### 2.11 `analytics_daily`

Pre-aggregated tiles for the dashboard.

```sql
CREATE TABLE analytics_daily (
  subreddit_id      text NOT NULL,
  date              date NOT NULL,
  investigations    int  NOT NULL DEFAULT 0,
  by_tier           jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd          numeric(10,4) NOT NULL DEFAULT 0,
  median_latency_ms int,
  acceptance_rate   real,
  override_rate     real,
  PRIMARY KEY (subreddit_id, date)
);
```

### 2.12 Constraints That Cross Tables

- Every `verdicts.subreddit_id` matches its parent `investigations.subreddit_id` (enforced by trigger).
- `feedback.investigation_id` must reference a non-pending-deletion investigation.
- Cascading deletes only on `investigations → verdicts/evidence/timeline`. Feedback and audit log persist independently.

---

## 3. Redis Keyspace

Cache-aside. Every key has a TTL. Every key includes `subreddit_id` when sub-scoped.

| Key pattern | TTL | Type | Purpose |
|---|---|---|---|
| `user_profile:<user_id>:<sub_id>` | 1h | JSON | Cached UserMemory |
| `thread_summary:<post_id>:<bucket>` | 24h | JSON | Cached Haiku summary |
| `thread_traj:<post_id>` | 6h | JSON | Hot escalation trajectory (last 50 points) |
| `policy_embed:<sub_id>:<rule_id>` | indefinite | vector | Mirror of `policy_rules.embedding` |
| `verdict:<target_id>` | 10min | JSON | Re-report short-circuit |
| `subreddit_config:<sub_id>` | 60s | JSON | Hot sub config |
| `reports:<target_id>` | 15min | sorted set | Sliding-window report timestamps |
| `pattern:<sub_id>:<window>` | 15min | JSON | Brigade pattern cache (stub) |
| `rate:hour:<sub_id>` | 1h | counter | Hourly cost cap counter |
| `rate:day:<sub_id>` | 24h | counter | Daily cost cap counter |
| `lock:<key>` | 5s | string | Single-flight stampede lock |
| `counter:fb_events:<sub_id>` | 5min flush | counter | Pending Postgres flush |

**Conventions:**
- Colon-separated semantic segments. Type first, sub_id when relevant, specific ID last.
- No `KEYS` in production. Use `SCAN` with cursors.
- All access goes through `engine/store/redis.py`. Never call `redis.client` directly from tools.

---

## 4. Devvit KV

Subreddit-scoped, ephemeral, edge-only. Devvit's managed Redis under `context.redis`.

| Key | TTL | Purpose |
|---|---|---|
| `pending_investigation:<target_id>` | 24h | State machine: queued / complete / failed |
| `verdict:<target_id>` | 24h | Full verdict for UI rendering (rehydrated copy) |
| `priority:<target_id>` | 24h | Just the priority score (queue ordering hot read) |
| `subreddit_config:<sub_id>` | 60s | Cached settings reads |
| `dashboard_summary:<sub_id>` | 5min | Aggregated tiles |
| `wizard_state:<sub_id>` | 30d | First-run progress |

**Rules:**
- All access via `devvit-app/src/services/stateStore.ts`. Never `context.redis` directly.
- Every write specifies TTL. Unbounded keys are bugs.
- Each value ≤10KB. Larger payloads belong in Engine + Postgres.
- No cross-subreddit data. Devvit KV is sub-scoped by platform design.

---

## 5. Caching Strategy

| Layer | When read | When invalidated |
|---|---|---|
| User profile | `user_history` tool, Strategy Selector | `onModAction` updates the cache; 1h TTL otherwise |
| Thread summary | `thread_context` tool | Bucket changes (every 10 new comments); 24h TTL |
| Policy embeddings | `policy_match` tool | Settings save on `custom_rules` field |
| Verdict | Re-report short-circuit | TTL only (10min) |
| Subreddit config | Every Engine call | Settings save; 60s TTL |

**Stampede protection:** Redis `SET NX` lock pattern for expensive caches (thread summary, policy embeddings). Implemented in `engine/store/redis.py::get_or_compute`.

**Cache miss is not an error.** Compute and populate. Only `thread_summary` and `policy_embed` misses carry meaningful cost.

---

## 6. Data Retention

| Data | Hot | Warm | Cold | Hard delete |
|---|---|---|---|---|
| User Memory (active) | indefinite | 90d post last_seen | aggregated at 1y | 2y |
| User Memory (banned) | indefinite | indefinite | indefinite | uninstall + 30d |
| Thread Memory | 7d | 7-30d | 30-180d (trajectory dropped) | 180d |
| Subreddit Memory | indefinite | — | — | uninstall + 30d |
| Investigations + verdicts + evidence + timeline | 90d | 90d-1y (detail dropped) | summary kept 2y | 2y |
| Feedback | indefinite | — | — | uninstall + 30d |
| Audit log | 2y minimum | — | — | retention policy in `10-ReliabilityAndSafety.md` |
| Policy rules | indefinite | — | — | uninstall + 30d |

**Uninstall path:** `AppRemove` sets `subreddit_config.pending_deletion = now() + 30d`. Nightly job purges where `pending_deletion < now()`. The grace window lets accidental uninstalls recover.

**Mod-initiated forgetting:** A mod tool sets a specific `user_memory` row to deleted and writes an `audit_log` entry. Used when a user is given a fresh start.

---

## 7. PII Rules (Data-Layer Enforcement)

- **No real-name PII.** We store Reddit user IDs only. Never email, phone, real name.
- **User IDs are anonymized at the LLM boundary.** The Engine's anonymizer (`engine/llm/anon.py`) converts IDs to tokens before any prompt. The audit log and UI re-hydrate.
- **Raw content is not retained.** We store derived signals (escalation temp, summary, evidence rows), never the original comment/post body.
- **Logs redact user IDs** for any record older than 30 days outside the audit log.

Full PII spec lives in `10-ReliabilityAndSafety.md`.

---

## 8. Migrations

- Tool: Alembic.
- Location: `engine/store/migrations/`.
- Naming: `NNNN_short_description.py` (4-digit sequence).
- Every migration is reversible (`upgrade` + `downgrade`).
- Schema changes require updating this doc in the same PR.
- Destructive migrations (drop column, drop table) require an ADR.

Migration checklist for any schema change:
1. Write the Alembic migration.
2. Update the table definition in this doc.
3. Update affected Pydantic / SQLAlchemy models in `engine/store/schemas.py`.
4. Add a backfill script if the change requires data transformation.
5. Test rollback locally before merging.

---

## 9. Indexing Principles

- Every query in `engine/store/` uses an indexed path. Lint rule rejects unindexed scans.
- `subreddit_id` is the leading column on every multi-column index (matches our access pattern).
- Time-series indexes are descending on `created_at` (most reads are "recent first").
- `pgvector` HNSW index on `policy_rules.embedding` for cosine similarity.
- No GIN/GIST indexes in MVP; revisit when full-text search is needed.

---

## 10. Connection & Concurrency

- **Postgres pool:** asyncpg, pool size 10 per Engine instance. Read replicas not used in MVP.
- **Redis pool:** redis-py async, pool size 20.
- **Devvit KV:** access via `context.redis`; concurrency managed by platform.
- **Transactions:** every multi-statement write uses an explicit transaction. Read-modify-write goes through `MULTI/EXEC` (Redis) or `SELECT FOR UPDATE` (Postgres).
- **Idempotency keys** on `feedback` and `investigations` use `(subreddit_id, target_id, created_at)` natural keys + dedup logic in the API layer.

---

## 11. Consistency Guarantees

| Data | Guarantee | Acceptable staleness |
|---|---|---|
| Feedback events | Durable on receipt | 0 |
| Verdicts | Durable on Engine response | 0 |
| Audit log | Durable on event | 0 |
| User Memory counters | Eventually consistent | 5 min (Redis → Postgres flush) |
| Subreddit Memory derived fields | Nightly batch | 24 h |
| Caches | Best-effort | Up to TTL |
| Devvit KV verdict mirror | Best-effort | Seconds (Devvit write after Engine response) |

**Rule of thumb:** writes that affect mod decisions are immediate; writes that affect analytics are batched.

---

## 12. Backup & Recovery

- **Postgres:** managed daily snapshots by Supabase/Neon; point-in-time recovery within 7 days on free tier (longer on paid).
- **Redis:** ephemeral by design. No backup. Repopulates from Postgres + live traffic.
- **Devvit KV:** managed by Reddit; we don't back up directly. State is reconstructible from Engine.
- **Audit log export:** any subreddit can request a JSON export of their `audit_log` via a mod menu action (post-MVP feature).

If we lose Redis entirely: degraded mode (every read recomputes) until caches re-warm. No data loss.
If we lose Postgres: critical incident. Restore from snapshot; investigations during the gap reconstruct on retry.

---

## 13. Invariants

1. Every row in every sub-scoped table has `subreddit_id NOT NULL`.
2. Every store access goes through `engine/store/` or `devvit-app/src/services/stateStore.ts`.
3. Every cache key includes `subreddit_id` when storing sub-scoped data.
4. Every Redis key has a TTL.
5. Feedback events and audit log entries are durable on write (no batching).
6. No LLM provider request payload contains a raw user ID.
7. Schema changes ship with a migration and a doc update in the same PR.
8. No cross-subreddit JOIN is ever written. Sub isolation is structural.

---

## 14. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — Where stores sit in the system.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — Engine flow that produces these rows.
- [`05-Memory.md`](05-Memory.md) — Conceptual model for user/thread/sub memory.
- [`06-AILayer.md`](06-AILayer.md) — Caches the AI layer relies on.
- [`08-API.md`](08-API.md) — Endpoints that read/write these tables.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — PII rules, retention enforcement.
- [`13-Infra.md`](13-Infra.md) — Connection strings, secrets, hosting.