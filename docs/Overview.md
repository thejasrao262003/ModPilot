# ModPilot — Project Overview

A single document that captures what ModPilot is, how it's built, and every feature shipped in this codebase.

---

## 1. What ModPilot Is

**Tagline:** The context-aware investigation engine for Reddit moderation.

**One-sentence pitch:** ModPilot runs the five lookups every experienced moderator does manually — user history, thread context, rule match, report patterns, prior actions — and hands you a verdict with the full evidence trail.

**Core thesis:** Most moderation tools classify content. ModPilot investigates context. The loop is `report → investigate → reason → recommend → learn`. Classification is a byproduct; the actual product is the **adaptive investigation** that produces a verdict alongside its full reasoning trail.

**What it isn't:**
- Not an autonomous moderation bot — every action requires a moderator click.
- Not a content classifier — it's an investigator that happens to produce classifications.
- Not a replacement for moderators — it does the lookup work so humans can do the judgment work.
- Not opaque — every verdict claim cites a specific evidence row.

**Target users:**
- **Sam (Solo Mod, ~5k subs)** — cut per-report time from 90s to <15s, low setup overhead.
- **Maya (Mod Team, ~50k subs)** — shared moderation memory across the team, repeat-offender detection.
- **Priya (Power Mod, 500k+ subs)** — brigade detection, audit trails, low per-investigation cost.

**Hard invariants** (never violated):
1. Human-in-the-loop mandatory.
2. Every verdict claim cites evidence.
3. Honest confidence — low-confidence verdicts say "I'm unsure".
4. Cold-start safety — new installs run conservative until ~10 investigations accumulate.
5. Graceful degradation — engine failure never breaks Reddit's native mod queue.
6. Evidence-first UI — every recommendation expands into its Investigation Timeline.
7. Subreddit isolation — every persisted key is `subreddit_id`-scoped.
8. Layer purity — Devvit ↔ engine layers stay separate.

---

## 2. Architecture (Current, Post-ADR-0007)

```
                  ┌──────────────────────────────────┐
   Reddit  ──────▶│ Devvit triggers                  │
  (report,        │  • onCommentReport               │
   modaction,     │  • onPostReport                  │
   install)       │  • onModAction                   │
                  │  • onAppInstall / onAppUpgrade   │
                  └──────────────┬───────────────────┘
                                 ▼
                  ┌──────────────────────────────────┐
                  │ Devvit app (TypeScript, Hono)    │
                  │  ┌────────────────────────────┐  │
                  │  │ Menu items                 │  │
                  │  │  • Investigate (post/cmt)  │  │
                  │  │  • Configure policy        │  │
                  │  │  • Stats                   │  │
                  │  └────────────────────────────┘  │
                  │  ┌────────────────────────────┐  │
                  │  │ In-process engine          │  │
                  │  │  Strategy → Orchestrator   │  │
                  │  │   → Tools → Reasoner       │  │
                  │  │   → Validator → Calibrator │  │
                  │  └──────────┬─────────────────┘  │
                  │             │                    │
                  │  ┌──────────▼────────┐           │
                  │  │ Devvit Redis      │           │
                  │  │  (managed, scoped)│           │
                  │  └───────────────────┘           │
                  └──────────────┬───────────────────┘
                                 │ HTTPS (global allowlist)
                                 ▼
                  ┌──────────────────────────────────┐
                  │ Google Gemini API                │
                  │  • 2.5 Pro (Reasoner)            │
                  │  • 2.5 Flash (Summarizer)        │
                  └──────────────────────────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────────┐
                  │ Verdict custom post              │
                  │  • auto-removed (mod queue only) │
                  │  • web view: card + timeline     │
                  │  • 4 action buttons              │
                  └──────────────┬───────────────────┘
                                 ▼
                  ┌──────────────────────────────────┐
                  │ Moderator clicks an action       │
                  │  → reddit.remove/approve/lock    │
                  │  → feedback + stats counters     │
                  │  → user_memory bumps             │
                  └──────────────────────────────────┘
```

