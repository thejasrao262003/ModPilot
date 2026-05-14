# Implementation Tracker

> **Single source of truth for build progress.** Tasks organized by phase. Status emojis: ☐ todo · ◐ in-progress · ✅ done · ⏸ blocked · ⊘ deferred. Each task references the area doc that defines its contract.
>
> **Status legend:** Phases are sequential by default but tasks within a phase parallelize where deps allow. Don't start a phase until all blocking tasks in the previous one are ✅ or ⊘.
>
> **Last updated:** 2026-05-13 (Day 2).

---

## At-a-Glance

| Phase | Window | Goal | Status |
|---|---|---|---|
| 0 — Foundation | Days 1–2 | Docs locked, scaffolds, secrets, CI shell | ✅ (all 10 tasks) |
| 1 — End-to-end stub | Days 3–4 | Trigger → stub Engine → fake Verdict Card | ◐ (S-1.1, S-1.3, S-1.4, S-1.5, S-1.6 ✅) |
| 2 — Real Engine MVP | Days 5–7 | 2 tools + Reasoner + Calibrator, real verdicts | ◐ (E-2.1, E-2.2, E-2.5, E-2.6, E-2.7 ✅) |
| 3 — Full investigation | Days 8–10 | All 5 tools + memory + cold-start + personalities | ☐ |
| 4 — Surfaces & polish | Days 11–12 | Dashboard, wizard, menu actions, error states | ☐ |
| 5 — Eval & demo | Days 13–14 | Eval harness wired, demo script, submission | ☐ |

**Current focus:** Phase 1 nearly closed. S-1.1, S-1.3, S-1.4, S-1.5, S-1.6 ✅ — full Devvit-side loop works: report fires → dedup → correlation_id minted → trigger context cached → menu modal renders verdict with the same correlation_id → button click records feedback. Remaining: S-1.2 (Devvit → Engine HTTP — needs tunnel) and S-1.7 (demo script).

---

## Phase 0 — Foundation (Days 1–2)

Goal: Everything green-field needed *before* writing investigation logic.

### F-0.1 — Lock the 10 blocking docs ✅
- **Spec:** [CLAUDE.md](../CLAUDE.md) Current Phase
- **Acceptance:** [01-Product.md](01-Product.md), [02-Architecture.md](02-Architecture.md), [03-Devvit.md](03-Devvit.md), [04-InvestigationEngine.md](04-InvestigationEngine.md), [05-Memory.md](05-Memory.md), [06-AILayer.md](06-AILayer.md), [07-DataLayer.md](07-DataLayer.md), [09-UX.md](09-UX.md), root [CLAUDE.md](../CLAUDE.md), foundational ADRs — all marked stable.
- **Done 2026-05-13:** All 15 area docs present and stable. 5 ADRs landed (0001 devvit+backend split, 0002 no online RL, 0003 evidence citation, 0004 HITL mandatory, 0005 Devvit Web not Blocks). `docs/Glossary.md` covers terminology authority. `docs/Specs.md` provides one-page-above spec. **Doc-sync debt acknowledged:** 03-Devvit, Specs §6, 09-UX §1.5 still reference Devvit Blocks in places — sweep happens progressively per ADR-0005 / [14-Engineering.md §7.8](14-Engineering.md).

### F-0.2 — Scaffold `docs/Glossary.md` + `docs/adr/` ✅
- **Spec:** [CLAUDE.md](../CLAUDE.md) Repo Reality Check
- **Acceptance:** `docs/Glossary.md` exists with terminology table from [Specs.md §3](Specs.md). `docs/adr/` contains the four starter ADRs (`0001-devvit-plus-external-backend.md`, `0002-no-online-rl.md`, `0003-evidence-citation-required.md`, `0004-human-in-the-loop-mandatory.md`).
- **Deps:** None.
- **Done 2026-05-12:** [Glossary.md](Glossary.md) landed with banned/preferred terms, translation table, risk-tier + recommendation enums, tool verb map, and doc-sync rule. All four starter ADRs in [adr/](adr/).

### F-0.3 — Repo scaffold ✅
- **Spec:** [02-Architecture.md §7](02-Architecture.md), [Specs.md §4.2](Specs.md)
- **Acceptance:** Empty but importable `devvit-app/`, `engine/`, `eval/`, `scripts/` trees with package manifests (`package.json`, `pyproject.toml`). Layer-purity lint configured.
- **Deps:** None.
- **Done 2026-05-12:** `git init` on main. Directory tree + manifests landed. `uv sync --extra dev` resolves cleanly; `ruff check` and `mypy --strict api/main.py` both pass; `TestClient` confirms `/health` returns the expected payload with `gemini-2.5-pro` / `gemini-2.5-flash` identifiers. Layer-purity rules in `engine/ruff.toml` and `devvit-app/.eslintrc.cjs`.

### F-0.4 — Devvit app skeleton ✅
- **Spec:** [03-Devvit.md](03-Devvit.md), [adr/0005-devvit-web-not-blocks.md](adr/0005-devvit-web-not-blocks.md)
- **Acceptance (revised):** `cd devvit-app && npm run build` succeeds. `devvit.json` declares ModPilot's triggers/menu/scheduler. Empty handler stubs in `src/routes/`.
- **Deps:** F-0.3.
- **Done 2026-05-13:** `npm create devvit@latest` redeemed Reddit auth token; scaffolded Devvit Web (Hono + Vite). `devvit.json` updated with 5 triggers (`onAppInstall/Upgrade/CommentReport/PostReport/ModAction`), 4 menu items per [09-UX.md §9](09-UX.md), 2 scheduler tasks (priority-rollup every 5min, feedback-batch nightly), and redis + http permissions. Stub handlers in `src/routes/triggers.ts`, `routes/menu.ts`, `routes/forms.ts`, `routes/scheduler.ts`. Layer-purity rules added to `eslint.config.js`. `npm run type-check` + `npm run lint` + `npm run build` all clean. Architecture shift captured in ADR-0005.
- **Live validation 2026-05-13 (r/ModPilotDev, playtest v0.0.1.8):** end-to-end deploy via `devvit playtest ModPilotDev` succeeded. Captured real payloads for:
  - `onAppInstall` — `{ subreddit: { name: 'ModPilotDev' } }`
  - `onModAction` — 5 distinct action types (`spamlink`, `addremovalreason`, `sticky` (cascades into `LOCK_COMMENT`+`DISTINGUISH_COMMENT`), `approvelink`, `dev_platform_app_*`). Full payload includes `targetUser`, `targetComment`, `targetPost`, `moderator`, `subreddit` — everything the Reasoner needs for the `prior_actions` tool.
  - `onPostReport` — `{ post: { id, title, selftext, authorId, numReports, subredditId, ... }, subreddit, reason, type: 'PostReport' }`. `numReports` is pre-aggregated by the platform — no extra API call needed.
  - `reddit.getUserById` + `getPostsByUser` + `getCommentsByUser` working end-to-end. Pulled u/trendy_guy2003 (`t2_ewyhkkhu`): 4.6-year-old account, karma=1, 2 near-duplicate posts in 4 min, zero comments — textbook sleeper-burner pattern. Validates the `user_history` tool's payload shape (see I-3.1 below).
  - **Gotcha logged:** `reddit.getPostById().numberOfReports` returns **-1** from a menu-action context (no elevated mod scope). Authoritative `numReports` only available from the trigger payload itself. Inlined comment in `menu.ts:investigate-post` + future S-1.1 must cache trigger-payload values in Redis rather than re-fetching.
  - **Bug fixed mid-validation:** scheduler tasks were declared in `devvit.json` but routes weren't registered — caught immediately by `404 /internal/scheduler/priority-rollup` in the cron log; fixed by adding `src/routes/scheduler.ts` + wiring in `src/index.ts`.

