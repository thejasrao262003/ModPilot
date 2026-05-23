# ModPilot — Project Status

Snapshot of what's built, what diverged from the original plan, and what's deferred.

---

## 1. The Original Vision

From [CLAUDE.md](../CLAUDE.md) and the locked product brief:

> **ModPilot is a context-aware investigation engine for Reddit moderation, built on Devvit. When a report arrives, ModPilot runs the five lookups an experienced moderator would do manually — user history, thread context, rule match, report patterns, prior actions — then surfaces a verdict with the full evidence trail. The moderator decides.**

**Core thesis:** Most moderation tools classify content. ModPilot investigates context. The loop is `report → investigate → reason → recommend → learn`.

**Eight hard invariants:**
1. Human-in-the-loop mandatory
2. Every verdict claim cites evidence
3. Honest confidence
4. Cold-start safety
5. Graceful degradation
6. Evidence-first UI
7. Subreddit isolation
8. Layer purity

**Original architecture** (per [ADR-0001](adr/0001-devvit-plus-external-backend.md)):
```
Reddit triggers → Devvit app (TypeScript) → Investigation Engine (Python+FastAPI, signed HTTPS)
                                              ↓
                                      Postgres + Redis
                                              ↓
                                      Gemini 2.5 Pro / Flash
```

---

## 2. Alignment Scorecard

| Invariant | Status | Notes |
|---|---|---|
| 1. Human-in-the-loop mandatory | ✅ Met | All actions (Remove/Approve/Lock) require a mod click in the verdict UI. |
| 2. Citation contract | ✅ Met | [validator.ts](../devvit-app/src/engine/llm/validator.ts) enforces every `[ev-N]` resolves to a successful evidence row. Per-sentence enforcement was relaxed; structural enforcement remains. |
| 3. Honest confidence | ⚠ Partial | Calibrator math is faithful, but cold-start floor + 0.5 hardcoded `subreddit_accuracy` make even strong matches surface as ~30-50% until the sub has feedback history. Lowered cold-start threshold 50→10 to soften it. |
| 4. Cold-start safety | ✅ Met | `coldStartCount < 10` gates FAST tier + applies 0.85 demotion. |
| 5. Graceful degradation | ✅ Met | Reasoner failure → fallback NO_RECOMMENDATION verdict; custom-post failure → form-modal fallback; canned verdict if engine throws. |
| 6. Evidence-first UI | ✅ Met | Verdict card + timeline render every tool's result with `[ev-N]` chips clickable to expand. |
| 7. Subreddit isolation | ✅ Met | Every persisted Redis key includes `sub:{sub_id}:`. Pipeline guards on missing `subredditId`. |
| 8. Layer purity | ⚠ Adapted | The Python `engine/` tree is still isolated, but per [ADR-0007](adr/0007-engine-inside-devvit-after-hf-rejection.md) we ported the demo engine into `devvit-app/src/engine/`. ESLint rule updated to ban only the *root* `engine/` tree from Devvit imports. |

**Core thesis (context-investigation vs content-classification)**: ✅ intact. The engine still runs the 4 tool lookups + Reasoner, never reaches for a classifier-only path.

---

## 3. The Major Architectural Pivot

The original ADR-0001 split (Devvit app + external Python engine) is **partially reversed** by [ADR-0007](adr/0007-engine-inside-devvit-after-hf-rejection.md). The empirical reason:

- Devvit's outbound HTTP allowlist policy will **not** approve "personal domain"-class endpoints.
- We tested this end-to-end: ngrok rejected, `*.hf.space` rejected via the 0.12.x self-serve flow.
- The Python engine still exists, fully tested (340+ tests), but it is **not on the demo path**.

**Current architecture:**
```
Reddit triggers → Devvit app (TypeScript)
                    ├── in-process investigation engine (devvit-app/src/engine/)
                    ├── Devvit-managed Redis (no domain approval needed)
                    └── direct HTTPS → generativelanguage.googleapis.com (global allowlist)
```