**Why this shape:** Reddit's Devvit platform blocks outbound HTTP to personal-domain endpoints (ngrok, HF Spaces, Fly, Render, Vercel all fail policy review). The only externally-reachable provider on the global allowlist is `generativelanguage.googleapis.com`. So the engine runs in-process inside the Devvit app, calls Gemini directly, and persists to Devvit's managed Redis — no external backend, no domain approvals.

A parallel Python engine (`engine/`) exists as the reference implementation with 340+ passing tests, but is not on the demo path. TS engine has its own deterministic test suite (35 passing) at `devvit-app/src/engine/*.test.ts`.

---

## 2.5 Verdict Explainability Surfaces (Features 1–8)

Layered on top of the core pipeline, the verdict UI now exposes seven moderator-facing panels. All deterministic — none drive the recommendation or calibrated confidence, just describe them.

| Surface | Source | Where it shows |
|---|---|---|
| **Priority Pill** (F1) | `priority.ts` — combines calibrated confidence, recommendation, velocity, user risk, escalation, rule match into a 0..100 score + bucket (🔥 Urgent / ⚠️ Review Soon / ℹ️ Low Risk) | Verdict card header, persisted in `verdict:{cid}:priority_json` for queue sorting |
| **Repeat-Offender / First-Time / Positive-History Badge** (F2 + F7) | `explainability.ts:deriveAuthorSignal` — derived from `user_memory` + `prior_actions` evidence | Author signal banner above the confidence row |
| **Alignment Line** (F3) | `stats.ts:readAlignmentSnapshot` — feedback_aligned / feedback_total, suppressed until ≥5 mod actions accumulate | Verdict card footer ("ModPilot and your team agree N%") |
| **Confidence Explanation** (F4) | `explainability.ts:deriveConfidenceFactors` — lists exactly which Calibrator inputs pushed confidence up/down | Dedicated panel: "Why confidence is what it is" |
| **Escalation Banner** (F5) | `escalation.ts:deriveEscalation` — categorical level (none / mild / moderate / high) from `thread_context` outputs | Red/amber banner above the verdict card when level ≥ mild |
| **Rule Match Explainability** (F6) | `explainability.ts:buildRuleMatchDisplay` — surfaces the matched rule + score band + ADR-0003-validated evidence ids | Dedicated panel: "Potential rule matches" |
| **Key Factors** (F8) | `explainability.ts:deriveKeyFactors` — top contributors sorted by impact (High/Medium/Low) and direction (positive/negative) | Dedicated panel: "What most influenced this" |

## 2.6 Moderator Response Generator (Feature 9)

After clicking an action button in the verdict UI, the moderator now sees a **lightweight response workflow**:

1. **Optional guidance text** (e.g. "Don't penalize this user this time", "Explain Rule 3").
2. **Generate Draft** → Gemini 2.5 Flash produces a 60–160 word draft message grounded in subreddit rules + verdict rationale + matched rules. Output kinds: `REMOVE`, `APPROVE_WITH_WARNING`, `WARNING`, `ESCALATE`.
3. **Edit + Send Reply** → POST `/api/send-response` calls `comment.reply()` / `post.addComment()` after re-checking moderator auth.
4. **Take action without reply** → applies the action via `/api/feedback` and closes.
5. **Skip the draft** → just takes the action immediately, same as before.