### F-0.5 — Engine FastAPI skeleton ✅
- **Spec:** [Specs.md §10](Specs.md), [13-Infra.md](13-Infra.md)
- **Acceptance:** `uv run uvicorn api.main:app --reload` returns 200 on `/health` with `{"ok": true, "data": {"engine": "0.0.1", ...}}`. HMAC middleware in place but permissive in dev.
- **Deps:** F-0.3.
- **Done 2026-05-13:** `api/config.py` (pydantic-settings), `api/errors.py` (envelope + 7 error codes per Specs §10.3), `api/middleware.py` (CorrelationId + HMAC-SHA256 with 5-minute skew window, permissive in dev), `observability/logging.py` (structlog, JSON in prod, console in dev). 9 tests cover health, correlation-id roundtrip, HMAC permissive/strict/skew, error envelope. `ruff check` clean, `mypy --strict` clean.

### F-0.6 — Local services via docker-compose ✅
- **Spec:** [13-Infra.md](13-Infra.md)
- **Acceptance:** `make services-up` starts Postgres + Redis. Engine connects on boot and logs `db.connected` + `redis.connected`.
- **Deps:** F-0.5.
- **Done 2026-05-13:** Root `docker-compose.yml` brings up `modpilot-postgres` (postgres:16-alpine, healthcheck via `pg_isready`) and `modpilot-redis` (redis:7-alpine with AOF + LRU eviction). `make services-up` polls compose-ps until both containers report healthy. `engine/store/connections.py` opens an async SQLAlchemy + asyncpg engine + an `aioredis` client; the FastAPI lifespan probes both at boot and logs `db.connected driver=asyncpg server='PostgreSQL 16.13'` and `redis.connected pong=True url=redis://localhost:6379/0`. Failure during open aborts startup (fail-closed per [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)). `ruff` + `mypy --strict` + 9 tests all clean.

### F-0.7 — Secrets & env wired ✅
- **Spec:** [13-Infra.md](13-Infra.md), [CLAUDE.md](../CLAUDE.md) Commands section
- **Acceptance:** `.env.example` checked in with `GEMINI_API_KEY`, `MODEL_REASONER=gemini-2.5-pro`, `MODEL_SUMMARIZER=gemini-2.5-flash`, DB urls. Engine refuses to start if `GEMINI_API_KEY` is missing.
- **Deps:** F-0.5.
- **Done 2026-05-13:** `Settings.validate_for_runtime()` enforces secret presence at lifespan startup: in `env=production` or `env=staging`, missing `GEMINI_API_KEY` raises `RuntimeError` and aborts boot; missing `ENGINE_SHARED_SECRET` same. In `env=development` the check is deferred to first LLM call so unit tests + `/health` probes still work. Lifespan now logs `gemini_configured=<bool>` alongside startup info.

### F-0.8 — Gemini client smoke test ✅
- **Spec:** [06-AILayer.md §3.2](06-AILayer.md), [Specs.md §8](Specs.md)
- **Acceptance:** `engine/llm/gemini.py` implements `LLMClient`. A pytest hits Gemini 2.5 Flash with a fixed prompt and asserts a non-empty response within 3s. Skipped in CI by default; enabled with env flag.
- **Deps:** F-0.7.
- **Done 2026-05-13:** `engine/llm/client.py` defines the `LLMClient` Protocol per [Specs.md §8.2](Specs.md) with `Role` (`StrEnum`), `Message`, `LLMResponse`. `engine/llm/gemini.py` implements it on `google-genai`'s async API, with per-model price table (Pro $1.25/$10 per 1M; Flash $0.075/$0.30 per 1M), token-count + latency + cost on every response, structured logs (`llm.call.started`/`.succeeded`/`.timeout`), and an optional `thinking_budget` parameter for fine-grained control. Live tests gated on `ENABLE_LIVE_LLM_TESTS=true` — both Flash (thinking_budget=0, "What color is the sky?" → "Blue") and Pro (thinking_budget=128, "Reply with: pong" → contains "pong") pass against the real API in ~5s combined.
- **Production insight surfaced live:** `gemini-2.5-pro` is **thinking-only** — `thinking_budget=0` returns HTTP 400. Reasoner calls must allocate budget for thinking + output (~256+ recommended). `gemini-2.5-flash` allows disabling thinking and we should default Flash summarizer calls to `thinking_budget=0`. Captured in module docstring of `gemini.py`.