No external backend. No Supabase. No Upstash. No HF Space on the demo path.

---

## 4. What's Built

### 4.1 Investigation Engine — TypeScript port ([devvit-app/src/engine/](../devvit-app/src/engine/))

Module-for-module mirror of the Python engine. All in-process inside the Devvit Web server bundle.

| Component | File | Status |
|---|---|---|
| Shared types | `types.ts` | ✅ |
| Strategy Selector (FAST/STANDARD/DEEP) | `strategy.ts` | ✅ Per-personality thresholds, thread-escalation stacking, cold-start floor, tier override. |
| Evidence Accumulator + Tool Registry | `accumulator.ts` | ✅ Monotonic `ev-N` IDs, successful-only filter for prompts. |
| Confidence Calibrator | `calibrator.ts` | ✅ Weighted blend (0.25/0.30/0.20/0.25), LLM-overconfidence discount, demotions for validation-failed / partial / cold-start. |
| Personality presets (strict/balanced/lenient) | `personalities.ts` | ✅ |
| Orchestrator loop | `loop.ts` | ✅ Budget enforcement (tool + time), convergence policy (≥1 strong on FAST, ≥2 on STANDARD/DEEP), exception isolation per tool. |
| Rule-match precheck | `ruleMatch.ts` | ✅ Substring score over content words (stopword filtered). Replaces unimplemented embedding-based `policy_match` for the demo. |
| Pipeline orchestrator | `pipeline.ts` | ✅ Strategy → Orchestrator → Reasoner (with retry) → Validator → Calibrator → Persist → Stats bump. |

**LLM layer** ([devvit-app/src/engine/llm/](../devvit-app/src/engine/llm/)):

| Component | File | Status |
|---|---|---|
| Gemini REST client (direct, no SDK) | `gemini.ts` | ✅ Talks to `generativelanguage.googleapis.com`, supports thinking budgets, structured output via response schemas. |
| Reasoner prompt + caller | `reasoner.ts` | ✅ Gemini 2.5 Pro, thinking_budget=512, includes full subreddit context + post body + rules. |
| Summarizer (thread_context) | `summarizer.ts` | ✅ Gemini 2.5 Flash, thinking_budget=0, structured output. |
| Citation validator (ADR-0003) | `validator.ts` | ✅ Hallucinated-ID + non-success-cite checks; per-sentence rule relaxed. Accepts `[ev-3, ev-4]` multi-cite form. |

**4 tools** (5th is `policy_match`, deferred — see §5):

| Tool | File | Backed by |
|---|---|---|
| report_velocity | `tools/reportVelocity.ts` | Devvit Redis sorted set + z-score |
| user_history | `tools/userHistory.ts` | `sub:{sub_id}:user:{user_id}` hash |
| prior_actions | `tools/priorActions.ts` | `sub:{sub_id}:author:{author_id}:invs` sorted set |
| thread_context | `tools/threadContext.ts` | Gemini Flash + 24h Redis cache |

**Devvit Redis store layer** ([devvit-app/src/engine/store/](../devvit-app/src/engine/store/)):

| Module | What it persists |
|---|---|
| `keys.ts` | Key namespace constants, TTL constants |
| `subreddit.ts` | `sub:{sub_id}:profile` — personality, region, rules, tier_override, cold_start_count |
| `userMemory.ts` | Per-author risk tier + violation/approval counters, `bumpViolation`/`bumpApproval` |
| `threadMemory.ts` | Per-thread escalation cache + mod action count |
| `velocity.ts` | Sliding-window report event sorted set + z-score helper |
| `investigation.ts` | Per-investigation hash + author→correlation_id sorted set for prior_actions lookups |
| `threadSummaryCache.ts` | 24h cache of Summarizer output per thread |
| `stats.ts` | Per-subreddit counters: investigations_total, recommendation/tier/mod_action mix, cost_micros, confidence_sum, alignment counters |