Invariants preserved:
- Never auto-sends — explicit moderator click is required.
- Action endpoint (`/api/feedback`) unchanged; the draft flow is additive.
- Draft references only rules + evidence already in the verdict.
- Both `/api/draft-response` and `/api/send-response` re-check moderator authorization.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Devvit Web (Hono + Vite, Node.js sandbox) | Reddit-blessed app platform. Per-app Redis, native mod API access. |
| Language (live path) | TypeScript | Devvit Web's first-class language. |
| Persistence | Devvit-managed Redis | Subreddit-scoped, free, no domain approval. |
| Reasoner LLM | Gemini 2.5 Pro | High-quality reasoning with structured output + thinking budgets. On Devvit's global outbound allowlist. |
| Summarizer LLM | Gemini 2.5 Flash | Cheap thread summarization with thinking disabled. |
| Reference impl | Python 3.11 + FastAPI + SQLAlchemy + asyncpg | Original engine; full test coverage; not on demo path. |
| Reference DB | Supabase Postgres + Upstash Redis | Provisioned, dormant. |

**Pinned models:**
- `gemini-2.5-pro` — Reasoner, temperature 0.0, thinking_budget 512, max_tokens 1024.
- `gemini-2.5-flash` — Summarizer, temperature 0.0, thinking_budget 0, max_tokens 512.

---

## 4. The Investigation Pipeline

Every reported/investigated item flows through these steps, in order, in `devvit-app/src/engine/pipeline.ts`:

| Step | Component | What happens |
|---|---|---|
| 0 | **Profile + memory load** | Read `sub:{sub_id}:profile` (personality + rules + region + tier override + cold_start_count), `sub:{sub_id}:user:{author_id}` (user memory), `sub:{sub_id}:thread:{thread_id}` (thread memory) in parallel. |
| 1 | **Rule-match precheck** | Substring token overlap between post content and each configured rule. Score 0..1 (max across rules). Feeds Strategy + Calibrator + appended as `policy_match` evidence row when score ≥ 0.2. |
| 2 | **Strategy Selector** | Pure function. Picks FAST (2 tools, ~1s, $0.003), STANDARD (4 tools, ~3s, $0.012), or DEEP (5 tools, ~6s, $0.030) based on reporter count, velocity z-score, user risk tier, rule match strength, personality, thread escalation, cold-start, tier override. |
| 3 | **Orchestrator loop** | Iterates the tier's tool plan with per-tool exception isolation, budget enforcement (tool count + wall-clock), and convergence policy (≥1 strong-signal on FAST, ≥2 on STANDARD/DEEP). |
| 4 | **Tools execute** | Each tool reads from Devvit Redis, produces a `ToolResult` with status (success/failure/skipped/timeout), a 1-line summary, a `detail` payload, and a `signal` strength. Appended to the Evidence Accumulator with monotonic `ev-N` ids. |
| 5 | **Reasoner** | Gemini 2.5 Pro single LLM call. Receives subreddit context + post content + rules + Evidence Block. Outputs structured JSON: `risk_tier`, `recommendation`, `rationale` (with inline `[ev-N]` citations), `raw_confidence`, `cited_evidence_ids`, `flags`. Only runs for STANDARD/DEEP. |
| 6 | **Citation validator** | Pure function. Rejects: empty rationale, no citations at all, hallucinated `ev-N` ids, citations to non-success evidence rows. On failure, builds a corrective retry prompt and the Reasoner gets one more shot. |
| 7 | **Calibrator** | Pure function. Discounts LLM self-report by 0.4×, weights it 25% against evidence_convergence (30%), subreddit_accuracy (20%), rule_match_strength (25%). Applies multiplicative demotions for validation_failed (0.6), partial (0.8), cold_start (0.85). Tier boundaries: HIGH ≥ 0.85, MEDIUM ≥ 0.60, LOW < 0.60. |
| 8 | **Verdict assembly** | Build the `Verdict` object: tier, risk_tier, recommendation, calibrated_confidence, rationale, top_evidence, timeline, confidence_breakdown, model_reasoner, cost_usd, latency_ms, flags. |
| 9 | **Persist + index** | `inv:{correlation_id}` hash, `sub:{sub_id}:author:{author_id}:invs` sorted set (for prior_actions next time), `verdict:{correlation_id}` hash (for the webview). |
| 10 | **Stats counters** | Bump `sub:{sub_id}:stats:*` counters: investigations_total, recommendation mix, tier mix, cost_micros, confidence_sum, latency_sum, degraded count. |