### F-0.9 — CI gates ✅
- **Spec:** [14-Engineering.md §6](14-Engineering.md)
- **Acceptance:** GitHub Actions runs `ruff`, `mypy --strict`, `eslint`, `tsc --noEmit`, `pytest`, `jest` on PR. Total <5 min on a no-op PR.
- **Deps:** F-0.3.
- **Done 2026-05-13:** `.github/workflows/ci.yml` with three parallel jobs: **engine** (ruff + mypy --strict + pytest), **devvit** (eslint + tsc --build + vite build — Reddit's scaffold uses vitest not jest; tests are pending so `npm test` is excluded for now), **enforce** (banned-terminology + no-inline-hex shell checks). All three run on every push to main and every PR. `concurrency` cancels in-progress runs on new pushes. Local parity via `make check`. Pytest auto-skips `llm/test_gemini.py::*` when `ENABLE_LIVE_LLM_TESTS` is unset, so CI doesn't need a Gemini key.

### F-0.10 — Design tokens + copy module ✅
- **Spec:** [09-UX.md §2 + §15.8-9](09-UX.md)
- **Acceptance:** `devvit-app/src/ui/tokens.ts` ports values from [`mockups/moderator-ui.html`](../mockups/moderator-ui.html) + canonical risk hexes. `ui/copy.ts` has the 5 copy patterns from [09-UX.md §4.7](09-UX.md) and the "I'm unsure" string from §6.3. Lint blocks inline color/string literals in components.
- **Deps:** F-0.4.
- **Done 2026-05-13:** `devvit-app/src/ui/tokens.ts` exports `color` (canonical riskHigh/Medium/Low + muted variants + paper/ink/surface palette from the mockup), `spacing`, `radius`, `font`, `fontSize`, `letterSpacing` as `as const` namespaces with derived types. `devvit-app/src/ui/copy.ts` exports every user-facing string grouped by concern: `recommendation` (the 5 phrasings from §4.7), `uncertainty.badge`/`marginalia` (§6.3), `action`/`confirm`/`toast` (§10.1), `toolVerb` (§5.4 — full enum-mapped), `confidenceLabel`/`confidenceTier`, `coldStart`/`empty`/`error`/`cardState`/`timelineExit` (§§11, 12, 4.6, 5.5), `dashboard` (§8), `menu` (§9). **Enforcement:** `scripts/check-no-inline-hex.sh` (CI job) blocks `#hex` outside `ui/tokens.ts`; `scripts/check-banned-terms.sh` blocks Glossary §1 banned terms across `devvit-app/src/` and `engine/llm/prompts/`. Both pass on current code.

---

## Phase 1 — End-to-end stub (Days 3–4)

Goal: A `CommentReport` produces a (fake) Verdict Card visible to the mod. No real intelligence yet — just the full wire.

### S-1.1 — `CommentReport` trigger wired ✅
- **Spec:** [03-Devvit.md](03-Devvit.md), [Specs.md §6.1](Specs.md)
- **Acceptance:** Trigger fires in test subreddit; logs `correlation_id`; dedupes within 10 min via `pending_investigation:{comment_id}` key in Devvit KV.
- **Deps:** F-0.4.
- **Done 2026-05-13:** New `src/services/dedup.ts` exposes `dedupForTarget(targetId)` — atomic SET-with-NX on `pending_investigation:{target_id}` (10-min TTL); duplicates within the window return the existing `correlation_id` so the engine call stays idempotent. Also exposes `cacheTriggerContext()` which hSets `trigger_ctx:{target_id}` with `correlation_id`, `subreddit_id`, `subreddit_name`, `author_id`, **`num_reports`** (authoritative from the trigger payload, fixes the menu-action `numberOfReports === -1` gotcha), `reason`, `received_at` (24h TTL). Both `on-comment-report` and `on-post-report` now: pull the target id → dedup → cache context → log `accepted` with correlation_id (or `deduped` if within window) → TODO(S-1.2) for the engine call. Menu actions `investigate-{post,comment}` read from the cached context first, so a moderator who opens "Investigate" on a target that was just reported gets the *same* correlation_id and authoritative report count as the report-triggered investigation. Verified via type-check + lint + build clean.

### S-1.2 — Devvit → Engine client ☐
- **Spec:** [Specs.md §10](Specs.md), [03-Devvit.md](03-Devvit.md)
- **Acceptance:** `services/engineClient.ts` signs requests with HMAC, posts to `/investigate`, parses response. Handles 5xx with one retry + graceful degradation.
- **Deps:** F-0.5, S-1.1.

### S-1.3 — Stub `/investigate` returns canned verdict ✅
- **Spec:** [Specs.md §10.2](Specs.md)
- **Acceptance:** Endpoint returns a HIGH-conf REMOVE verdict matching the response schema, with 4 timeline rows + 3 top evidence + confidence breakdown. Validates against Pydantic.
- **Deps:** F-0.5.
- **Done 2026-05-13:** `engine/api/schemas.py` defines the full Pydantic v2 contract for `/investigate`: `InvestigateRequest` (correlation_id, subreddit_id with `^t5_` regex, target {kind: comment|post, id, body, author}, report {reasons, reporter_count, first_at, last_at}, context), `Verdict` (tier, risk_tier, recommendation, calibrated_confidence, rationale with `[ev-N]` citations, top_evidence ≤3, timeline, confidence_breakdown, model + cost + flags), `InvestigateResponse` envelope. `engine/api/canned.py` returns a HIGH-conf REMOVE verdict mirroring the mockup data — so S-1.4 (Verdict Card) and S-1.5 (Timeline) render the same data the UI was designed against. 8 new tests in `api/test_investigate.py` cover: schema validation (malformed subreddit_id → BAD_REQUEST envelope, missing correlation_id, negative reporter_count), happy-path canned verdict shape (3 evidence rows, 4 timeline steps, confidence breakdown in [0,1], every cited `[ev-N]` resolves to top_evidence), and both target kinds (comment + post). ruff + mypy --strict + 17 tests all green.

### S-1.4 — VerdictCard MVP component ✅ (with caveat)
- **Spec:** [09-UX.md §4](09-UX.md), [mockup](../mockups/moderator-ui.html)
- **Acceptance:** Renders header row + 3 evidence rows + 4 action buttons + expansion handle. HIGH-confidence variant filled, MEDIUM outline. Matches mockup visually within Devvit Blocks constraints.
- **Deps:** F-0.10, S-1.3.
- **Done 2026-05-13:** Full HTML/CSS rich card built in `devvit-app/src/client/` (`index.html` + `style.css` + `main.js`). Forensic-dossier palette, paper-grain SVG, animated confidence spectrum, evidence chips with hover-link across card + timeline, primary-action gating per invariant I-3, LOW-conf marginalia per docs/09-UX.md §6.3. Build emits `dist/client/{index.html, default.js, default.css}`.
- **Live-demo pivot:** `reddit.submitCustomPost` creates the post successfully, but Reddit's runtime fails at `RenderPostContent INTERNAL: useWebView fullscreen request failed; web view asset could not be found` — a Devvit-side asset-resolution issue specific to playtest mode (asset bundle isn't being served at the URL the web view loader requests). Custom-post path re-engages at **V-5.5 (production deploy)** when `devvit upload` publishes the asset bundle through normal channels instead of playtest streaming.
- **Today's demo path:** menu action persists the canned verdict in Redis under `verdict:{correlation_id}` and returns `showForm` with the verdict summary inline — recommendation pill, target row, 3 evidence rows, full rationale, model + cost in helpText. Same data as the rich UI, in the Reddit-blessed form modal. The mockup at [`mockups/moderator-ui.html`](../mockups/moderator-ui.html) remains the visual reference for V-5.5.

### S-1.5 — InvestigationTimeline MVP component ✅ (built; rich render gated on V-5.5)
- **Spec:** [09-UX.md §5](09-UX.md), [mockup](../mockups/moderator-ui.html)
- **Acceptance:** Renders tool rows with verb (from copy.ts map), latency, evidence chips. Verdict block with rationale + model + cost + confidence breakdown.
- **Deps:** F-0.10, S-1.3.
- **Done 2026-05-13:** Bundled with S-1.4 in `src/client/`. Timeline renders one row per tool with status glyph, past-tense verb, tabular-num latency, clickable `ev·N` chips. Sticky Verdict Block with rationale (inline citation chips), model + tokens + cost, calibrated confidence + 4-bullet breakdown as horizontal bars. Same custom-post asset-resolution caveat as S-1.4 — rich timeline view ships at V-5.5; rationale text surfaces in today's form-modal path.

### S-1.6 — `ModAction` trigger → feedback record ✅
- **Spec:** [03-Devvit.md](03-Devvit.md), [Specs.md §9.1](Specs.md)
- **Acceptance:** When mod clicks Remove/Approve/Escalate, trigger captures alignment and POSTs to `/feedback`. Engine stub logs the event.
- **Deps:** S-1.4.
- **Done 2026-05-13:** Two paths recorded into Devvit Redis under `feedback:*` keys (7d retention):
  1. **Verdict Card buttons** — `src/client/main.js#onAction` POSTs `{ correlation_id, mod_action, recommendation, source: 'verdict_card' }` to `/api/feedback`. The server records the alignment (`aligned = mod_action === recommendation`) and surfaces it back to the UI: action buttons disable while the request is in flight, then a status chip shows "aligned with ModPilot ✓" or "overrode ModPilot's *recommendation*". Failure path re-enables the buttons and shows the error.
  2. **Reddit-native mod actions** — `src/routes/triggers.ts#on-mod-action` maps Reddit's `removelink`/`removecomment`/`spamlink`/`spamcomment`/`approve*`/`lock` strings to our 4-action enum and writes to `feedback:reddit-native:{target_id}`. Engine aggregation joins on `target_id` at calibration time.
  - Engine-side `/feedback` proxy lands in S-1.2 alongside the tunnel; until then both paths persist locally in Devvit KV.

