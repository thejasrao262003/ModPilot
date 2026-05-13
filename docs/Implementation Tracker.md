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
| 1 — End-to-end stub | Days 3–4 | Trigger → stub Engine → fake Verdict Card | ☐ |
| 2 — Real Engine MVP | Days 5–7 | 2 tools + Reasoner + Calibrator, real verdicts | ☐ |
| 3 — Full investigation | Days 8–10 | All 5 tools + memory + cold-start + personalities | ☐ |
| 4 — Surfaces & polish | Days 11–12 | Dashboard, wizard, menu actions, error states | ☐ |
| 5 — Eval & demo | Days 13–14 | Eval harness wired, demo script, submission | ☐ |

**Current focus:** 🎉 **Phase 0 complete (Day 2 of 14).** Next: Phase 1 — End-to-end stub. S-1.1 (CommentReport trigger) and S-1.2 (Devvit → Engine client) are the unblocked entry points.

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

### S-1.1 — `CommentReport` trigger wired ☐
- **Spec:** [03-Devvit.md](03-Devvit.md), [Specs.md §6.1](Specs.md)
- **Acceptance:** Trigger fires in test subreddit; logs `correlation_id`; dedupes within 10 min via `pending_investigation:{comment_id}` key in Devvit KV.
- **Deps:** F-0.4.

### S-1.2 — Devvit → Engine client ☐
- **Spec:** [Specs.md §10](Specs.md), [03-Devvit.md](03-Devvit.md)
- **Acceptance:** `services/engineClient.ts` signs requests with HMAC, posts to `/investigate`, parses response. Handles 5xx with one retry + graceful degradation.
- **Deps:** F-0.5, S-1.1.

### S-1.3 — Stub `/investigate` returns canned verdict ✅
- **Spec:** [Specs.md §10.2](Specs.md)
- **Acceptance:** Endpoint returns a HIGH-conf REMOVE verdict matching the response schema, with 4 timeline rows + 3 top evidence + confidence breakdown. Validates against Pydantic.
- **Deps:** F-0.5.
- **Done 2026-05-13:** `engine/api/schemas.py` defines the full Pydantic v2 contract for `/investigate`: `InvestigateRequest` (correlation_id, subreddit_id with `^t5_` regex, target {kind: comment|post, id, body, author}, report {reasons, reporter_count, first_at, last_at}, context), `Verdict` (tier, risk_tier, recommendation, calibrated_confidence, rationale with `[ev-N]` citations, top_evidence ≤3, timeline, confidence_breakdown, model + cost + flags), `InvestigateResponse` envelope. `engine/api/canned.py` returns a HIGH-conf REMOVE verdict mirroring the mockup data — so S-1.4 (Verdict Card) and S-1.5 (Timeline) render the same data the UI was designed against. 8 new tests in `api/test_investigate.py` cover: schema validation (malformed subreddit_id → BAD_REQUEST envelope, missing correlation_id, negative reporter_count), happy-path canned verdict shape (3 evidence rows, 4 timeline steps, confidence breakdown in [0,1], every cited `[ev-N]` resolves to top_evidence), and both target kinds (comment + post). ruff + mypy --strict + 17 tests all green.

### S-1.4 — VerdictCard MVP component ☐
- **Spec:** [09-UX.md §4](09-UX.md), [mockup](../mockups/moderator-ui.html)
- **Acceptance:** Renders header row + 3 evidence rows + 4 action buttons + expansion handle. HIGH-confidence variant filled, MEDIUM outline. Matches mockup visually within Devvit Blocks constraints.
- **Deps:** F-0.10, S-1.3.

### S-1.5 — InvestigationTimeline MVP component ☐
- **Spec:** [09-UX.md §5](09-UX.md), [mockup](../mockups/moderator-ui.html)
- **Acceptance:** Renders tool rows with verb (from copy.ts map), latency, evidence chips. Verdict block with rationale + model + cost + confidence breakdown.
- **Deps:** F-0.10, S-1.3.