**Output**: a `Verdict` returned to the menu handler, which then renders a custom post and navigates the mod to it.

---

## 5. Features

### 5.1 Investigation Tools (live)

| Tool | Source | Latency target | Output signal |
|---|---|---|---|
| **report_velocity** | Devvit Redis sorted set, 1/5/15 min windows | <30ms | z-score vs baseline, `signal: 'high'` when z ≥ 3.0 |
| **user_history** | `sub:{sub_id}:user:{author_id}` hash | <50ms | risk_tier (new/trusted/neutral/watched), prior_violations, prior_approvals, last_seen, `signal: 'high'` when watched or violations ≥ 3 |
| **prior_actions** | `sub:{sub_id}:author:{author_id}:invs` sorted set + investigation hash lookups | <150ms | last N actions on this author, removal count, `signal: 'high'` when removals ≥ 2 |
| **thread_context** | Gemini 2.5 Flash + 24h Redis cache | <2s cold, <50ms cached | arc, escalation_turn, instigator_candidates, off_topic, total_turns, `signal: 'high'` when escalation_turn is set |
| **policy_match** | Rule-match precheck (substring score) | <5ms | Synthetic evidence row when score ≥ 0.2, `signal: 'high'` when score ≥ 0.5 |

### 5.2 Strategy Tiers

| Tier | Tools run | Time budget | Cost budget | Reasoner | Typical use |
|---|---|---|---|---|---|
| FAST | 2 | 800ms | $0.003 | No | Obvious spam, false-flag reports |
| STANDARD | 4 | 3000ms | $0.012 | Yes | Default for most reports |
| DEEP | 5+ | 6000ms | $0.030 | Yes | Harassment, brigading, watched users, escalating threads |

Tier selection is **adaptive per report**, not configured globally. A mod can force a tier via the policy form's `tier_override` field.

### 5.3 Personalities (3 presets)

| Preset | DEEP threshold shift | Phrasing surfaced to Reasoner |
|---|---|---|
| **strict** | -1 reporter, -1.0 z-score | "lean toward recommending action" |
| **balanced** (default) | 0 | "weigh evidence fairly" |
| **lenient** | +1 reporter, +1.0 z-score | "give benefit of the doubt" |

### 5.4 Citation Contract (ADR-0003)

- Reasoner system prompt explicitly requires every factual claim cite an `[ev-N]` evidence id.
- Pydantic / JSON schema for the Reasoner output includes `cited_evidence_ids` and `top_evidence_ids` fields.
- Post-generation validator (`devvit-app/src/engine/llm/validator.ts`) rejects:
  - Empty rationale
  - Rationales with zero `[ev-N]` references
  - References to ids that don't exist in the accumulator (hallucinated)
  - References to non-success evidence (e.g., skipped tools)
- On validation failure, a corrective retry prompt explains the error and asks for a fix. After two failures, the pipeline returns a degraded `NO_RECOMMENDATION` verdict.

### 5.5 Cold-Start Safety

- New subreddits run with `coldStart = true` until 10 investigations accumulate.
- Cold-start blocks the FAST tier and demotes all calibrated confidences by 0.85.
- `coldStart` is surfaced in the Reasoner prompt so the model knows.

### 5.6 Honest Uncertainty UX

When calibrated confidence < 0.60, the verdict UI:
- Replaces "Recommendation: REMOVE" with `🌱 ModPilot is unsure — your call`.
- Surfaces the "Honest uncertainty" marginalia from the copy module.
- Disables action pre-selection.
- Helpkext: "No action pre-selected. Evidence is mixed; your judgment matters here."

### 5.7 Mod-Facing Surface (4 menu items)