### S-1.7 — End-to-end demo ☐
- **Spec:** none new
- **Acceptance:** Live walkthrough: file a report in test subreddit → Verdict Card appears → click Remove → Reddit removes the comment → feedback logged.
- **Deps:** S-1.1–S-1.6.

---

## Phase 2 — Real Engine MVP (Days 5–7)

Goal: Replace the stub with real investigation logic — two tools, a real Reasoner call, a real Calibrator. Verdicts must be defensible.

### E-2.1 — Postgres schema + Alembic baseline ✅
- **Spec:** [07-DataLayer.md](07-DataLayer.md), [Specs.md §9.1](Specs.md)
- **Acceptance:** Tables `subreddit_profile`, `user_memory`, `investigation`, `evidence`, `feedback`, `audit_log` created via migration. Every table has `subreddit_id`.
- **Deps:** F-0.6.
- **Done 2026-05-13:** `engine/store/models.py` declares all 6 tables in SQLAlchemy 2.0 typed style with JSONB for flexible fields (calibration weights, evidence detail, audit_log detail). Enum columns enforced via named `CheckConstraint`s rather than PG-native enums for migration agility. Foreign keys: `user_memory.subreddit_id` → `subreddit_profile`; `investigation.subreddit_id` → `subreddit_profile`; `evidence.investigation_id` → `investigation` (CASCADE). Composite uniqueness: `(subreddit_id, user_id)` on `user_memory`; `(investigation_id, evidence_id)` on `evidence`. Confidence range constrained to [0,1]. Alembic configured (`alembic.ini` + `alembic/env.py` reading URL from `Settings` and swapping `+asyncpg`→`+psycopg` for sync DDL). Baseline migration `20260513_1829_baseline_schema_subreddit_profile_user_.py` autogenerated and applied to local pg — all 6 tables verified via `\dt`, `subreddit_id` present on every one (invariant I-7). `engine/store/test_models.py` adds 5 metadata-only invariant tests (all-tables-present, subreddit_id-on-every-table, correlation_id unique, user_memory uniqueness, evidence per-investigation uniqueness) so future drift fails CI. `ruff` + `mypy --strict` + 22 tests all clean.

### E-2.2 — Store layer ✅
- **Spec:** [07-DataLayer.md](07-DataLayer.md)
- **Acceptance:** `engine/store/postgres.py` and `engine/store/redis.py` with typed Pydantic models, async sessions, connection pooling, `subreddit_id` guard.
- **Deps:** E-2.1.
- **Done 2026-05-13:** Three new modules:
  - `store/types.py` — Pydantic v2 domain types (`SubredditProfileRow`, `UserMemoryRow`, `StartInvestigationInput`, `FinalizeInvestigationInput`, `EvidenceRowInput`, `FeedbackInput`) with `from_attributes=True`. The rest of the codebase reads/writes these; ORM stays in `models.py`.
  - `store/postgres.py` — async repository functions. `make_sessionmaker(engine)` + `with_session()` async-CM (commit-on-clean-exit, rollback-on-exception). Public surface: `ensure_subreddit_profile`, `get_subreddit_profile`, `get_user_memory`, `upsert_user_memory` (idempotent ON CONFLICT + optional counter deltas), `start_investigation` → `m.Investigation`, `append_evidence` (rejects `subreddit_id` mismatch with the investigation — defense-in-depth for I-7), `finalize_investigation` (raises `LookupError` if no pending row matches `(correlation_id, subreddit_id)` — second-layer scope check), `get_investigation_by_correlation` (eager-loads `.evidence` via `selectinload` so callers can read it after session close), `record_feedback`, `list_recent_feedback_for_subreddit`, `append_audit`. **Every function takes `subreddit_id` as a mandatory keyword arg** — invariant I-7 enforced at the function signature.
  - `store/redis.py` — typed key namespace per Specs §9.2 (`k_profile`, `k_summary`, `k_velocity`, `k_verdict`, `k_embedding`, `k_budget`) with explicit TTL constants (1h profile, 24h summary/budget, 7d verdict, 30d embedding). Helpers: `get/set_profile_cache`, `get/set_thread_summary`, `record_report` (sliding-window ZSET + ZREMRANGEBYSCORE eviction), `velocity_count`, `velocity_zscore` (pure; capped at ±9), `get/set_cached_verdict`, `add_spend` / `todays_spend_cents` for daily budget tracking, `cents()` ceil-rounder.
  - **Lifespan integration:** `api/main.py` now builds `app.state.pg_sessions = make_sessionmaker(app.state.pg)` so handlers open sessions via `async with with_session(request.app.state.pg_sessions) as s:`.
  - **Tests (E-2.2):** `store/test_postgres.py` (7 tests, exercises real pg via docker-compose: idempotent `ensure_subreddit_profile`, `upsert_user_memory` counters, full investigation lifecycle start → evidence → finalize → reload-with-eager-evidence, scope-mismatch raises on `finalize` and `append_evidence`, feedback+audit roundtrip, miss-returns-None). `store/test_redis.py` (8 tests: profile/summary/verdict cache roundtrips, sliding-window velocity with old-event eviction, pure `velocity_zscore` cap, daily budget atomic increment, `cents()` ceil semantics). Both auto-skip when `SKIP_DB_TESTS=true` so CI without docker passes.
- Ruff + mypy --strict + 37 tests all green.

### E-2.3 — Tool: `policy_match` ✅
- **Spec:** [04-InvestigationEngine.md §5.3.1](04-InvestigationEngine.md)
- **Acceptance:** Returns `ToolResult` with rule similarity match. Unit tests (pure function) + integration test against seeded rules.
- **Deps:** E-2.2.
- **Done 2026-05-13:** `engine/orchestrator/policy_match.py` — `PolicyMatchTool` satisfies `Tool` Protocol, DI'd with Redis + `EmbedFn` + `RulesTextFn`. Splits rules via numbered/paragraph heuristic, caches rule embeddings in Redis (`rules_embed:{subreddit_id}`, 30d TTL), computes cosine similarity (pure function), filters ≥0.65 threshold, returns top 5 matches. Lazy embedding on cache miss. Added `get_rule_embeddings`/`set_rule_embeddings`/`invalidate_rule_embeddings` to `store/redis.py`. 25 tests (7 split_rules, 6 cosine_similarity, 12 tool run). Lint + mypy --strict clean.

### E-2.4 — Tool: `report_velocity` ✅
- **Spec:** [04-InvestigationEngine.md §5.3.2](04-InvestigationEngine.md)
- **Acceptance:** Redis sliding-window count → z-score. <30 ms p95.
- **Deps:** E-2.2.
- **Done 2026-05-13:** `engine/orchestrator/report_velocity.py` — `ReportVelocityTool` satisfies `Tool` Protocol, DI'd with Redis client. Reads 1 min / 5 min / 15 min sliding-window counts via `store.redis.velocity_count`, computes z-score via `velocity_zscore` against default baseline (post-MVP: per-subreddit). Returns `ToolResult` with `detail={reports_1m, reports_5m, reports_15m, baseline_mean, baseline_stddev, z_score}`. Errors caught and returned as `status=failure`. 8 unit tests (mocked Redis), all pass. Lint + mypy --strict clean.

