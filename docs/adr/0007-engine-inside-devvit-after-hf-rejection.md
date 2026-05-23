# ADR 0007: Run the Investigation Engine Inside the Devvit App (After HF Rejection)

Status: Accepted
Date: 2026-05-20

## Context

ADR-0001 split the system into a **Devvit app** (TypeScript) and an
**Investigation Engine** (Python + FastAPI). We executed against that split
through E-2.x and shipped a working engine: 340 passing tests, full
Strategy → Tools → Reasoner → Validator → Calibrator pipeline, end-to-end
validated against a tunneled local instance.

We then attempted three deploy paths to make the engine reachable from
Devvit's outbound HTTP:

1. **ngrok tunnel** — rejected immediately by Devvit's outbound policy
   (`grpc invocation failed with status 7; HTTP request to domain ... is not
   allowed`). ngrok subdomains are personal-domain class.
2. **HuggingFace Spaces (Docker)** — deployed successfully (Supabase Postgres
   + Upstash Redis + Gemini), container green, `/health` 200, all secrets
   wired. Submitted via Devvit 0.12.23's self-serve domain flow.
   **Rejected.** `*.hf.space` falls under the same personal-domain
   classification as ngrok.
3. **Vercel / Fly.io / Render** considered and discarded — same domain class,
   same rejection trajectory.

The empirical finding is unambiguous: Devvit's outbound allowlist will not
admit a personal-domain class endpoint for this app, regardless of submission
flow. The only domain categories that work are:

- **Global allowlist** (no approval needed): `api.openai.com`,
  `generativelanguage.googleapis.com`, `example.com`.
- **Approved cloud providers with justification + manual review**:
  `supabase.com`, `firebase.com`, `s3.amazonaws.com`, etc. — multi-week
  wait, hackathon-incompatible.

ADR-0006 contemplated this exact pivot before we'd tried the HF route. We
deleted it (premature) and then burned a day proving its premise by deploy
attempt. This ADR is the redo, with empirical grounding.

## Decision

**The entire investigation pipeline runs inside the Devvit Web app, in
TypeScript, in-process.** The Python engine remains in the repository as
the reference implementation + eval harness substrate, but is no longer on
the demo path.

Concretely:

- TypeScript port lives at `devvit-app/src/engine/` and mirrors the Python
  engine module-for-module:

  | Python (`engine/`) | TypeScript (`devvit-app/src/engine/`) |
  |---|---|
  | `orchestrator/strategy.py` | `strategy.ts` |
  | `orchestrator/tools.py` (registry + accumulator) | `accumulator.ts` |
  | `orchestrator/calibrator.py` | `calibrator.ts` |
  | `orchestrator/loop.py` | `loop.ts` |
  | `orchestrator/report_velocity.py` | `tools/reportVelocity.ts` |
  | `orchestrator/user_history.py` | `tools/userHistory.ts` |
  | `orchestrator/prior_actions.py` | `tools/priorActions.ts` |
  | `orchestrator/thread_context.py` | `tools/threadContext.ts` |
  | `llm/gemini.py` | `llm/gemini.ts` (direct REST, no SDK) |
  | `llm/prompts/reasoner.py` | `llm/reasoner.ts` |
  | `llm/prompts/summarizer.py` | `llm/summarizer.ts` |
  | `llm/validation.py` | `llm/validator.ts` |
  | `personalities/presets.py` | `personalities.ts` |
  | `api/pipeline.py` | `pipeline.ts` |
  | `store/postgres.py` + `store/redis.py` | `store/*.ts` (Devvit Redis) |

- LLM calls go direct to `generativelanguage.googleapis.com` (global
  allowlist). No tunnel, no intermediate backend.
- Persistence flattens to **Devvit's managed Redis** (the `redis` import
  from `@devvit/web/server`). Subreddit-scoped keys per docs/CLAUDE.md
  hard rule 7. Postgres is **not used** on the demo path.
- Gemini API key flows through Devvit's app-scoped settings:
  `devvit.json:settings` declares it; `npx devvit settings set geminiApiKey ...`
  populates it; `await settings.get('geminiApiKey')` reads at request time.