| Menu item | Location | Purpose |
|---|---|---|
| **Investigate with ModPilot** | post (mod-only) | Run a full investigation on this post. Opens verdict custom-post UI. |
| **Investigate with ModPilot** | comment (mod-only) | Same for comments. |
| **ModPilot: Configure policy** | subreddit (mod-only) | Form with personality (select), rules (paragraph), region (string), tier_override (select). Persists to `sub:{sub_id}:profile`. |
| **ModPilot: Stats** | subreddit (mod-only) | Read-only form showing investigations_total, average confidence, average latency, total cost, degraded count, recommendation mix, tier mix, alignment rate, mod-action mix. |

### 5.8 Verdict Custom Post

- Created via `reddit.submitCustomPost()` on each Investigate menu action.
- Title format: `🛡 ModPilot · {RECOMMENDATION} · {N}% · {target excerpt}`.
- Auto-removed via `post.remove()` immediately on creation → **lands in mod queue only**, never appears in the public feed.
- `postData: { correlation_id }` + Redis `post_correlation:{post_id}` mapping so the webview can rehydrate.
- Devvit `navigateTo` returns the mod to the post.

### 5.9 Verdict Webview (Custom Post UI)

Lives in `devvit-app/src/client/` (HTML + vanilla JS + CSS). Fetches `/api/verdict` (resolves correlation_id from postData → Redis fallback). Renders:

- **Masthead** — ModPilot wordmark, case file id, target excerpt.
- **Verdict card** — recommendation, calibrated confidence (with tier band), risk tier, evidence chips (clickable to highlight in timeline).
- **Honest uncertainty marginalia** when LOW conf.
- **Action bar** — 4 buttons: Remove / Approve / Escalate / Lock.
- **Investigation Timeline** — Each tool as a row with status glyph, verb, latency, evidence ids.
- **Reasoner panel** — model name, token counts, cost, full rationale with inline citation chips.
- **Status line** — moderator action result (recorded ✓ / aligned / overrode).

### 5.10 Real Moderator Actions

- `/api/feedback` is the action endpoint hit by the verdict UI's button clicks.
- **Moderator auth gate**: resolves caller's username, scans the subreddit's moderator list (`subreddit.getModerators()` paginated) — non-mods get 403 with no side effects.
- **Action application**: maps mod_action → Reddit API call:
  - REMOVE → `comment.remove()` / `post.remove()`
  - APPROVE → `comment.approve()` / `post.approve()`
  - LOCK → `comment.lock()` / `post.lock()`
  - ESCALATE → no Reddit API call (internal flag)
- **Feedback recording**: writes `feedback:{correlation_id}` hash with mod, mod_action, recommendation alignment, action_applied bool, action_error, timestamp.
- **Resolution recording**: writes `resolution:{target_id}` so the next "Investigate" modal on the same target shows "✓ Removed by u/X N min ago" instead of running again.
- **Stats bump**: feedback_total + feedback_aligned (when action matches recommendation) + per-mod-action counter.

### 5.11 Onboarding

`onAppInstall` (and `onAppUpgrade` for the upgrade-into-fresh-sub edge case):
- Seeds `sub:{sub_id}:profile` with default profile (balanced + empty rules + auto-tier) **only on fresh install**.
- Sends a modmail conversation to the subreddit's mod team (with `isAuthorHidden: true`) titled "👋 ModPilot is installed — finish setup in 2 minutes" containing onboarding instructions.
- Idempotent via `sub:{sub_id}:welcome_sent` flag — subsequent upgrades stay silent.

### 5.12 Stats Dashboard

`ModPilot: Stats` menu opens a read-only form populated from `sub:{sub_id}:stats:*` counters:

- **Investigations** — total count
- **Average calibrated confidence** — across all investigations
- **Average latency** — wall-clock per investigation
- **Total LLM cost** — sum across all Gemini calls
- **Degraded verdicts** — count where Reasoner failed twice
- **Recommendation mix** — REMOVE: N · APPROVE: M · ESCALATE: K · LOCK: L · NO_RECOMMENDATION: P
- **Tier mix** — FAST: N · STANDARD: M · DEEP: K
- **Alignment rate** — % of times mod action matched ModPilot's recommendation
- **Mod actions taken** — breakdown of what mods actually clicked