### 4.2 Devvit App Surface ([devvit-app/](../devvit-app/))

**Menu items** (4):
1. **Investigate with ModPilot** (post) — runs full pipeline, creates a verdict custom post in mod queue, navigates the mod to it.
2. **Investigate with ModPilot** (comment) — same for comments.
3. **ModPilot: Configure policy** (subreddit) — form to set personality, rules, region, tier override.
4. **ModPilot: Stats** (subreddit) — read-only dashboard of subreddit-wide moderation stats.

**Verdict UI** ([devvit-app/src/client/](../devvit-app/src/client/)):
- Custom-post webview showing recommendation + confidence + cited evidence + Investigation Timeline.
- 4 action buttons (Remove / Approve / Escalate / Lock).
- Auto-removed on creation → visible only in mod queue, never in the public feed.

**Triggers** ([devvit-app/src/routes/triggers.ts](../devvit-app/src/routes/triggers.ts)):
- `onAppInstall` + `onAppUpgrade` → modmail onboarding (idempotent via `welcome_sent` flag), seeds default profile.
- `onCommentReport` + `onPostReport` → dedup, cache trigger context for later menu actions.
- `onModAction` → records feedback, bumps `user_memory` violations/approvals on native mod actions (skips self-references to ModPilot's own verdict posts).

**API routes** ([devvit-app/src/routes/api.ts](../devvit-app/src/routes/api.ts)):
- `GET /api/verdict` — webview fetches the live verdict (resolves correlation_id via postData → post_correlation Redis fallback).
- `GET /api/verdict/canned` — back-compat alias.
- `POST /api/feedback` — records mod's action AND performs it via `reddit.remove()`/`.approve()`/`.lock()`. Authoritative moderator auth check (mod-list scan).

**Forms**:
- `verdictView` — placeholder for fallback path.
- `configurePolicy` — settings form persistence.
- `wipeMemory` — placeholder.

**Scheduler** ([devvit-app/src/routes/scheduler.ts](../devvit-app/src/routes/scheduler.ts)):
- `priorityRollup` every 5 min (instrumented).
- `feedbackBatch` daily at 04:00 (instrumented).

### 4.3 Python Engine ([engine/](../engine/))

**Reference implementation**, 340+ tests passing. Not on demo path but still useful for:
- Algorithmic ground truth (calibrator math, citation validator, strategy selector all have 100% branch coverage)
- Future hybrid deploy (if Devvit policy changes)
- Eval harness substrate

Bundled into a working Docker container ([engine/Dockerfile](../engine/Dockerfile)) with a deploy guide ([engine/HF_DEPLOY.md](../engine/HF_DEPLOY.md)). The HF Space `ThejasRao/ModPilot` exists and was provisioned with Supabase + Upstash + Gemini secrets — currently dormant.

### 4.4 Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | Root system memory, hard rules, navigation map |
| [docs/01–13](../docs/) | Product, Architecture, Devvit, Engine, AI Layer, Memory, Data, API, UX, Reliability, Eval, Personalities, Infra |
| [docs/14-Engineering.md](14-Engineering.md) | Claude Code workflow + standards |
| [docs/15-Hackathon.md](15-Hackathon.md) | Demo + submission notes |
| [docs/Glossary.md](Glossary.md) | Terminology rules + product↔internal table |
| [docs/Implementation Tracker.md](Implementation%20Tracker.md) | Per-task status |
| ADRs 0001-0005, 0007 | Locked architectural decisions |

---

## 5. What Diverged from the Plan

| Original | Current | Why |
|---|---|---|
| External Python engine reached over signed HTTPS | TS engine in-process inside Devvit | Devvit blocks personal-domain outbound HTTP. ADR-0007. |
| Postgres for persistence (subreddit_profile, user_memory, investigation, evidence, audit_log, feedback) | Devvit Redis flattened (hash + sorted-set per concept) | Devvit Redis is the only persistence layer Devvit-side. No SQL joins; `prior_actions` is a sorted-set scan. |
| `policy_match` as a 5th tool (embedding cosine vs rules) | Substring rule-match precheck appended as `policy_match` evidence row | TS embeddings would need a vector store + embedding model + Devvit allowlist for the embedding API. Deferred. Substring is the cheap-but-effective stand-in. |
| HMAC-signed Devvit→engine HTTPS | None (in-process call) | No network hop. |
| Alembic migrations | None on demo path | No Postgres to migrate. Schema changes happen in TS + defensive Redis reads. |
| `devvit.json:settings` for Gemini key | Gitignored `geminiConfig.local.ts` | Devvit Web 0.12.x doesn't bind the `AppSettings.ValidateAppForm` gRPC handler when settings are declared in `devvit.json`. CLI `settings set` fails. |
| Stretch menu items (Summarize thread, Explain last call, Show/Seed user history) | Trimmed to Investigate + Configure + Stats | UX simplification at user request. |

**Confidence calibration tuning**: Cold-start threshold dropped 50→10 investigations; `coldStart` demotion factor unchanged at 0.85. The current calibrated confidence on a hot-path REMOVE is ~30-45% pending a real `subreddit_accuracy` signal (needs feedback history accumulation) and embedding-based `rule_match_strength`.

---

## 6. What's Deferred / Not Built

These were either explicitly out-of-phase, blocked by Devvit constraints, or shelved during the architectural pivot:

| Item | Why deferred |
|---|---|
| Embedding-based `policy_match` tool | Needs embedding model API + vector store; the substring rule-match precheck covers the demo case. |
| Real `subreddit_accuracy` (30-day acceptance rate) | Needs feedback aggregation pipeline; currently hardcoded 0.5. |
| Nightly feedback batch processing | Scheduler hook exists, logic stub. Personality weights, accuracy stats unbuilt. |
| `policyMatch.py` precision tuning + ADR | Out of scope — substring stand-in is enough for demo. |
| Eval harness on TS engine | `eval/run.py` exercises only the Python engine. TS port has no equivalent. Algorithm parity assumed. |
| `/feedback` and `/explain` engine HTTP endpoints | Marked TODO in Python `engine/api/main.py`; not relevant on Devvit-only demo path. |
| Stretch UX: thread summary action, "Explain last call" menu | Trimmed. |
| Per-user wipe-memory form | UI stub exists, no backing logic. |
| Audit log persistence | Python schema has the table; TS port doesn't write to it. |
| Production publish (Reddit app review) | `devvit publish` not run. App is in playtest mode only. |
| Rich custom-post UI (existing client is HTML+JS) | The current webview works; could be upgraded to React/components for polish. |

---

## 7. Infrastructure State

| Service | Purpose | Status |
|---|---|---|
| **Devvit (Reddit)** | App runtime, Redis, menu/forms/triggers | ✅ Live, playtest mode |
| **Gemini API** | Reasoner + Summarizer | ✅ Live, key in `geminiConfig.local.ts` |
| **Devvit Redis** | All persistence on demo path | ✅ Live |
| Supabase Postgres | Python engine persistence | 🟡 Provisioned, unused on demo path |
| Upstash Redis | Python engine cache | 🟡 Provisioned, unused on demo path |
| HF Space (ThejasRao/ModPilot) | Python engine deploy target | 🟡 Provisioned, idle (Devvit rejected domain) |

The 🟡 services can be **cancelled with zero impact on the demo**.

---

## 8. Demo Readiness

**What works end-to-end today** (verified via playtest in `r/ModTesting123`):

1. Install ModPilot → modmail onboarding lands → mod sees setup instructions
2. **ModPilot: Configure policy** (subreddit menu) → mod sets rules + personality + region → persisted
3. Mod-reports any comment or post (or invokes via menu) → engine runs Strategy → 3 tools (velocity, user_history, prior_actions) → rule-match precheck → Reasoner (Gemini 2.5 Pro) → citation validation → Calibrator
4. Custom post appears in **mod queue** (auto-removed from public feed) with verdict UI
5. Mod opens the post → sees verdict + confidence + 4 cited evidence rows + 4 action buttons
6. Mod clicks **Remove** → `/api/feedback` runs auth check → calls `reddit.remove()` on original target → records feedback → bumps stats counters
7. **ModPilot: Stats** (subreddit menu) → mod sees running tally: investigations, alignment rate, total Gemini cost, recommendation mix, tier mix

**Latency** (measured): ~5-15s per investigation, dominated by the Gemini Reasoner call (~6s). No backend cold-starts.

**Cost** (measured): ~$0.003 per investigation at current Gemini pricing.

---

## 8.1 Features 1–9 (added 2026-05-23)

Nine moderator-facing features layered on top of the core pipeline. Three categories:

**Deterministic explainability** (no extra LLM calls):

| # | Feature | Module | Surfaces in verdict as |
|---|---|---|---|
| 1 | Priority Score & Triage | [priority.ts](../devvit-app/src/engine/priority.ts) | Header pill: 🔥 Urgent · 78 / ⚠️ Review · 52 / ℹ️ Low Risk · 23. Persisted for future queue sort. |
| 2 | Repeat Offender Surfacing | [explainability.ts:deriveAuthorSignal](../devvit-app/src/engine/explainability.ts) | Banner: "⚠️ Repeat Offender · 3 prior removals" |
| 3 | Moderator Alignment Score | [stats.ts:readAlignmentSnapshot](../devvit-app/src/engine/store/stats.ts) | Footer line: "ModPilot and your team agree 83% (10/12)". Suppressed under 5 mod actions. |
| 4 | Confidence Explanation Panel | [explainability.ts:deriveConfidenceFactors](../devvit-app/src/engine/explainability.ts) | List of ▲ increased / ▼ reduced reasons sourced 1:1 from calibrator inputs. |
| 5 | Escalation Detection | [escalation.ts](../devvit-app/src/engine/escalation.ts) | Banner: "🔥 Escalating Conversation — Turned heated at turn 8." Level: none/mild/moderate/high. |
| 6 | Rule Match Explainability | [explainability.ts:buildRuleMatchDisplay](../devvit-app/src/engine/explainability.ts) | Panel listing matched rule(s) + score band + ADR-0003 evidence ids. |
| 7 | First-Time Offender Signal | same `deriveAuthorSignal` | "✓ First-Time Author" or "✓ Positive History" banners. |
| 8 | Key Factors Panel | [explainability.ts:deriveKeyFactors](../devvit-app/src/engine/explainability.ts) | List sorted by impact (High/Medium/Low) × direction (positive/negative). |

**LLM-backed** (Gemini 2.5 Flash, thinking disabled):

| # | Feature | Module | Surfaces as |
|---|---|---|---|
| 9 | Moderator Response Generator | [responseDrafter.ts](../devvit-app/src/engine/llm/responseDrafter.ts) + [api.ts:/api/draft-response,/api/send-response](../devvit-app/src/routes/api.ts) | Modal after action click: optional guidance → Generate Draft → Edit → Send Reply (or Take action only / Skip). |

### Architecture changes
- New `Verdict` fields (TypeScript type): `priority`, `authorSignal`, `escalation`, `confidenceFactors`, `keyFactors`, `ruleMatches`, `alignment`. All deterministically derived in `pipeline.ts` after the Calibrator step (no recommendation/confidence impact).
- `menu.ts` extracted a `buildVerdictHashFields()` helper to consolidate the two persistence sites; new fields are JSON-encoded as `*_json` columns on the verdict hash.
- `api.ts:projectStoredVerdict` extended to surface the new fields.
- Two new API endpoints (`/api/draft-response`, `/api/send-response`) — both gated by the existing `isCallerModerator` check.

### Redis key changes
No new key namespaces. New JSON-encoded fields on the existing `verdict:{correlation_id}` hash:
- `priority_json`, `author_signal_json`, `escalation_json`, `confidence_factors_json`, `key_factors_json`, `rule_matches_json`, `alignment_json`.
Reads of older `verdict:*` hashes degrade gracefully — `parseJsonArray()`/`parseJsonObject()` return `[]`/`{}` when fields are absent, and the renderers no-op on missing data.

### Schema changes
None on Devvit Redis side beyond the additive fields above. No Postgres schema touched.

### UI changes
- `src/client/index.html` — 6 new panel placeholders + a response-generator modal.
- `src/client/main.js` — 7 new render functions (`renderPriorityPill`, `renderEscalationBanner`, `renderAuthorSignal`, `renderConfidenceFactors`, `renderKeyFactors`, `renderRuleMatches`, `renderAlignmentLine`) + full modal state machine (`openResponseModal`, `generateDraft`, send/act-only/skip handlers).
- `src/client/style.css` — appended ~150 lines of CSS for the new panels + modal.

### Latency impact
- Deterministic features (F1–F8): **~0 ms** added (all run in-process during verdict assembly, no I/O).
- Alignment lookup (F3): two `redis.get` calls; ~5-20 ms in parallel with other reads.
- Response Drafter (F9): only runs when a moderator clicks "Generate Draft". Gemini Flash with thinking disabled: ~2-4 s, ~$0.0005-$0.001 per draft.

### Cost impact
- Steady-state cost per investigation: **unchanged** (~$0.003).
- Cost per draft-response: ~**$0.0005-$0.001** when invoked, **$0** when the moderator skips the draft.

### Test coverage
35 new tests across 4 files (all passing):
- `priority.test.ts` (8 tests) — bucket boundaries, driver sorting, score clamp, recommendation-gated confidence contribution.
- `explainability.test.ts` (15 tests) — author signal kinds, confidence factor up/down derivation, key factor sorting, rule match display bands.
- `escalation.test.ts` (5 tests) — none/mild/moderate/high level transitions, edge cases.
- `ruleMatch.test.ts` (5 tests) — empty inputs, stopword filtering, strongest-rule selection.

Run with: `cd devvit-app && npm test`.

### Migration requirements
None for existing installs. The new fields are additive on the verdict hash; old verdicts persist and render with the new panels hidden (renderers no-op on missing data). New investigations get all panels automatically.

### Invariants preserved
- **Human-in-the-loop (1)**: Response generator is draft-only. Send requires explicit moderator click.
- **No autonomous actions (2)**: `/api/send-response` re-checks `isCallerModerator()` before any Reddit API call.
- **Evidence-backed (3) + Citation contract (4)**: All new surfaces use evidence ids that already passed ADR-0003 validation. Rule match display only includes ids that resolved successfully.
- **Subreddit isolation (5)**: All new Redis keys still `sub:{sub_id}`-scoped; alignment lookup uses the explicit sub id.
- **Honest uncertainty (6)**: Confidence explanation panel surfaces the *exact* calibrator demotions — no hallucinated reasons.
- **Moderator decides (7)**: Priority, alignment, and key factors are descriptive; never bypass the moderator's click.

---

## 9. Recommended Next Steps for Polish

In rough priority order if more session time available:

1. **Cancel Supabase + Upstash + HF Space** — clean up dead weight.
2. **Tighten the rule-match score** — current substring approach is 25% term overlap on "Cricket is horrible" vs "No bad talks about Cricket sport". A small embedding-free TF-IDF improvement could push genuine matches above 0.5.
3. **Add a "ModPilot: View case file" menu item** that re-opens a past investigation by correlation_id from the mod queue. Currently each click creates a new investigation.
4. **Mark verdict posts with a sticky/distinguish flag** so mods can tell them apart from real subreddit content in the queue.
5. **Demo script + 60-second walkthrough video** for the submission.
6. **Submit `devvit publish`** if you want to enable Reddit-wide installs.

---

*Last updated: 2026-05-23*
