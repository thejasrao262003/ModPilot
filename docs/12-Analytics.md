# 12 — Analytics

> **Purpose:** Specify the metrics ModPilot emits, the events that drive them, the mod-facing dashboard, and how the "time saved" claim is calculated. Load when touching metrics, the dashboard, or analytics-adjacent code.
>
> **Status:** Living. Metric catalog grows over time.

---

## 1. Why Analytics Exists

Two audiences, two purposes:

1. **Moderators** — see ModPilot's impact in their subreddit. Time saved, acceptance rate, cost. Builds trust through visible value.
2. **Engineers** — observe system health, validate behavior, debug. Latency, errors, validation rates, cache hit rates.

Both consume the same event stream. The dashboard slices it for mods; Grafana slices it for engineers.

---

## 2. Event Pipeline

```
Engine emits structured events
    ↓
Postgres analytics_daily (hourly rollup job)
    ↓
Mod dashboard reads pre-aggregated tiles
    ↓
Grafana scrapes Prometheus-exposed metrics in parallel
```

Two destinations from one event stream. No double-write.

---

## 3. Event Schema

All events are structured JSON with a common envelope.

```json
{
  "event_type": "investigation.completed",
  "correlation_id": "uuid",
  "subreddit_id": "sub_abc",
  "timestamp": "2026-05-12T14:22:13Z",
  "payload": { ... }
}
```

### 3.1 Core Event Types

| Event | Emitted by | When |
|---|---|---|
| `investigation.started` | Engine `/investigate` | Request received, plan selected |
| `investigation.tool_completed` | Orchestrator | Each tool finishes |
| `investigation.validation_failed` | Reasoner | Citation validation fails |
| `investigation.completed` | Engine `/investigate` | Verdict returned |
| `feedback.recorded` | Engine `/feedback` | Mod action ingested |
| `verdict.rendered` | Devvit | Mod opens the Verdict Card |
| `timeline.expanded` | Devvit | Mod clicks "View reasoning" |
| `action.executed` | Devvit | Mod clicks Remove/Approve/Escalate/Lock |
| `kill_switch.toggled` | Devvit | Mod flips the `enabled` setting |
| `cold_start.exited` | Engine batch | Sub crosses 50 feedback events |

### 3.2 Per-Event Payload (Key Examples)

**`investigation.completed`:**
```json
{
  "investigation_id": "uuid",
  "tier": "STANDARD",
  "tools_used": ["policy_match", "report_velocity", "user_history", "thread_context"],
  "recommendation": "REMOVE",
  "confidence": 0.84,
  "confidence_tier": "MEDIUM",
  "is_partial": false,
  "fallback": false,
  "validation_passed": true,
  "latency_ms": 1432,
  "cost_usd": 0.0184,
  "prompt_version": "reasoner-v1.0",
  "cold_start": false
}
```

**`feedback.recorded`:**
```json
{
  "investigation_id": "uuid",
  "mod_action": "REMOVE",
  "recommendation": "REMOVE",
  "alignment": "ACCEPTED",
  "decision_latency_ms": 4200,
  "timeline_expanded": true
}
```

`decision_latency_ms` is wall-clock from `verdict.rendered` to `action.executed`. This is the input to the "time saved" calculation.

---

## 4. Metrics Catalog

Aggregated metrics emitted to Prometheus by the Engine, plus Devvit-side metrics exported via the analytics rollup endpoint.

### 4.1 Operational Metrics (Engineer-Facing)

| Metric | Type | Labels | Use |
|---|---|---|---|
| `engine.requests.total` | counter | `route, status` | API health |
| `engine.latency_ms` | histogram | `route, tier` | SLO tracking |
| `engine.investigation.cost_usd` | counter | `subreddit_id, tier` | Cost tracking |
| `engine.investigation.tier_count` | counter | `subreddit_id, tier` | Tier distribution |
| `engine.validation.pass_rate` | gauge | `prompt_version` | Hallucination rate |
| `engine.validation.failed_count` | counter | `reason` | Failure breakdown |
| `engine.fallback.rate` | gauge | — | LLM provider health |
| `engine.cache.hit_rate` | gauge | `cache_name` | Cache effectiveness |
| `engine.llm.tokens` | counter | `role, direction` | Token usage |
| `engine.llm.latency_ms` | histogram | `role, model` | LLM performance |
| `devvit.circuit.state` | gauge | `subreddit_id` | Circuit breaker |
| `devvit.trigger.duration_ms` | histogram | `trigger_type` | Edge latency |

### 4.2 Product Metrics (Mod-Facing)

Computed from events, surfaced on the dashboard.