### S-1.6 — `ModAction` trigger → feedback record ☐
- **Spec:** [03-Devvit.md](03-Devvit.md), [Specs.md §9.1](Specs.md)
- **Acceptance:** When mod clicks Remove/Approve/Escalate, trigger captures alignment and POSTs to `/feedback`. Engine stub logs the event.
- **Deps:** S-1.4.

### S-1.7 — End-to-end demo ☐
- **Spec:** none new
- **Acceptance:** Live walkthrough: file a report in test subreddit → Verdict Card appears → click Remove → Reddit removes the comment → feedback logged.
- **Deps:** S-1.1–S-1.6.

---

## Phase 2 — Real Engine MVP (Days 5–7)

Goal: Replace the stub with real investigation logic — two tools, a real Reasoner call, a real Calibrator. Verdicts must be defensible.

### E-2.1 — Postgres schema + Alembic baseline ☐
- **Spec:** [07-DataLayer.md](07-DataLayer.md), [Specs.md §9.1](Specs.md)
- **Acceptance:** Tables `subreddit_profile`, `user_memory`, `investigation`, `evidence`, `feedback`, `audit_log` created via migration. Every table has `subreddit_id`.
- **Deps:** F-0.6.

### E-2.2 — Store layer ☐
- **Spec:** [07-DataLayer.md](07-DataLayer.md)
- **Acceptance:** `engine/store/postgres.py` and `engine/store/redis.py` with typed Pydantic models, async sessions, connection pooling, `subreddit_id` guard.
- **Deps:** E-2.1.

### E-2.3 — Tool: `policy_match` ☐
- **Spec:** [04-InvestigationEngine.md §5.3.1](04-InvestigationEngine.md)
- **Acceptance:** Returns `ToolResult` with rule similarity match. Unit tests (pure function) + integration test against seeded rules.
- **Deps:** E-2.2.

### E-2.4 — Tool: `report_velocity` ☐
- **Spec:** [04-InvestigationEngine.md §5.3.2](04-InvestigationEngine.md)
- **Acceptance:** Redis sliding-window count → z-score. <30 ms p95.
- **Deps:** E-2.2.

### E-2.5 — Tool Registry & Evidence Accumulator ☐
- **Spec:** [04-InvestigationEngine.md §4](04-InvestigationEngine.md), [Specs.md §7.3–7.4](Specs.md)
- **Acceptance:** `engine/orchestrator/registry.py` registers tools by name. Accumulator produces stable `ev-N` IDs.
- **Deps:** E-2.3, E-2.4.

### E-2.6 — Strategy Selector ☐
- **Spec:** [04-InvestigationEngine.md §2](04-InvestigationEngine.md), [Specs.md §7.1](Specs.md)
- **Acceptance:** Returns `FAST | STANDARD | DEEP` with budgets from §7.1 table. Pure function; <50 ms; 100% test coverage.
- **Deps:** None (no I/O).

### E-2.7 — Orchestrator loop ☐
- **Spec:** [04-InvestigationEngine.md §3](04-InvestigationEngine.md)
- **Acceptance:** Runs tools per tier plan, enforces budgets, early-stops on convergence, returns full evidence + timeline. Tests cover: happy path, early stop, budget exit, single-tool failure.
- **Deps:** E-2.5, E-2.6.

### E-2.8 — Reasoner prompt v1.0 ☐
- **Spec:** [06-AILayer.md §4.2](06-AILayer.md), [Specs.md §7.5 + §8.3](Specs.md)
- **Acceptance:** `engine/llm/prompts/reasoner.py` exports v1.0 prompt with response schema. Inline `[ev-N]` citations required. Three sample scenarios produce valid output.
- **Deps:** F-0.8.

### E-2.9 — Citation validator ☐
- **Spec:** [06-AILayer.md §3.3](06-AILayer.md), [Specs.md §8.3](Specs.md)
- **Acceptance:** `engine/llm/validation.py` enforces every `[ev-N]` resolves to accumulator. 100% test coverage (load-bearing).
- **Deps:** E-2.5, E-2.8.

### E-2.10 — Confidence Calibrator ☐
- **Spec:** [04-InvestigationEngine.md §7](04-InvestigationEngine.md), [Specs.md §7.6](Specs.md)
- **Acceptance:** Weighted blend of 4 inputs → calibrated confidence. Tier assigned. Surfaces breakdown for UI. 100% test coverage.
- **Deps:** E-2.7.