### 5.13 Subreddit Policy Configuration

The Configure policy form persists 4 fields to `sub:{sub_id}:profile`:

| Field | Type | Effect on next investigation |
|---|---|---|
| Moderation posture | select (strict/balanced/lenient) | Shifts Strategy Selector DEEP thresholds; injects personality phrasing into Reasoner prompt. |
| Subreddit rules | paragraph (≤4000 chars) | Injected verbatim into the Reasoner's "Active rules:" block. Feeds rule-match precheck. |
| Region / cultural context | string (≤80 chars) | Surfaces as `Region: <value>` in the Reasoner prompt. |
| Investigation depth override | select (auto/fast/standard/deep) | Forces a tier on every investigation; cold-start ignores FAST overrides. |

### 5.14 Deduplication

Reports often arrive in bursts (one comment reported by 5 users in 30 seconds). The dedup layer (`devvit-app/src/services/dedup.ts`):
- Mints a stable `correlation_id` per target using Redis `SET NX` on `pending_investigation:{target_id}` with a 10-min window.
- Increments `pending_count:{target_id}` per re-report so the verdict UI can annotate "Re-reported N times in M min".
- Stamps `pending_first_at:{target_id}` for the "in M min" math.

### 5.15 Resolved + Re-Reported Card States

When a mod opens the verdict on a target that's been:
- **Resolved** (already acted on): title flips to `✓ Resolved · {action} by u/{moderator}` and surfaces a resolution field.
- **Re-reported** (multiple reports within dedup window): surfaces a "Re-reported N times in M min" field at the top.

Both can coexist: a target removed, then re-reported by ban-evader → shows both.

### 5.16 Subreddit-Wide Memory Updates

`onModAction` trigger ([devvit-app/src/routes/triggers.ts](../devvit-app/src/routes/triggers.ts)):
- Records native Reddit mod actions (when a mod removes/approves via Reddit's UI, not ModPilot's).
- **Updates user_memory**: bumps `prior_violations` on remove/spam actions, `prior_approvals` on approve actions.
- **Skips self-references**: checks `post_correlation:{post_id}` and skips bumping if the targeted post is one of ModPilot's own verdict custom posts.
- **Resolution recording**: writes the resolution row so the next investigation on the same target shows the resolved state.

### 5.17 Schedulers

Two cron jobs registered in `devvit.json` (currently instrumented stubs):
- `priorityRollup` every 5 min — placeholder for queue prioritization.
- `feedbackBatch` daily at 04:00 — placeholder for nightly personality weight tuning.

### 5.18 Diagnostics & Observability

Every Reasoner call logs to the Devvit playtest terminal:

- `engine.profile_loaded` — what subreddit_id, rules, personality were loaded
- `engine.rule_match` — score, matched rule line, matched terms
- `reasoner.prompt.{system,user,assistant}` — full prompt content per role
- `reasoner.response` — recommendation, raw_confidence, cited_evidence_ids, rationale, tokens, cost, latency
- `reasoner.validation_failed` — when validator rejects, with reason
- `modpilot.menu.engine.verdict` — final calibrated verdict summary
- `modpilot.feedback.recorded` — mod action outcome, alignment, action_applied
- `modpilot.policy.updated` — policy save events
- `modpilot.user_memory.bumped` / `.skip_self` — memory writes on native mod actions
- `modpilot.install.*` — onboarding flow
- `modpilot.stats_bump_failed` — best-effort stats counter failures (logged but non-fatal)

---

## 6. Persistence Schema (Devvit Redis)

All keys are subreddit-scoped per invariant 7. Layout:

