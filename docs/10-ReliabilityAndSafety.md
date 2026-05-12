```markdown
# 10 — Reliability and Safety

> **Purpose:** Production-readiness and trust, combined. Covers graceful degradation, timeouts, idempotency, rate limiting, kill switch, human-in-the-loop guarantees, PII rules, audit, content safety, and trust mechanisms. Load when working on any reliability or safety concern.
>
> **Status:** Mostly static; the incident runbook evolves.

---

## 1. Philosophy

Two principles drive everything below:

1. **Fail closed, not open.** A missing recommendation is acceptable. A confidently-wrong recommendation is not.
2. **Trust is built on auditability, calibration, and reversibility.** Not on perfect accuracy. We earn trust by being transparent when right and honest when wrong.

Reliability and safety are the same problem viewed from two angles: *does the system behave honestly under failure?*

---

## 2. Reliability Model

### 2.1 Service Objectives

| Metric | Target |
|---|---|
| Engine availability (p95 over 7d) | 99.5% |
| Native mod queue functioning when Engine is down | 100% (non-negotiable) |
| Investigation completion within tier hard cap | 99% |
| Feedback durability on `2xx` response | 100% |
| Cross-subreddit data leakage | 0 |

### 2.2 Failure Modes (Comprehensive)

| Failure | User-visible behavior | System behavior |
|---|---|---|
| Engine unreachable | Verdict Card hidden; native queue normal; banner: "ModPilot temporarily unavailable" | Devvit circuit breaker opens after 10 consecutive failures |
| LLM provider 5xx | Verdict ships as rule-based fallback, LOW confidence | Retry policy, then `fallback: true` flag |
| LLM provider timeout | Same as above | Same |
| Validation fails twice | Verdict ships at LOW confidence with `validation_failed` flag | Logged; eval harness reviews |
| Postgres unreachable | Investigation runs but isn't persisted | Disk fallback log; reconcile on recovery |
| Redis unreachable | Cache miss everywhere; latency + cost spike | Investigation continues; alerts fire |
| Validation hallucinated IDs | Corrective retry once, then demote | Standard validation flow |
| Cost cap exceeded | New investigations deferred to next window | `429 RATE_LIMITED` returned |
| Devvit trigger replayed | Idempotent; cached verdict returned | `pending_investigation:<id>` short-circuits |
| Investigation hits hard cap | Partial verdict ships, confidence demoted | `is_partial: true` flag |
| Kill switch enabled | Banner: "ModPilot is paused" | Triggers exit early; no Engine calls |
| Mod-action mismatch with recommendation | Recorded as feedback, normal flow | Alignment marked `OVERRIDDEN`/`REJECTED` |
| Bad prompt deployed | Eval harness regression catches in CI | Deploy blocked |

The unifying principle: **the system always returns something honest, or it returns nothing.** It never returns something wrong with confidence.

### 2.3 Blast Radius Limits

- A single failing tool never aborts an investigation — the orchestrator continues with reduced evidence.
- A single failing investigation never affects others — the Engine is stateless between requests.
- A single failing subreddit never affects others — every store query is sub-scoped.
- A single failing LLM call retries once with reduced timeout, then falls back.

---

## 3. Timeouts and Retries

Every cross-boundary call has an explicit timeout. Every retry policy is bounded.

### 3.1 Timeout Matrix

| Boundary | Timeout | Retries |
|---|---|---|
| Devvit → Engine `/investigate` (trigger) | 6s | None (let `retryFailed` job handle) |
| Devvit → Engine `/investigate` (menu) | 10s | None |
| Devvit → Engine `/feedback` | 3s | 3, exp backoff |
| Devvit → Engine `/memory/*` | 2s | 3, exp backoff |
| Engine → LLM (Reasoner) | 6s | 1 at 70% timeout, then fallback |
| Engine → LLM (Summarizer) | 2s | 1 at 70% timeout, then degrade |
| Engine → Postgres | 2s | 1 |
| Engine → Redis | 500ms | None; bypass cache on miss |
| Per-tool execution | tier-dependent (1–1.5s typical) | None |
| Investigation hard cap | FAST 2s / STANDARD 7s / DEEP 12s | None |

### 3.2 Retry Rules

- **Idempotent endpoints retry on timeout/5xx** with exponential backoff (250ms, 750ms, 2s).
- **Non-idempotent endpoints never retry from the trigger path.** Latency budget can't absorb it. Async retry job handles it.
- **4xx never retries.** Surfaces and logs.
- **429 respects `Retry-After`** up to 30s; longer waits queue for the next window.

### 3.3 Hard Caps

Every retry policy has a final ceiling. Past that, the system returns a degraded result, not an indefinite wait. Indefinite waiting is a bug class we explicitly prohibit.

---

## 4. Idempotency

Required on every non-idempotent endpoint. Detailed in `08-API.md`.

- **`Idempotency-Key: <uuid>`** required header.
- Engine stores `(request hash → response)` under `idem:<key>` in Redis for 60s.
- Same key + same body → cached response.
- Same key + different body → `409 IDEMPOTENT_REPLAY_DIFFERS`.
- Missing key → `401 AUTH_FAILED` (treated as auth failure, since signing requires it).

Idempotency protects against:
- Devvit trigger replays (Reddit fires triggers more than once for some events)
- Network retries
- Mod double-clicking action buttons

---

## 5. Rate Limiting

Per-subreddit cost caps enforced at the Engine.

| Window | Cap | Behavior |
|---|---|---|
| Hourly | $1.00 | New investigations → `429 RATE_LIMITED` with `Retry-After` |
| Daily | $5.00 | Same; resets at UTC midnight |

Counters in Redis at `rate:hour:<sub>` and `rate:day:<sub>`. Atomic increment on each LLM call's cost.

**Exempt from rate limiting:** `/feedback`, `/memory/*`, lifecycle endpoints, health endpoints. These are effectively free.

**UI behavior on rate-limit:** dashboard banner — "ModPilot is throttled for this hour to stay within budget. Investigations resume at HH:MM."

Caps are configurable per-deployment. MVP defaults are conservative; we'll loosen them as we see real usage data.

---

## 6. Kill Switch

Subreddit-level pause. Single setting; instant effect.

### 6.1 Setting

`enabled: boolean` in `Devvit.addSettings`, default `true`. Documented in `03-Devvit.md`.

### 6.2 Propagation

- Devvit reads `subreddit_config:<sub>` on every trigger (60s cache).
- When `enabled=false`: trigger handlers exit early after logging. No Engine call.
- Engine also enforces: if request arrives for a disabled sub, return `503 KILL_SWITCH_ACTIVE`. Defense in depth.

### 6.3 UI

- Dashboard banner: "ModPilot is paused. Re-enable in settings."
- Verdict Card hidden in queue.
- Settings page shows: "Toggle on to resume."

### 6.4 Propagation Latency

≤60 seconds (settings cache TTL). Acceptable for a pause feature; mods understand it.

### 6.5 What Persists During Pause

- Existing verdicts remain readable (dashboard, audit log).
- Mod actions still record feedback (we don't lose the signal).
- Scheduled jobs continue (analytics rollup, retries are no-ops for this sub).
- Memory tables are not deleted.

Unpause is symmetric: flip the toggle, investigations resume.

### 6.6 Global Kill Switch

Operator-only. A feature flag at the Engine level (`engine/observability/features.py`) can globally disable all investigation. Returns `503 ENGINE_DEGRADED` to all `/investigate` calls. Used only in emergencies (e.g., a bad prompt deploy). Activation logged + paged.

---

## 7. Circuit Breaker

Devvit-side, in `engineClient.ts`. Protects mods from sustained Engine failures.

### 7.1 Mechanics

- Track failures in a rolling 60-second window.
- **Open** after 10 consecutive failures OR 50% failure rate over 20+ requests.
- **Half-open** every 30 seconds: send one probe request.
- **Close** on probe success.
- While open: triggers skip Engine calls; menu actions return immediate "ModPilot unavailable" UX.

### 7.2 UX

Dashboard banner: "ModPilot is temporarily unavailable. Reddit's queue continues working normally."

No technical detail surfaced to mods. They don't need to know which dependency failed.

### 7.3 Logs

Every circuit state transition emits a structured log with reason, failure count, timestamp. Correlatable to Engine logs via correlation IDs.

---

## 8. Graceful Degradation

The system is designed so that every component can fail and the system still serves something.

| Component down | Behavior |
|---|---|
| Engine entirely | Devvit hides Verdict Cards; native queue works; banner shown |
| Postgres | Engine logs to disk fallback; investigations run but not persisted; reconciliation job replays on recovery |
| Redis | Cache miss everywhere; investigation cost + latency increase; alerts fire; system functions |
| LLM Reasoner | Rule-based fallback verdict (Section 9); LOW confidence; clear UI signaling |
| LLM Summarizer | Thread context falls back to raw transcript passed to Reasoner |
| Single tool | Other tools run; Reasoner sees reduced evidence; confidence demoted via convergence weakness |
| Validation | Verdict ships at LOW confidence with `validation_failed: true` |

**The mod queue continues working in every failure mode.** This is the single most important reliability invariant.

---

## 9. Rule-Based Fallback Verdict

When the Reasoner is fully unavailable, the Engine still produces a verdict via heuristics. Detailed in `06-AILayer.md` Section 11.

Summary:
- High rule-match strength + high velocity → REMOVE at confidence ≤0.55
- Low rule-match strength → APPROVE at confidence ≤0.50
- Otherwise → NO_ACTION at confidence ≤0.40
- All fallback verdicts marked `fallback: true`, demoted to MEDIUM max.

Fallbacks are deliberately under-confident. The bias is toward asking the mod to decide.

---

## 10. Human-in-the-Loop Invariant

The single most important safety property in the entire product.

### 10.1 The Rule

**ModPilot never takes a moderation action autonomously.** Every Remove / Approve / Escalate / Lock requires an explicit moderator click on a button surfaced in the Devvit UI.

### 10.2 Where It's Enforced

| Layer | Enforcement |
|---|---|
| Engine code | No Reddit moderation API client exists in `engine/`. No code path can call Reddit's action endpoints. Enforced by absence + grep CI check. |
| API contract | `/v1/investigate` returns recommendations. Period. No "execute" endpoint exists. |
| Devvit code | Action execution lives in `ui/components/ActionBar.tsx` handlers, only invoked by `onClick`. No timer, no auto-trigger, no scheduler can fire them. |
| Settings | No "auto-execute high confidence" option. Future opt-in requires ADR. |
| Cold-start | Even action button styling defaults are suppressed in cold-start. |

### 10.3 What This Rules Out

- No "low effort spam auto-removal" mode.
- No "auto-ban repeat offenders" mode.
- No "auto-approve trusted users" mode.
- No scheduled cleanup actions.
- No bulk actions originating from ModPilot recommendations.

A mod can manually do any of these. ModPilot does not.

### 10.4 Why This Is Non-Negotiable

It is the trust foundation of the product. Auto-actions erode moderator trust irrecoverably. The pitch ("augmentation, not replacement") collapses the moment we automate a decision. We do not negotiate on this.

---

## 11. Safety Philosophy

Three intertwined commitments:

### 11.1 Transparency

Every recommendation includes its full evidence trail. Every claim cites evidence (`06-AILayer.md` Section 5). The Investigation Timeline is the audit substrate.

### 11.2 Auditability

Every recommendation and every mod action lives in the immutable audit log. Queryable by subreddit head mods. Exportable (post-MVP).

### 11.3 Reversibility

Every ModPilot recommendation is undone by a single mod click. We never take an action that can't be cleanly reversed by inaction or the opposite action.

---

## 12. PII Handling

ModPilot stores Reddit user IDs only. Never email, phone, real names, or any external identity data.

### 12.1 At the LLM Boundary

User IDs are **anonymized to tokens** (`u_a`, `u_b`, ...) before any LLM prompt. The anonymizer (`engine/llm/anon.py`) is per-investigation, so tokens are local — no global mapping exists.

The Reasoner sees `u_a`. The UI sees `u/example_username`. Mapping happens at the storage layer (rehydration before insert into `verdicts.rationale`).

**Test enforced:** `engine/llm/test_anon.py` runs a synthetic investigation and asserts no real user ID appears in any LLM request payload. CI gates this on every PR.

### 12.2 In Storage

- User IDs stored only in tables that need them (memory, investigations, feedback, audit log).
- Comment/post content **not retained** beyond derived signals (escalation scores, summaries, evidence rows).
- Reddit's content remains Reddit's; we don't hoard it.

### 12.3 In Logs

- Live logs (last 30d) may contain user IDs for debugging.
- Logs older than 30 days have user IDs redacted automatically (worker job).
- Audit log is the exception: retains user IDs indefinitely per retention policy.

### 12.4 Mod-Initiated Forgetting

A mod menu action wipes a specific user's memory in the current subreddit:
- `user_memory` row soft-deleted.
- Future investigations on that user start fresh.
- Audit log entry written (the wipe itself is auditable).
- The mod's action is itself logged.

Used when a user is given a fresh start after appeal. Never automated.

### 12.5 Uninstall

`AppRemove` → all sub data marked `pending_deletion = now() + 30d` → nightly job hard-deletes after the grace window. Detailed in `07-DataLayer.md` Section 6.

### 12.6 What We Never Do

- Send raw usernames to LLM providers.
- Store cross-subreddit user data in any joinable form.
- Expose `trust_score` floats in UI (only tier labels).
- Retain non-banned-user memory beyond 2 years.
- Share data between subreddits without explicit federation opt-in (post-MVP, ADR-gated).

---

## 13. Audit Log

The immutable trail of every recommendation and every mod action. `07-DataLayer.md` table 2.9.

### 13.1 What Gets Logged

- Every investigation (with verdict reference)
- Every recommendation made
- Every mod action taken
- Every memory wipe
- Every config change
- Every kill switch toggle

### 13.2 Properties

- **Immutable.** Append-only. No update/delete in normal operation.
- **Subreddit-scoped.** Every row has `subreddit_id NOT NULL`.
- **Mod-readable.** Head mods can query their subreddit's log (post-MVP UI).
- **Exportable.** JSON export via mod menu action (post-MVP).
- **Retained 2 years minimum.** Beyond standard retention.

### 13.3 Use Cases

- Mod team disagreement: "Why did ModPilot recommend this?" → look it up.
- User appeal: "Why was my comment removed?" → mod can show the evidence trail.
- Compliance: which decisions were made when, by whom (mod or ModPilot).
- Eval baseline: replay historical investigations against new prompt versions offline.

---

## 14. Content Safety

ModPilot processes user-generated content during investigation. Some of it is harmful by definition (that's why it was reported).

### 14.1 Handling Harmful Content in Prompts

- Content excerpts in evidence are summarized, not pasted verbatim.
- The Summarizer is instructed to paraphrase notable quotes, not quote them.
- The Reasoner sees structured evidence rows, not raw content.

This means harmful content rarely flows directly into LLM prompts. When it must (e.g., short reported comments), it's bounded in length and surrounded by structured context.

### 14.2 Handling Harmful Content in UI

- Verdict Card shows evidence summaries, not raw content. Mod can click through to Reddit's native UI to see the original.
- Investigation Timeline shows tool findings, not raw quotes.
- Notable quotes in thread summaries are paraphrased.

This protects mods from re-traumatization on repeat exposure and respects Reddit's content display patterns.

### 14.3 Categories We Refuse to Process

ModPilot does not investigate content involving:
- CSAM (rejected at policy layer; escalated to Reddit safety teams; never enters investigation pipeline)
- Doxxing of identifying personal information (escalated via Reddit's reporting channels)

These categories are pre-filtered by content signals before investigation begins. They get an immediate `ESCALATE` recommendation with no further processing.

### 14.4 Copyright

Notable quotes are paraphrased. We never reproduce Reddit content verbatim in stored verdicts or in UI. Search-result citation rules (per Claude's standards) apply to the Summarizer's output.

---

## 15. Moderator Trust Mechanisms (Catalog)

Concrete features that build trust. Each maps to a rationale.

| Mechanism | Rationale |
|---|---|
| Honest confidence (LOW tier surfaces "I'm unsure") | Calibrated honesty > confident wrongness |
| Evidence citation in every verdict | Auditability over opacity |
| Investigation Timeline always available | Transparency over black-box |
| Reversibility — every action is one click and undoable | Mod judgment is sacred |
| Audit log with every recommendation logged | Accountability |
| Override is first-class (recorded, learned from) | Mod knowledge supersedes ModPilot |
| Cold-start badge during learning phase | Set honest expectations |
| Kill switch with instant pause | Mod controls the system |
| Cost shown to mods (optional) | Transparency on resource use |
| No autonomous actions | Trust foundation |

When a mod feature decision is unclear, the question is: *does this make ModPilot more auditable, more honest, more reversible?* If yes, do it.

---

## 16. Incident Runbook (MVP)

Concrete procedures for the failure modes we anticipate. Lives here; gets fleshed out in production.

### 16.1 Engine Down

**Signal:** Devvit circuit breakers open across subreddits; alerts fire.

**Steps:**
1. Check Fly.io dashboard for app health.
2. Check Postgres + Redis status.
3. If LLM provider issue: rule-based fallback already engaged.
4. Roll back to last known good deploy if recent change suspected.
5. Communicate via App Directory status text (post-MVP: an in-app status banner).

### 16.2 Bad Prompt Deployed

**Signal:** Validation failure rate spikes; mod acceptance drops.

**Steps:**
1. Roll back prompt version via env variable; no redeploy needed.
2. Confirm validation rates recover.
3. Eval harness runs against the regression scenarios.
4. Post-mortem ADR.

### 16.3 Cost Runaway

**Signal:** Daily costs exceed budget; cap counters approaching ceiling on many subs.

**Steps:**
1. Inspect cost-per-investigation tier breakdown.
2. Tighten subreddit-level caps temporarily.
3. Investigate cache miss rate (often the root cause).
4. Roll prompts or tier thresholds back if recent change.

### 16.4 Suspected Data Leak Between Subreddits

**Signal:** A mod reports seeing information from another subreddit.

**Steps:**
1. **Immediate global kill switch.** Halts all `/investigate` calls.
2. Inspect query logs for the affected subreddit IDs.
3. Verify `subreddit_id` filter present on every query in the suspect code path.
4. If confirmed: incident-severity-1; notify affected subs; post-mortem ADR.

### 16.5 Validation Hallucinations Spike

**Signal:** `validation_failed` rate > 5% over a rolling hour.

**Steps:**
1. Check recent prompt deploys.
2. Inspect failure modes — is the model citing nonexistent IDs? Uncited claims? Schema parse failures?
3. Roll back prompt if recent change.
4. Bump eval scenarios for the failure category.

---

## 17. Observability for Reliability

Every reliability concern emits structured signals. The minimum required:

### 17.1 Logs

- `circuit.opened` / `circuit.closed` (Devvit)
- `engine.degraded` (Engine, on dependency failure)
- `validation.failed` (with reason)
- `fallback.engaged` (Reasoner unavailable)
- `kill_switch.toggled` (per subreddit)
- `rate_limit.hit` (per subreddit)

### 17.2 Metrics

- `engine.availability_5xx_rate`
- `engine.validation.pass_rate`
- `engine.fallback.rate`
- `engine.cache.hit_rate` (per cache name)
- `devvit.circuit.state` (per subreddit)
- `feedback.alignment_distribution` (accepted / rejected / overridden / confirmed_no_action)

### 17.3 Alerts

- Engine availability < 99% over 1h → page
- Validation pass rate < 90% over 1h → page
- Fallback rate > 5% over 1h → page
- A single subreddit at cost cap consistently → notify mod team (post-MVP)
- Cross-sub data leakage alert (synthetic test) → page severity-1

---

## 18. Invariants

Properties that must always hold. Each is testable.

1. The Engine never makes Reddit moderation API calls.
2. No code path can auto-execute a moderation action.
3. Every cross-boundary call has a timeout.
4. Every Redis key has a TTL.
5. Every sub-scoped query filters by `subreddit_id`.
6. No LLM request payload contains a raw user ID.
7. Every persisted recommendation has a corresponding evidence trail.
8. The mod queue continues working when the Engine is down.
9. Validation failures never produce a HIGH-confidence verdict.
10. Idempotency keys are required on all non-idempotent endpoints.
11. The kill switch propagates within 60 seconds.
12. No data crosses subreddit boundaries in any query, log, or LLM call.
13. `trust_score` is never returned in any API response or UI surface; only tier labels.
14. Deletions of subreddit data respect the 30-day grace window.

Violating any of these is a severity-1 bug.

---

## 19. Open Questions

- Should we expose a "ModPilot decision history" UI directly to non-mod users for transparency? Post-MVP question.
- Should the cold-start threshold be subreddit-size-aware? Tiny subs might never hit 50 events.
- Should audit log export require head-mod confirmation? Probably yes; post-MVP.
- Should we publish ModPilot's accuracy stats publicly per subreddit? Trust signal; double-edged.

Tracked in root `CLAUDE.md`.

---

## 20. Related Documents

- [`01-Product.md`](01-Product.md) — Non-goals (no autonomous moderation, no cross-sub data sharing).
- [`02-Architecture.md`](02-Architecture.md) — Architecture invariants, blast-radius limits.
- [`03-Devvit.md`](03-Devvit.md) — Circuit breaker implementation, kill switch trigger behavior.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — Engine invariants, budget enforcement.
- [`05-Memory.md`](05-Memory.md) — Cold-start safety, mod-initiated forgetting.
- [`06-AILayer.md`](06-AILayer.md) — Evidence-citation contract, hallucination mitigation, anonymization.
- [`07-DataLayer.md`](07-DataLayer.md) — Retention policy, PII rules at storage.
- [`08-API.md`](08-API.md) — Error contract, idempotency, rate limits.
- [`09-UX.md`](09-UX.md) — Uncertainty UX, error states, degraded-mode banners.
- [`11-Evaluation.md`](11-Evaluation.md) — Pre-deploy regression gates.
- [`13-Infra.md`](13-Infra.md) — Secrets, deployment, rotation.
- [`adr/`](adr/) — Foundational decision records (HITL, evidence citation, no online RL).
```