### E-2.11 — Wire real `/investigate` ☐
- **Spec:** [Specs.md §10.2](Specs.md)
- **Acceptance:** Endpoint runs full pipeline: Strategy → Orchestrator → Reasoner → Validator → Calibrator. Returns response matching schema. Persists `investigation` + `evidence` rows.
- **Deps:** E-2.10, E-2.9.

### E-2.12 — Rule-based fallback verdict ☐
- **Spec:** [Specs.md §13.1](Specs.md), [10-ReliabilityAndSafety.md](10-ReliabilityAndSafety.md)
- **Acceptance:** When Reasoner fails twice or validator rejects twice, returns degraded verdict with `degraded=true`, no recommendation, evidence intact.
- **Deps:** E-2.11.

---

## Phase 3 — Full investigation (Days 8–10)

Goal: Five tools, memory, cold-start, personalities, honest uncertainty.

### I-3.1 — Tool: `user_history` ☐
- **Spec:** [04-InvestigationEngine.md §5.3.3](04-InvestigationEngine.md), [05-Memory.md](05-Memory.md)
- **Acceptance:** Reads `user_memory` Postgres row + Redis cache. Returns risk tier label (never raw score). Updates last_seen.
- **Deps:** E-2.2, I-3.4.
- **Reddit-API surface validated 2026-05-13 (Devvit-side, ahead of Python impl):** `devvit-app/src/routes/menu.ts:investigate-post` uses `reddit.getUserById` + `getPostsByUser({ sort: 'new', limit: 10 })` + `getCommentsByUser` to produce the `HistorySnapshot` shape the engine tool will need. Reference payload captured against u/trendy_guy2003 stored in playtest logs. Python `user_history` tool consumes the same shape after Devvit sends it (or, more likely, fetches it server-side from the engine via Reddit OAuth).

### I-3.2 — Tool: `prior_actions` ☐
- **Spec:** [04-InvestigationEngine.md §5.3.4](04-InvestigationEngine.md)
- **Acceptance:** Reads `audit_log` for last N mod actions on this user in this subreddit. <120 ms.
- **Deps:** E-2.2.

### I-3.3 — Tool: `thread_context` ☐
- **Spec:** [04-InvestigationEngine.md §5.3.5](04-InvestigationEngine.md), [06-AILayer.md §2.2](06-AILayer.md)
- **Acceptance:** For threads ≥10 comments, calls Gemini 2.5 Flash with summarizer prompt; returns structured arc/escalation/instigator/off-topic blob. Caches in Redis `summary:{thread_id}`.
- **Deps:** F-0.8.

### I-3.4 — User & thread memory ingest ☐
- **Spec:** [05-Memory.md](05-Memory.md)
- **Acceptance:** On every `ModAction`, `user_memory` and `thread_memory` rows update. Risk tier rules from `05-Memory.md` applied.
- **Deps:** E-2.1.

### I-3.5 — Cold-start mode ☐
- **Spec:** [05-Memory.md](05-Memory.md), [Specs.md §12.1](Specs.md), [09-UX.md §12](09-UX.md)
- **Acceptance:** New install starts with `cold_start=true`. Counter increments on each `feedback` insert. Crosses 50 → automatic transition; UI badge appears/disappears accordingly.
- **Deps:** I-3.4.

### I-3.6 — Personality presets ☐
- **Spec:** [05-Memory.md](05-Memory.md), [Specs.md §12.2](Specs.md)
- **Acceptance:** Three presets influence confidence thresholds + Reasoner system prompt addendum. Switching personality reflects in next investigation.
- **Deps:** E-2.10.

### I-3.7 — Honest uncertainty UX ☐
- **Spec:** [09-UX.md §6](09-UX.md), [Specs.md §11.4](Specs.md)
- **Acceptance:** Calibrated conf <0.60 renders 🌱 chip + marginalia note + no primary button styling. Demo-ready.
- **Deps:** E-2.10, S-1.4.

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