### E-2.5 — Tool Registry & Evidence Accumulator ✅
- **Spec:** [04-InvestigationEngine.md §4](04-InvestigationEngine.md), [Specs.md §7.3–7.4](Specs.md)
- **Acceptance:** `engine/orchestrator/registry.py` registers tools by name. Accumulator produces stable `ev-N` IDs.
- **Deps:** ~~E-2.3, E-2.4~~ — built first as substrate; tools register *into* it.
- **Done 2026-05-13:** `engine/orchestrator/tools.py` defines the full substrate:
  - **`Tool` Protocol** (`@runtime_checkable`): `name: ToolName` property + `async run(ctx: ToolContext) -> ToolResult`. Concrete tools (E-2.3, E-2.4) hold DB/Redis/LLM clients as instance state injected at startup; the Orchestrator only sees the Protocol surface.
  - **`ToolContext`** (frozen dataclass): subreddit_id, correlation_id, target_{kind,id,body,author_id} + cheap signals (reporter_count, rule_match_score) the Strategy Selector already computed.
  - **`ToolResult`** (frozen): tool, status (`success`/`failure`/`skipped`/`timeout` per Specs §7.3), summary (≤200 char Verdict-Card line), detail JSON, latency_ms, error. `.is_terminal_failure()` helper for orchestrator branching.
  - **`ToolRegistry`**: register / get / has / names (insertion-ordered) / `__len__` / `__contains__`. Duplicate registration raises ValueError; unknown name raises KeyError.
  - **`EvidenceAccumulator`**: append-only, mints monotonic `ev-N` ids starting at 1, defensively copies `detail` dict on append so caller mutations can't poison the timeline. `by_id` lookup, `successful_entries()` filter (per ADR-0003 the Reasoner is only allowed to cite successes — failures show in the Timeline but never in citations), `__iter__`. 19 tests cover every behavior (parametrized terminal-failure detection, defensive-copy verification, multi-instance counter isolation, Protocol runtime check, async tool roundtrip via registry). 100% statement coverage; 98% branch (the only "missing" branches are Protocol method stubs which are unreachable by design).

### E-2.6 — Strategy Selector ✅
- **Spec:** [04-InvestigationEngine.md §2](04-InvestigationEngine.md), [Specs.md §7.1](Specs.md)
- **Acceptance:** Returns `FAST | STANDARD | DEEP` with budgets from §7.1 table. Pure function; <50 ms; 100% test coverage.
- **Deps:** None (no I/O).
- **Done 2026-05-13:** `engine/orchestrator/strategy.py` exports `StrategyInputs` (frozen dataclass — reporter_count, velocity_zscore, user_risk_tier, rule_match_score, personality, tier_override, cold_start) and `StrategyDecision` (frozen — tier, tool_budget, time_budget_ms, cost_budget_usd, reasoner_required, rationale). Decision order: (1) moderator `tier_override` setting wins, with cold-start floor on FAST→STANDARD per Specs §12.1; (2) DEEP triggers if `reporter_count ≥ threshold`, `velocity_zscore ≥ threshold`, or `user_risk_tier == "watched"` — personality nudges shift thresholds (strict −1 / lenient +1); (3) FAST eligible only when single reporter + `velocity < 0.5` + `rule_match ≥ 0.9` + new/trusted user + not cold-start; (4) STANDARD default. Budget table pinned to Specs §7.1: FAST=2/800ms/$0.003 no-reasoner, STANDARD=4/3s/$0.012 with-reasoner, DEEP=6/6s/$0.030 with-reasoner. Import-time `assert` cross-checks that every `StrategyTier` literal has a budget entry. **100% branch coverage** (26 tests including: parametrized override surface, cold-start vetoes, every DEEP signal in isolation + combined, every FAST-blocker, personality nudges in both directions, locked budget table per tier, `<50ms × 1000 calls` perf bound, frozen-dataclass immutability, defensive override-value error path).

### E-2.7 — Orchestrator loop ✅
- **Spec:** [04-InvestigationEngine.md §3](04-InvestigationEngine.md)
- **Acceptance:** Runs tools per tier plan, enforces budgets, early-stops on convergence, returns full evidence + timeline. Tests cover: happy path, early stop, budget exit, single-tool failure.
- **Deps:** E-2.5, E-2.6.
- **Done 2026-05-13:** `engine/orchestrator/loop.py` exports `Orchestrator` (stateless, safe to share across requests) and `OrchestratorResult` (frozen — correlation_id, subreddit_id, tier, accumulator, started_at/completed_at datetimes, total_latency_ms, tools_run, early_stopped, stop_reason, plan).
  - **Default plans per Specs §7.1:** FAST=[policy_match, report_velocity], STANDARD=[+user_history, prior_actions], DEEP=[+thread_context].
  - **Loop semantics:** budget pre-check (tool_budget + time_budget_ms) before each iteration → unregistered tool becomes `status=skipped` evidence (no crash) → tool runs with `except Exception` isolation, exceptions captured as `failure` evidence with `error` populated → accumulator append → convergence check.
  - **Convergence policy:** 1 strong-signal success on FAST, 2 on STANDARD/DEEP. A "strong signal" is `result.detail["signal"] == "high"` — tools opt in by setting it.
  - **Clock injection** via `clock: Callable[[], float]` parameter (default `time.perf_counter`) so tests can drive elapsed time deterministically.
  - **Structured logging** at start, per-tool, on stop, on completion — every line carries correlation_id + subreddit_id + tier.
  - 14 tests cover: happy path (full 4-tool plan completes), timestamps recorded, STANDARD converges after 2 strong signals (skips remaining tools), FAST converges after 1, no convergence when no signal set, tool_budget exit, time_budget exit (via FakeClock), single-tool exception doesn't abort (subsequent tools still run, failure carries `RuntimeError` + msg), failures excluded from `successful_entries()` (ADR-0003), unregistered tool → skipped not crash, custom plan overrides tier default, `default_plan()` per tier + unknown-tier raises, **orchestrator is reusable** across investigations (fresh accumulator per `run()`, ev-1 resets). **100% statement + branch coverage on `loop.py`**. ruff + mypy --strict + 96 tests all green.