| Key pattern | Type | What it stores |
|---|---|---|
| `sub:{sub_id}:profile` | hash | personality, region, rules, cold_start_count, tier_override |
| `sub:{sub_id}:user:{user_id}` | hash | risk_tier, prior_violations, prior_approvals, last_seen_at |
| `sub:{sub_id}:thread:{thread_id}` | hash | arc, escalation_turn, instigator_candidates (JSON), off_topic, total_turns, mod_actions_taken |
| `sub:{sub_id}:author:{author_id}:invs` | sorted set | correlation_ids by completed_at score; powers prior_actions |
| `sub:{sub_id}:welcome_sent` | string | ISO timestamp; idempotency for onboarding |
| `sub:{sub_id}:stats:investigations_total` | counter | bumped per investigation |
| `sub:{sub_id}:stats:rec:{REC}` | counter | per-recommendation count |
| `sub:{sub_id}:stats:tier:{TIER}` | counter | per-tier count |
| `sub:{sub_id}:stats:cost_micros` | counter | cumulative cost in micro-dollars |
| `sub:{sub_id}:stats:confidence_sum_e4` | counter | confidence sum × 10000 (integer for incrBy) |
| `sub:{sub_id}:stats:latency_sum_ms` | counter | cumulative latency |
| `sub:{sub_id}:stats:feedback_{total,aligned}` | counter | alignment rate inputs |
| `sub:{sub_id}:stats:mod_action:{ACT}` | counter | what mods actually clicked |
| `inv:{correlation_id}` | hash | full verdict + target metadata + verdict_json |
| `verdict:{correlation_id}` | hash | webview-shaped projection (snake_case, JSON-encoded nested fields) |
| `post_correlation:{post_id}` | string | ModPilot custom post id → correlation_id mapping |
| `vel:{sub_id}:{target_id}` | sorted set | report event timestamps (score = epoch ms) |
| `thread_sum:{thread_id}` | string | JSON-encoded summarizer cache, 24h TTL |
| `pending_investigation:{target_id}` | string | dedup correlation_id, 10-min TTL |
| `pending_count:{target_id}` | counter | re-report count within dedup window |
| `pending_first_at:{target_id}` | string | first-report ISO timestamp |
| `trigger_ctx:{target_id}` | hash | cached report-trigger payload (authoritative numReports etc.) |
| `feedback:{correlation_id}` | hash | mod action record + alignment + applied status |
| `feedback:reddit-native:{target_id}` | hash | feedback from native Reddit actions (no correlation) |
| `resolution:{target_id}` | hash | resolved state for the "✓ Resolved by u/X" UI |

---

## 7. Verdict Wire Format

Returned by `/api/verdict`, consumed by the webview:

```ts
{
  correlation_id: string;
  target_id: string;
  target_kind: 'comment' | 'post';
  tier: 'FAST' | 'STANDARD' | 'DEEP';
  risk_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK' | 'NO_RECOMMENDATION';
  calibrated_confidence: number;          // 0..1
  rationale: string;                      // with inline [ev-N] citations
  top_evidence: { id, summary, tool }[];  // up to 3
  timeline: {
    tool, verb, status, latency_ms, evidence_ids
  }[];                                    // every tool that ran
  confidence_breakdown: {
    llm_self_report, evidence_convergence,
    subreddit_accuracy, rule_match_strength
  };
  model_reasoner: string;                 // e.g. 'gemini-2.5-pro'
  model_summarizer: string;
  cost_usd: number;
  latency_ms: number;
  validation_flag: boolean;               // true if Reasoner failed validation twice
  degraded: boolean;                      // true if running fallback verdict
  cold_start: boolean;
}
```

---

## 8. Operational Numbers (Measured)

- **Per-investigation latency**: 5-15s end-to-end. ~6s of that is the Gemini Reasoner call.
- **Per-investigation cost**: ~$0.003 at STANDARD tier with current Gemini pricing.
- **Storage**: ~10 KB per investigation in Redis (verdict + inv hashes + author index entry).
- **Validator catch rate**: ~1 in 3 first-attempt Reasoner outputs hit a citation issue; the corrective retry rescues ~95% of those.
- **Cold-start exit**: 10 investigations per subreddit (was 50; lowered for honest calibration on fresh subs).