- The HTTP client (`devvit-app/src/services/engineClient.ts`) is retired
  from the demo path. `menu.ts` calls `runInvestigation()` directly.
- The ESLint layer-purity rule (`no-restricted-imports`) is relaxed: the
  root `engine/` Python tree is still off-limits; `devvit-app/src/engine/`
  is allowed (it's part of the Devvit app).

## Consequences

**Positive:**
- The demo works without infrastructure approvals, deployments, or tunnels.
  Zero domain submissions, zero backend wait time.
- The Devvit app becomes self-contained — install it, set the Gemini key, done.
- No HMAC signing, no skew tolerance, no error-envelope translation between
  Python and TypeScript — every call is in-process and typed.
- One runtime to deploy and monitor (Devvit's), not two.
- Latency drops: no extra HTTP hop per investigation. The single network
  call is direct Devvit → Gemini.

**Negative / debt:**
- **Two engine implementations to maintain** during the active build window.
  Logic changes need to land in both Python (reference) and TypeScript (demo).
  Mitigated by Python being feature-frozen and the port locking the algorithm
  + contracts.
- **No Postgres-backed relational queries.** The Python engine used SQL joins
  for `prior_actions` (correlation across investigations) and `user_memory`
  (aggregate counters). The TS port uses Redis hashes + sorted sets. The data
  model gets simpler but loses SQL flexibility — fine for the moderation
  workload, painful if we ever want analytics.
- **No Alembic migrations** for the demo path. Schema changes happen by
  editing the TS port and reading old keys defensively.
- **Eval harness divergence.** `eval/run.py` exercises the Python engine.
  Accepted — the eval harness validates the *algorithm* (Strategy Selector
  thresholds, citation contract, calibrator math), and the algorithm is
  identical across the two ports.
- **Layer-purity invariant I-8 stretches.** `devvit-app/src/engine/` is
  investigation logic living inside `devvit-app/`. The ESLint rule still
  bans imports from the root `engine/`; the new TS code is its own module
  tree.

## Alternatives Considered

- **Deploy Python engine to HF Spaces + auto-submit `hf.space` domain.**
  Tried. Empirically rejected. Same outcome as ngrok/Fly/Render — the policy
  doesn't distinguish between hobby hosts.
- **Deploy to Supabase Edge Functions** (the only "approved cloud provider"
  with code-execution support). Would still need manual review for the
  Supabase domain. Multi-week wait. Also requires porting FastAPI to Deno.
- **Hybrid: Devvit calls Gemini directly, HF Space handles DB/Redis only.**
  Requires Reasoner + Validator + Calibrator + Strategy in TS *and* the HF
  Space. Same porting cost as full TS port with extra HTTP boundary.
- **Wait for Reddit's policy team to approve our domain manually.** Could
  take weeks. Hackathon-incompatible.

## Migration

- Python engine stays in `engine/`. CI keeps running its tests (340 passing
  as of this ADR). It remains the reference implementation.
- New TS code in `devvit-app/src/engine/` mirrors the Python module shape.
- The Supabase Postgres + Upstash Redis instances we set up during the HF
  attempt remain available for the Python engine; they are unused by the
  demo path.
- The HF Space `ThejasRao/ModPilot` and its secrets remain provisioned for
  V-5.5 (production deploy via a future Devvit policy change or a fully
  reviewed approved-cloud-provider domain).
- `engineClient.ts` is retired from the menu code path but kept in
  `services/` for any future hybrid deployment.

## Related

- [ADR-0001](0001-devvit-plus-external-backend.md) — the original split this
  ADR partially reverses.
- [ADR-0003](0003-evidence-citation-required.md) — citation contract;
  unchanged.
- [ADR-0005](0005-devvit-web-not-blocks.md) — Devvit Web (Hono + Vite) is
  the platform the engine now runs inside.
- [Specs.md §6](../Specs.md) — Devvit app spec; the in-process engine is
  logically part of the Devvit app.
- [Reddit's HTTP fetch policy](https://github.com/reddit/devvit-docs/blob/main/docs/capabilities/server/http-fetch-policy.md)
  — the policy that drove this decision (twice).