| Metric | Definition | Refresh |
|---|---|---|
| `investigations_today` | Count of `investigation.completed` for sub in last 24h | Real-time |
| `time_saved_today` | Sum of (baseline − decision_latency_ms) across actions | Hourly |
| `acceptance_rate_today` | `ACCEPTED / (ACCEPTED + REJECTED + OVERRIDDEN)` over 24h | Hourly |
| `cost_today` | Sum of `investigation.cost_usd` for sub in last 24h | Real-time |
| `tier_distribution_today` | Histogram by tier | Hourly |
| `historical_accuracy_30d` | Acceptance rate over rolling 30 days | Nightly |
| `avg_response_time_30d` | Median `decision_latency_ms` | Nightly |
| `most_enforced_rules_30d` | Top 3 `rule_id` by action count | Nightly |
| `cold_start_progress` | `feedback_events / 50` | Real-time |
| `inter_mod_consistency_30d` | Per `05-Memory.md` Section 5.3 | Nightly |

### 4.3 Hidden / Internal Only

These are computed but **never exposed in UI**:
- Per-user `trust_score` float (only tier label shown)
- Per-mod decision distributions (privacy)
- Cross-subreddit aggregates (sub isolation invariant)

---

## 5. Postgres `analytics_daily` Schema

Schema lives in `07-DataLayer.md` Section 2.11. Recap:

```sql
analytics_daily (
  subreddit_id, date,
  investigations,
  by_tier jsonb,         -- {"FAST": 8, "STANDARD": 31, "DEEP": 8}
  cost_usd,
  median_latency_ms,
  acceptance_rate,
  override_rate
)
```

Rolled up by `engine/jobs/analytics_rollup.py`, runs hourly. Each run updates the current day's row and finalizes the previous day's row if midnight crossed.

---

## 6. Time-Saved Calculation

The single most important number in the dashboard. Get it right and defensible.

### 6.1 The Baseline

Per `01-Product.md`: a competent moderator spends **roughly 90 seconds per report** doing the same five lookups manually. That's the baseline.

We use **90 seconds** as the per-report baseline for MVP. It's:
- Conservative (real values often higher).
- Round (easy to explain).
- Defensible (cited in the product brief).

### 6.2 The Formula

```
time_saved_per_action = max(0, BASELINE_SECONDS - decision_latency_seconds)
time_saved_total = sum(time_saved_per_action) for all actions in window
```

Where `decision_latency_seconds = (action.executed_at - verdict.rendered_at)`.

Critical caveats:

- **Only counts actions where the mod actually acted.** Verdicts that go unread don't count.
- **Capped at the baseline.** If a mod takes longer than 90s, we don't count negative time. The mod could have been doing something else; we don't punish them.
- **Excludes ignored verdicts.** If a verdict was rendered but the mod never opened the queue, no time-saved credit.

### 6.3 What We Display

Dashboard tile: **"2h 18m saved today"**.

Hover tooltip: *"Based on an average of 90 seconds per report for manual investigation. ModPilot's investigation lets you decide in seconds instead of minutes."*

### 6.4 Why This Is Honest

- The baseline is stated publicly (in the tooltip).
- The cap prevents negative inflation.
- The formula excludes false-positive credit (ignored verdicts).
- A mod who disagrees can compute their own number from the audit log.

We do not inflate this number. The product's credibility rides on this calculation being defensible.

---

## 7. Mod Dashboard

The custom-post Dashboard UX is specified in `09-UX.md` Section 8. This section covers what the dashboard *reads* and how it stays performant.

### 7.1 Data Flow

```
Mod opens Dashboard custom post
    ↓
Devvit reads `dashboard_summary:<sub>` from Devvit KV (5min cache)
    ↓
On miss: Devvit calls Engine `/v1/dashboard/<sub>` (post-MVP endpoint)
   OR reads pre-aggregated Postgres rows via internal job
    ↓
Renders tiles + queue
```

For MVP, the Engine pushes aggregated summary into Devvit KV via the hourly `analytics_rollup` job. The dashboard is always reading from KV; no synchronous Engine call required when opening the dashboard. This keeps the Dashboard render under 200ms.

### 7.2 What Each Tile Reads

| Tile | Source | Refresh |
|---|---|---|
| Investigations today | `analytics_daily` current row | Hourly |
| Time saved today | Computed from `feedback.recorded` events with decision latency | Hourly |
| Acceptance rate today | `analytics_daily.acceptance_rate` | Hourly |
| Cost today | `analytics_daily.cost_usd` | Hourly |
| Tier distribution | `analytics_daily.by_tier` | Hourly |
| Queue panel | `pending_investigation:*` keys in Devvit KV | Real-time |
| Footer accuracy / response time | `subreddit_memory` nightly fields | Nightly |
| Cold-start progress | `subreddit_memory.feedback_events` | Real-time |

### 7.3 Performance Targets

- Dashboard render: <500ms p95.
- Tile staleness: ≤1 hour for "today" tiles; ≤24h for 30-day stats.

---

## 8. Cost Reporting

Per `06-AILayer.md` Section 9, cost is tracked per investigation and per subreddit.

### 8.1 What Mods See

- **Cost today** (tile, optional — controlled by `showCostInDashboard` setting; default off).
- **Cost per investigation** (in the Investigation Timeline, optional — same setting).