---

## 9. What's Deferred

Documented in [Project Status.md](Project%20Status.md) §6 but called out here for completeness:

- Embedding-based `policy_match` (substring stand-in is live)
- Real `subreddit_accuracy` (currently hardcoded 0.5; needs feedback aggregation)
- Nightly feedback batch (scheduler stub only)
- Eval harness on the TS engine (Python harness covers algorithmic parity)
- Audit log table (Python schema has it; TS port doesn't write to it)
- `/feedback` and `/explain` engine HTTP endpoints (relevant only if engine ever runs externally again)
- `devvit publish` (still in playtest mode)
- Online learning / cross-subreddit federation / multi-language reasoning — all on the roadmap, all out of MVP scope.

---

## 10. Repository Layout

```
reddit_devvit/
├── devvit-app/                 ← demo path (live)
│   ├── devvit.json             ← menu items, forms, triggers, scheduler, http permissions
│   └── src/
│       ├── index.ts            ← Hono router mount
│       ├── routes/             ← menu, menuConfigure, menuStats, triggers, forms, api, scheduler
│       ├── engine/             ← in-process investigation engine
│       │   ├── types.ts
│       │   ├── strategy.ts
│       │   ├── accumulator.ts
│       │   ├── calibrator.ts
│       │   ├── personalities.ts
│       │   ├── loop.ts
│       │   ├── ruleMatch.ts
│       │   ├── pipeline.ts
│       │   ├── llm/            ← gemini, reasoner, summarizer, validator
│       │   ├── tools/          ← reportVelocity, userHistory, priorActions, threadContext
│       │   └── store/          ← keys, subreddit, userMemory, threadMemory,
│       │                         velocity, investigation, threadSummaryCache, stats
│       ├── services/           ← dedup; engineClient (retired but kept)
│       ├── config/             ← gitignored Gemini key holder
│       ├── client/             ← verdict webview (HTML + JS + CSS)
│       └── ui/                 ← copy strings, design tokens
├── engine/                     ← Python reference impl (off demo path)
│   ├── api/                    ← FastAPI app + /investigate endpoint
│   ├── orchestrator/           ← strategy, tools, loop, calibrator
│   ├── llm/                    ← gemini client, prompts, validator
│   ├── store/                  ← Postgres models + Redis helpers
│   ├── personalities/          ← presets
│   ├── memory/                 ← feedback ingest stubs
│   ├── alembic/                ← Postgres migrations
│   ├── Dockerfile              ← HF Spaces deploy target (dormant)
│   └── HF_DEPLOY.md            ← deploy guide
├── docs/                       ← product, architecture, ADRs, this overview
└── CLAUDE.md                   ← root system memory for Claude Code sessions
```

---

## 11. Key Documents

- [CLAUDE.md](../CLAUDE.md) — Root invariants, terminology, navigation map
- [docs/01-Product.md](01-Product.md) — Product canon (problem, thesis, personas, non-goals)
- [docs/02-Architecture.md](02-Architecture.md) — Architectural details
- [docs/04-InvestigationEngine.md](04-InvestigationEngine.md) — Engine internals
- [docs/06-AILayer.md](06-AILayer.md) — LLM contract, prompts, citation rules
- [docs/05-Memory.md](05-Memory.md) — Memory layer, personalities, cold-start
- [docs/09-UX.md](09-UX.md) — Verdict Card, Investigation Timeline, copy
- [docs/Glossary.md](Glossary.md) — Banned-words list, terminology table
- [ADR-0001](adr/0001-devvit-plus-external-backend.md) → [ADR-0007](adr/0007-engine-inside-devvit-after-hf-rejection.md) — Locked architectural decisions
- [docs/Project Status.md](Project%20Status.md) — Alignment scorecard + divergences

---

*Last updated: 2026-05-23*