### E-2.8 — Reasoner prompt v1.0 ✅
- **Spec:** [06-AILayer.md §4.2](06-AILayer.md), [Specs.md §7.5 + §8.3](Specs.md)
- **Acceptance:** `engine/llm/prompts/reasoner.py` exports v1.0 prompt with response schema. Inline `[ev-N]` citations required. Three sample scenarios produce valid output.
- **Deps:** F-0.8.
- **Done 2026-05-13:** `engine/llm/prompts/reasoner.py` — exports `ReasonerOutput` (Pydantic: risk_tier, recommendation, rationale, top_evidence_ids≤3, raw_confidence, cited_evidence_ids, flags), `Reasoner` class (DI'd with LLMClient, calls gemini-2.5-pro at temp=0 with 512 thinking budget, parses structured response or falls back to raw_text JSON), `build_messages()` (system+user single-turn), `build_corrective_messages()` (appends prior response + validation error for retry), `serialize_evidence()` (renders successful entries as `[ev-N] tool: summary (detail)` block). System prompt enforces 6 constraints: citation contract, no invented facts, no identities, personality-aware, calibrated confidence, risk tier. 29 tests (9 schema, 5 serialization, 4 message build, 2 corrective, 6 Reasoner caller, 3 scenario integration). Lint + mypy --strict clean.

### E-2.9 — Citation validator ✅
- **Spec:** [06-AILayer.md §3.3](06-AILayer.md), [Specs.md §8.3](Specs.md)
- **Acceptance:** `engine/llm/validation.py` enforces every `[ev-N]` resolves to accumulator. 100% test coverage (load-bearing).
- **Done 2026-05-13:** `engine/llm/validation.py` — pure-function `validate_citations(rationale, accumulator, cited_evidence_ids?)` enforcing ADR-0003. Five checks: empty rationale, no citations, hallucinated IDs (refs not in accumulator), cited non-success evidence (failure/timeout/skipped), uncited substantive sentences, cited_evidence_ids field mismatch. Substantive-sentence heuristic skips framing phrases, recommendation statements, and ≤5-word fragments. `ValidationResult` frozen dataclass with `.ok()` / `.failed(reason, **details)`. 47 tests — **100% statement + branch coverage**. Lint + mypy --strict clean.
- **Deps:** E-2.5, E-2.8.

### E-2.10 — Confidence Calibrator ✅
- **Spec:** [04-InvestigationEngine.md §7](04-InvestigationEngine.md), [Specs.md §7.6](Specs.md)
- **Acceptance:** Weighted blend of 4 inputs → calibrated confidence. Tier assigned. Surfaces breakdown for UI. 100% test coverage.
- **Deps:** E-2.7.
- **Done 2026-05-13:** `engine/orchestrator/calibrator.py` — pure-function `calibrate(CalibrationInputs) -> CalibrationResult`. 4 weighted signals (llm 0.25, evidence 0.30, accuracy 0.20, rule_match 0.25) with LLM overconfidence discount (compresses toward 0.5 by factor 0.4). 3 conditional demotions: validation_failed (×0.6), partial (×0.8), cold_start (×0.85) — stackable. Tier: HIGH≥0.85, MEDIUM≥0.60, LOW<0.60. `compute_evidence_convergence()` helper. `CalibrationResult` frozen, carries breakdown for UI audit. 25 tests — **100% statement + branch coverage**. Lint + mypy --strict clean.

### E-2.11 — Wire real `/investigate` ✅
- **Spec:** [Specs.md §10.2](Specs.md)
- **Acceptance:** Endpoint runs full pipeline: Strategy → Orchestrator → Reasoner → Validator → Calibrator. Returns response matching schema. Persists `investigation` + `evidence` rows.
- **Deps:** E-2.10, E-2.9.
- **Done 2026-05-13:** `engine/api/pipeline.py` — `run_investigation()` full pipeline function with DI. Strategy selection → Orchestrator (tool execution) → Reasoner with retry (first attempt + corrective retry on validation failure) → Citation validator → Confidence Calibrator → Verdict assembly. `_fallback_output()` degraded path when Reasoner fails twice. Helpers: `_extract_rule_match_strength()`, `_extract_evidence_signals()`, `_build_timeline()`, `_build_top_evidence()`. `PipelineResult` frozen dataclass. `engine/api/main.py` — endpoint wired with lifespan-managed ToolRegistry + Orchestrator + GeminiClient. Fetches subreddit profile from Postgres (cold-start defaults if missing). Persists investigation + evidence + verdict rows via `start_investigation` → `append_evidence` → `finalize_investigation`. 31 pipeline tests + 8 endpoint tests (39 new). Total suite: 261 passed. Lint + mypy --strict clean.

### E-2.12 — Rule-based fallback verdict ✅
- **Spec:** [Specs.md §13.1](Specs.md), [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)
- **Acceptance:** When Reasoner fails twice or validator rejects twice, returns degraded verdict with `degraded=true`, no recommendation, evidence intact.
- **Deps:** E-2.11.
- **Done 2026-05-13:** Implemented as part of E-2.11 pipeline. `_reason_with_retry()` attempts Reasoner twice (first + corrective retry), returns `None` on double failure. `_fallback_output()` produces degraded verdict: `risk_tier="LOW"`, `recommendation="NO_RECOMMENDATION"`, `degraded=True`, evidence preserved. Tested in `TestDegradedMode` (3 tests).

---

## Phase 3 — Full investigation (Days 8–10)

Goal: Five tools, memory, cold-start, personalities, honest uncertainty.

### I-3.1 — Tool: `user_history` ✅
- **Spec:** [04-InvestigationEngine.md §5.3.3](04-InvestigationEngine.md), [05-Memory.md](05-Memory.md)
- **Acceptance:** Reads `user_memory` Postgres row + Redis cache. Returns risk tier label (never raw score). Updates last_seen.
- **Deps:** E-2.2, I-3.4.
- **Impl:** `orchestrator/user_history.py` — reads UserMemory, returns risk_tier + counters + signal strength. Registered in lifespan. 11 unit + 3 DB integration tests.
- **Reddit-API surface validated 2026-05-13 (Devvit-side, ahead of Python impl):** `devvit-app/src/routes/menu.ts:investigate-post` uses `reddit.getUserById` + `getPostsByUser({ sort: 'new', limit: 10 })` + `getCommentsByUser` to produce the `HistorySnapshot` shape the engine tool will need. Reference payload captured against u/trendy_guy2003 stored in playtest logs. Python `user_history` tool consumes the same shape after Devvit sends it (or, more likely, fetches it server-side from the engine via Reddit OAuth).

### I-3.2 — Tool: `prior_actions` ✅
- **Spec:** [04-InvestigationEngine.md §5.3.4](04-InvestigationEngine.md)
- **Acceptance:** Reads `audit_log` for last N mod actions on this user in this subreddit. <120 ms.
- **Deps:** E-2.2.
- **Impl:** `orchestrator/prior_actions.py` — queries completed investigations on same author. Registered in lifespan. 8 unit + 3 DB integration tests.

### I-3.3 — Tool: `thread_context` ✅
- **Spec:** [04-InvestigationEngine.md §5.3.5](04-InvestigationEngine.md), [06-AILayer.md §2.2](06-AILayer.md)
- **Acceptance:** For threads ≥10 comments, calls Gemini 2.5 Flash with summarizer prompt; returns structured arc/escalation/instigator/off-topic blob. Caches in Redis `summary:{thread_id}`.
- **Deps:** F-0.8.
- **Done 2026-05-13:** Three pieces landed:
  - **Schema extension:** `ToolContext` gained `thread_id: str` + `thread_excerpts: tuple[str, ...]` (tuple for frozen-dataclass safety). Populated by `api/pipeline.py` from `InvestigateRequest.context`.
  - **Prompt module `llm/prompts/summarizer.py`:** `ThreadSummary` Pydantic schema (arc 1–240 chars, escalation_turn `int|None`, instigator_candidates ≤5, off_topic bool, total_turns ≥0), `Summarizer` class mirroring `Reasoner` (Role.SUMMARIZER, max_tokens=512, timeout=5s, `thinking_budget=0` per the F-0.8 insight that Flash supports disabling thinking and we want sub-1.5s latency for the §2.2 target).
  - **Tool `orchestrator/thread_context.py`:** `ThreadContextTool` — checks `len(thread_excerpts) >= 10` (configurable via `_MIN_COMMENTS_FOR_SUMMARY`); if short, returns `status="skipped"` with `detail.reason="below_min_comments"`. Otherwise: Redis cache-aside via `get_thread_summary` / `set_thread_summary`; LLM call failures captured as `status="failure"` with the exception preserved in `error`; cache get/set wrapped in `contextlib.suppress(Exception)` so Redis flaps don't break the tool. Sets `detail["signal"] = "high"` when `escalation_turn` is non-null — drives orchestrator convergence under E-2.7.
  - **Wiring:** `api/main.py` reordered to build LLM client *before* the registry, then conditionally registers `ThreadContextTool(app.state.llm, app.state.redis)` only when a Gemini key is present; missing-LLM falls through to `orchestrator.tool.unregistered` skip path.
  - **Tests (13):** short-thread skip (no LLM call), zero-comment boundary, cache hit (zero LLM calls, `from_cache=True`), corrupt-cache fall-through, cache miss → LLM call + Redis write, missing `thread_id` skips cache I/O but runs LLM, LLM-exception → failure status with no cache write, Redis-set ConnectionError still returns success, Redis-get ConnectionError falls through to LLM, neutral signal when `escalation_turn=None`, off-topic surfaces in summary line, 200-char truncation with `...` suffix, canonical tool name.
  - All checks green: `ruff` + `mypy --strict orchestrator api observability store llm` + 333/333 tests (2 LLM skipped).

### I-3.4 — User & thread memory ingest ✅
- **Spec:** [05-Memory.md](05-Memory.md)
- **Acceptance:** On every `ModAction`, `user_memory` and `thread_memory` rows update. Risk tier rules from `05-Memory.md` applied.
- **Deps:** E-2.1.
- **Done 2026-05-14:** `engine/memory/ingest.py` — `process_feedback()` updates: (1) durable feedback row, (2) user_memory counters + risk tier recomputation, (3) thread_memory mod_actions_taken (JSONB array append), (4) subreddit cold_start_count increment, (5) audit log. `compute_risk_tier()` pure function: new (no history), watched (>=3 violations), trusted (>=5 approvals + 0 violations), neutral (else). `ThreadMemory` model + Alembic migration. `ThreadMemoryRow` Pydantic type. Postgres functions: `get_thread_memory()`, `upsert_thread_memory()`, `increment_cold_start_count()`. 22 tests (13 pure + 9 DB integration). Total suite: 283 passed.

### I-3.5 — Cold-start mode ✅
- **Spec:** [05-Memory.md](05-Memory.md), [Specs.md §12.1](Specs.md), [09-UX.md §12](09-UX.md)
- **Acceptance:** New install starts with `cold_start=true`. Counter increments on each `feedback` insert. Crosses 50 → automatic transition; UI badge appears/disappears accordingly.
- **Deps:** I-3.4.
- **Impl:** Wired across I-3.4 (counter increment), E-2.11 (threshold check `< 50` in main.py), E-2.6 (strategy selector floors FAST→STANDARD), E-2.8 (calibrator demotes confidence). UI badge is Devvit-side (U-4.x).

### I-3.6 — Personality presets ✅
- **Spec:** [05-Memory.md](05-Memory.md), [Specs.md §12.2](Specs.md)
- **Acceptance:** Three presets influence confidence thresholds + Reasoner system prompt addendum. Switching personality reflects in next investigation.
- **Deps:** E-2.10.
- **Impl:** `personalities/presets.py` — PersonalityPreset dataclass, STRICT/BALANCED/LENIENT presets with prompt_phrasing, deep thresholds, and confidence thresholds. Pipeline wires phrasing into Reasoner prompt. 12 tests.

### I-3.7 — Honest uncertainty UX ✅
- **Spec:** [09-UX.md §6](09-UX.md), [Specs.md §11.4](Specs.md)
- **Acceptance:** Calibrated conf <0.60 renders 🌱 chip + marginalia note + no primary button styling. Demo-ready.
- **Deps:** E-2.10, S-1.4.
- **Done 2026-05-14:** Two surfaces honor honest uncertainty now:
  - **Rich custom-post UI** (`src/client/main.js`, already built in S-1.4) — already branches at `calibrated_confidence < 0.60`: pill becomes "Low conf." + dashed-top variant, recommendation chip swaps to "🌱 ModPilot is unsure — your call", marginalia note from `copy.ts:uncertainty.marginalia` renders, NO primary-action styling on any button. (Gated on V-5.5 production deploy.)
  - **Form-modal UI** (`src/routes/menu.ts`, today's demoable path) — refactored `showVerdictForm` to branch on `calibrated_confidence < 0.60`. LOW path: title becomes `🌱  ModPilot is unsure — N% confidence`; the top "Recommendation" field is replaced with a `🌱 Honest uncertainty` paragraph showing `uncertainty.marginalia` verbatim from `ui/copy.ts`; helpText says "No action pre-selected. Evidence is mixed; your judgment matters here."; the rationale section is relabeled "What I looked at" (not "Reasoning") since there's no recommendation to reason toward. HIGH/MEDIUM path unchanged.
  - **Demoability:** Two `CannedVerdict` fixtures (HIGH-conf REMOVE @ 92%, LOW-conf NO_RECOMMENDATION @ 54%) selected deterministically by `selectCanned(target_id)` via charcode-sum mod-5 hash (~40% of targets land LOW). Same target always renders the same verdict — reproducible demos with no menu clutter.
  - **Verdict cache extended:** `verdict:{correlation_id}` Redis hash now also stores `is_low_conf` so the future custom-post path renders the same way.
  - **Wire integrity:** `npm run type-check` + `npm run lint` + `npm run build` all clean; `scripts/check-banned-terms.sh` + `scripts/check-no-inline-hex.sh` both pass.

### I-3.8 — Resolved / re-reported card states ☐
- **Spec:** [09-UX.md §4.6](09-UX.md)
- **Acceptance:** After `ModAction`, card collapses to "✓ Removed by u/X 2 min ago". Re-reports surface "Re-reported 3 times in 10 min" annotation.
- **Deps:** S-1.6.

### I-3.9 — Tier 5: Strategy refinement ☐
- **Spec:** [04-InvestigationEngine.md §2](04-InvestigationEngine.md)
- **Acceptance:** Strategy Selector uses cached user trust tier + thread escalation flag. Tested against 10 scenarios.
- **Deps:** I-3.1, I-3.4.

---

## Phase 4 — Surfaces & polish (Days 11–12)

Goal: Everything outside the verdict pipeline — dashboard, wizard, menu actions, banners, error states.

### U-4.1 — Mod Dashboard custom post ☐
- **Spec:** [09-UX.md §8](09-UX.md), [Specs.md §11.3](Specs.md)
- **Acceptance:** Four tiles + tier breakdown bar + priority queue table. Cost tile gated by setting. Matches mockup §III.
- **Deps:** E-2.11.

### U-4.2 — Priority rollup job ☐
- **Spec:** [03-Devvit.md](03-Devvit.md), [Specs.md §6.3](Specs.md)
- **Acceptance:** Every 5 min, recomputes queue priority score per pending report.
- **Deps:** U-4.1.

### U-4.3 — First-Run Wizard ☐
- **Spec:** [09-UX.md §7](09-UX.md), [Specs.md §11.6](Specs.md)
- **Acceptance:** Three steps render as custom post. Personality selection persists. Rules editor + region select work. Test investigation runs against most recent unactioned report. Resumable from `wizard_state` KV. Total time <3 min for empty subreddit.
- **Deps:** E-2.11, I-3.6.

### U-4.4 — Menu: "Investigate with ModPilot" ☐
- **Spec:** [09-UX.md §9.1](09-UX.md), [03-Devvit.md](03-Devvit.md)
- **Acceptance:** Forces investigation on selected comment/post. Renders Verdict Card inline.
- **Deps:** E-2.11, S-1.4.

### U-4.5 — Menu: "Summarize this thread" ☐
- **Spec:** [09-UX.md §9.2](09-UX.md)
- **Acceptance:** Modal showing arc / escalation / instigator / off-topic. ≤500 words. "From cache" indicator when applicable.
- **Deps:** I-3.3.

### U-4.6 — Menu: "Show Moderation Memory" ☐
- **Spec:** [09-UX.md §9.3](09-UX.md)
- **Acceptance:** Modal with risk tier label, prior violation breakdown, last 3 actions, "Wipe memory" soft-delete button with confirmation.
- **Deps:** I-3.1.

### U-4.7 — Menu: "Explain ModPilot's last call" ☐
- **Spec:** [09-UX.md §9.4](09-UX.md)
- **Acceptance:** Reads `verdict:{correlation_id}` from Redis; re-renders Verdict Card + Timeline. No Engine call.
- **Deps:** S-1.4, S-1.5.

### U-4.8 — Banners & error states ☐
- **Spec:** [09-UX.md §11](09-UX.md), [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)
- **Acceptance:** Engine unreachable, kill switch, rate-limited, investigation timeout, Reasoner degraded — all render their copy from `copy.ts`.
- **Deps:** F-0.10.

### U-4.9 — Action flows: confirm + toast + collapse ☐
- **Spec:** [09-UX.md §10](09-UX.md)
- **Acceptance:** Click Remove → inline confirmation chip (3s auto-cancel) → Reddit API → toast → card collapses to resolved state.
- **Deps:** S-1.6.

### U-4.10 — Dark mode validation ☐
- **Spec:** [09-UX.md §2](09-UX.md)
- **Acceptance:** Token values render correctly under Devvit dark theme. No hardcoded values escape.
- **Deps:** F-0.10.

---

## Phase 5 — Eval & demo (Days 13–14)

Goal: Evaluation harness running, demo polished, submission shipped.

### V-5.1 — Eval scenario library import ☐
- **Spec:** [11-Evaluation.md](11-Evaluation.md), [Specs.md §16](Specs.md)
- **Acceptance:** OpenENV scenarios under `eval/scenarios/`. Each is a JSON fixture matching the schema. ≥30 scenarios across HIGH/MEDIUM/LOW + edge cases.
- **Deps:** none.

### V-5.2 — Eval harness runner ☐
- **Spec:** [11-Evaluation.md](11-Evaluation.md)
- **Acceptance:** `uv run python -m eval.run --suite all` runs every scenario in-process, produces JSON report (accuracy, calibration error, latency p50/p95, cost).
- **Deps:** V-5.1, E-2.11.

### V-5.3 — Baseline pinned ☐
- **Spec:** [11-Evaluation.md](11-Evaluation.md)
- **Acceptance:** `eval/baseline.json` checked in. Eval gate fires when prompts / orchestrator / calibrator change.
- **Deps:** V-5.2.

### V-5.4 — CI eval gate ☐
- **Spec:** [14-Engineering.md §6](14-Engineering.md)
- **Acceptance:** GitHub Action runs eval suite on PRs touching prompts or orchestrator. Fails if accuracy drops >3pp or calibration error widens >5pp vs. baseline. <12 min total CI.
- **Deps:** V-5.3, F-0.9.

### V-5.5 — Production deploy ☐
- **Spec:** [13-Infra.md](13-Infra.md)
- **Acceptance:** Engine deployed to Fly.io with secrets, autoscale config, health check. Devvit app published to App Directory (private listing OK).
- **Deps:** E-2.11.

### V-5.6 — Observability live ☐
- **Spec:** [Specs.md §15](Specs.md), [13-Infra.md](13-Infra.md)
- **Acceptance:** Grafana Cloud dashboards show latency p50/p95, cost rolling 24h, kill-switch state, accuracy.
- **Deps:** V-5.5.

### V-5.7 — Demo script ☐
- **Spec:** [15-Hackathon.md](15-Hackathon.md)
- **Acceptance:** 3-minute walkthrough hits: install → wizard → first investigation → expand timeline → "I'm unsure" moment → dashboard. Practiced 5×.
- **Deps:** all phase-4 surfaces.

### V-5.8 — Submission package ☐
- **Spec:** [15-Hackathon.md](15-Hackathon.md)
- **Acceptance:** Video, README, public repo link, App Directory listing. Per-hackathon checklist complete.
- **Deps:** V-5.7.

---

## Cross-Cutting Tasks (touch many phases)

### X-1 — Doc-sync discipline ⊘ (process, not task)
Every PR that changes a public contract updates the matching doc in the same PR. Per [14-Engineering.md §7.8](14-Engineering.md).

### X-2 — Test coverage targets ◐ (continuously)
| Module | Target |
|---|---|
| `engine/orchestrator/` | ≥85% |
| `engine/tools/` | ≥80% |
| `engine/llm/validation.py` | 100% |
| `engine/llm/anon.py` | 100% |
| `engine/store/` | ≥75% |
| `devvit-app/src/triggers/` | ≥80% |
| `devvit-app/src/ui/` | ≥60% |

CI enforces drops on load-bearing modules.

### X-3 — Terminology hygiene ◐ (continuously)
Banned words check in CI. Grep on PR diff for any user-facing string containing banned terms.

### X-4 — Subreddit-isolation lint ◐ (continuously)
Every new persisted query checked for `subreddit_id` predicate. Per invariant I-7.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Devvit Blocks can't match mockup fidelity | Medium | Mockup is reference; gracefully degrade. Tokens are the contract, layout flexes. |
| Gemini rate limits during demo | Medium | Daily budget cap + kill switch; rehearse against staging. |
| Reasoner citation validation rejects too often | Medium | Eval gate catches early; one corrective retry + fallback verdict cushions. |
| Cold-start UX feels punishing | Low | "Learning" badge is informational, not blocking. Mod can still take any action. |
| Postgres free tier exhausts mid-demo | Low | Retention 30d on bodies; audit log capped 90d. |
| Slipping past Day 14 | High | Phases 4–5 carry the cuttable surfaces. Drop scope in this order: U-4.5, U-4.10, V-5.4, U-4.2. |

---

## How to Update This File

1. Move a task's emoji as work progresses: ☐ → ◐ → ✅.
2. **Don't delete tasks** — mark ⊘ deferred or ⏸ blocked with a reason in the Notes line.
3. When acceptance shifts (rare), update the Spec link rather than rewriting acceptance freehand.
4. The At-a-Glance table is a derived view — update phase status when ≥80% of phase tasks land.
5. Bump the Last updated date at the top whenever the file changes.

---

## Related Documents

- [Specs.md](Specs.md) — consolidated spec; this tracker references it for acceptance contracts.
- [CLAUDE.md](../CLAUDE.md) — root operating contract; current phase + open questions.
- [14-Engineering.md](14-Engineering.md) — branching, testing, Claude Code workflow, CI gates.
- [15-Hackathon.md](15-Hackathon.md) — submission checklist that closes Phase 5.
- [mockups/moderator-ui.html](../mockups/moderator-ui.html) — visual reference for Phase 1+ UI tasks.