### 8.2 What Engineers See

- Per-tier cost histograms.
- Per-subreddit cost totals (Grafana dashboard).
- Cost cap proximity alerts.

### 8.3 Why Cost Is Off By Default

Most mods don't care about the numbers and showing dollars-and-cents may feel surveillance-y. Power Mod Priya cares; everyone else doesn't. So we hide it behind a toggle.

---

## 9. Observability Targets

What we actively monitor.

| Metric | Healthy | Concerning | Page |
|---|---|---|---|
| `engine.requests.total{status=5xx}` rate | <0.5% | >2% over 1h | >5% over 15min |
| `engine.validation.pass_rate` | >97% | <95% over 1h | <90% over 15min |
| `engine.fallback.rate` | <1% | >3% over 1h | >5% over 15min |
| `engine.cache.hit_rate{cache=thread_summary}` | >70% | <60% over 6h | — |
| `engine.investigation.cost_usd` (per sub, per day) | <$5 | approaching cap | over cap |
| `devvit.circuit.state` per sub | closed | half-open repeatedly | open >5min |
| `engine.latency_ms{route=/investigate}` p95 | tier-dependent | +20% vs baseline | +50% vs baseline |

Alert rules live in `engine/observability/alerts.yaml`.

---

## 10. Privacy & Aggregation Rules

Same isolation invariants as the data layer.

### 10.1 No Cross-Sub Aggregation in Mod Dashboard

Each subreddit sees only its own numbers. The dashboard never compares "your sub vs. other subs" — that would imply cross-sub data access we structurally don't have.

### 10.2 No Per-Mod Performance Stats

We don't show "Mod X has 95% acceptance rate; Mod Y has 60%." Even within a team, that surfaces team dynamics we shouldn't insert into. Aggregate team stats are fine; individual stats are not.

### 10.3 No PII in Metrics Payloads

- No usernames in metric labels.
- No content excerpts in event payloads.
- Subreddit IDs are fine (operational necessity).
- User IDs appear only in `feedback.recorded` payloads, never in aggregated metrics, and are 30-day redacted in logs per `10-ReliabilityAndSafety.md` Section 12.

### 10.4 No Engagement-Style Metrics

We don't track "minutes spent in dashboard" or "session length." This is a moderation tool, not a content product. Engagement metrics encourage product decisions we don't want to make.

---

## 11. Demo Use

The dashboard is a demo asset. The script (`15-Hackathon.md`):

> "47 investigations today. 2 hours 18 minutes of moderator time saved. 87% acceptance rate. $0.31 of compute. That's ModPilot operating economically at scale."

Three concrete numbers in one sentence. Memorable. Defensible. Repeatable.

The cold-start badge and the per-tier breakdown also belong in the demo — they signal operational maturity beyond the headline tile.

---

## 12. What's Out of Scope

For MVP:
- **Public ModPilot accuracy stats per subreddit.** Trust signal but double-edged. Defer.
- **Trend charts over time.** Daily tiles only for MVP; charts are post-MVP.
- **Cross-sub federation analytics.** Hard "no" until federation is an explicit feature with opt-in.
- **Real-time metric streaming to the dashboard.** Hourly rollup is sufficient. WebSocket complexity is unnecessary.
- **Mod-team leaderboards.** No.

---

## 13. Analytics Invariants

1. No metric exposes data from another subreddit.
2. No metric exposes individual moderator performance.
3. No metric payload contains content excerpts or PII beyond user IDs (and only in non-aggregated event records).
4. The time-saved calculation is publicly documented in-product.
5. Cost reporting is off by default.
6. The dashboard renders without a synchronous Engine call (reads pre-aggregated state).
7. Trust scores never appear as numbers; only tier labels.

Violations are bugs.

---

## 14. Open Questions

- **Right baseline for "time saved"?** 90s is conservative. We may revisit with empirical data from real installations.
- **Should we surface evaluation-harness regression scores in the mod dashboard?** Probably no; that's engineer-facing.
- **Should cost-per-action be a "saved compute equivalent" framing?** Probably no; just show dollars when enabled.

Tracked in root `CLAUDE.md`.

---

## 15. Related Documents

- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — Per-investigation observability emissions.
- [`05-Memory.md`](05-Memory.md) — Subreddit Memory fields that feed the dashboard.
- [`06-AILayer.md`](06-AILayer.md) — LLM cost and latency metrics.
- [`07-DataLayer.md`](07-DataLayer.md) — `analytics_daily` table.
- [`08-API.md`](08-API.md) — `/v1/analytics/rollup` endpoint.
- [`09-UX.md`](09-UX.md) — Dashboard UX spec.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Privacy and PII rules in metrics.
- [`13-Infra.md`](13-Infra.md) — Grafana setup, Prometheus scraping.
- [`15-Hackathon.md`](15-Hackathon.md) — How analytics features in the demo.