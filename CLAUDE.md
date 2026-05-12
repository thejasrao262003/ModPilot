# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Root system memory for ModPilot. Loaded into every Claude Code session.
> Keep under 1000 words. Update weekly.

---

## Repo Reality Check

Phase 0 scaffold is landing. As of 2026-05-12: `devvit-app/`, `engine/`, `eval/`, `scripts/` directory trees exist with manifests and lint configs (F-0.3 ✅); `engine/api/main.py` boots and serves `/health`. No source logic yet — placeholders only. [docs/Glossary.md](docs/Glossary.md) and [docs/adr/](docs/adr/) (0001–0004) now exist (F-0.2 ✅). Check [docs/Implementation Tracker.md](docs/Implementation%20Tracker.md) for current status before assuming any module is implemented.

## What ModPilot Is

ModPilot is a **context-aware investigation engine for Reddit moderation**, built on Devvit. When a report arrives, ModPilot runs the five lookups an experienced moderator would do manually — user history, thread context, rule match, report patterns, prior actions — then surfaces a verdict with the full evidence trail. The moderator decides.

## Core Thesis

> **Most moderation tools classify content. ModPilot investigates context.**

`report → investigate → reason → recommend → learn`. Classification is a byproduct of investigation, not the goal.

## Hard Rules (Invariants — Never Violate)

1. **Human-in-the-loop is mandatory.** Every Remove / Approve / Escalate / Lock requires a moderator click. See [docs/10-ReliabilityAndSafety.md](docs/10-ReliabilityAndSafety.md).
2. **Every verdict claim must cite evidence.** The Reasoner cannot make claims not tied to an evidence ID. Enforced per [docs/06-AILayer.md](docs/06-AILayer.md) citation contract.
3. **Honest confidence.** Low-confidence verdicts say "I'm unsure." Never inflate.
4. **Cold-start safety.** New installs run conservative until 50+ feedback events accumulate. See [docs/05-Memory.md](docs/05-Memory.md).
5. **Graceful degradation.** If the Engine is unreachable, the mod queue still works. Fail closed (no recommendation), never fail open. See [docs/10-ReliabilityAndSafety.md](docs/10-ReliabilityAndSafety.md).
6. **Evidence-first UI.** Every recommendation expands into its Investigation Timeline. See [docs/09-UX.md](docs/09-UX.md).
7. **Subreddit isolation.** Every persisted query is `subreddit_id`-scoped. See [docs/07-DataLayer.md](docs/07-DataLayer.md).
8. **Layer purity.** `devvit-app/` never imports from `engine/` and vice versa; `eval/` may import from `engine/`.

## Terminology Rules

**Never use in user-facing code, UI, prompts, or docs:**
RL, reinforcement learning, policy, reward, training, episode, action space, observation space, value function, agent, trajectory.

| Internal | Product term |
|---|---|
| Action space | Tool Registry |
| Observation space | Evidence Accumulator |
| Trajectory | Investigation Timeline |
| Reward signal | Confidence Calibration |
| Policy | Investigation Strategy |
| Scenario generator | Evaluation Harness |
| Multi-step reasoning | Adaptive Investigation |

Backend service is the **Investigation Engine**, never the "AI backend."

## Architecture (6 lines)

1. **Reddit** fires triggers (`CommentReport`, `PostReport`, `ModAction`, `AppInstall`) into the Devvit app.
2. **Devvit app** (TypeScript) enriches with cheap context and calls the Engine over signed HTTPS.
3. **Investigation Engine** (Python + FastAPI) runs Strategy Selector → Orchestrator → Tool Registry → Reasoner → Confidence Calibrator.
4. **Postgres** holds moderation memory, feedback, audit log. **Redis** caches profiles, summaries, verdicts.
5. Verdict returns to Devvit, written to Devvit KV, rendered as **Verdict Card + Investigation Timeline**.
6. Moderator clicks an action → `ModAction` trigger captures feedback → nightly batch refines personality weights.

Full layout in [README.md](README.md#repository-layout) and [docs/02-Architecture.md](docs/02-Architecture.md).

## Tech Stack (Locked — changes require an ADR)

TypeScript Devvit · Python 3.11 + FastAPI on Fly.io · Gemini 2.5 Pro (Reasoner) + Gemini 2.5 Flash (planning/summarization) · Postgres (Supabase/Neon) · Redis (Upstash) · Grafana Cloud.

## Commands (once code lands)

```bash
# Devvit app
cd devvit-app && npm install
devvit upload                              # publish to test subreddit
npx jest path/to/file.test.ts -t "name"    # single TS test
eslint devvit-app/src && tsc --noEmit -p devvit-app

# Investigation Engine
cd engine && uv sync && cp .env.example .env
uv run uvicorn api.main:app --reload
uv run pytest path/to/test_file.py::test_name   # single Python test
ruff check engine && mypy --strict engine

# Eval gate (run when prompts or orchestrator change)
uv run python -m eval.run --suite all
```

Local Postgres + Redis come up via `make services-up` (docker-compose). Full setup in [docs/13-Infra.md](docs/13-Infra.md).

## Document Navigation Map

Load per task type, in addition to this file:

| Working on | Load |
|---|---|
| Devvit triggers, settings, UI | `docs/03-Devvit.md` + `docs/09-UX.md` |
| Investigation engine logic | `docs/04-InvestigationEngine.md` + `docs/06-AILayer.md` |
| Prompts, models, citation contract | `docs/06-AILayer.md` + `docs/04-InvestigationEngine.md` |
| Database / schema | `docs/07-DataLayer.md` + `docs/05-Memory.md` |
| Verdict card / timeline UI | `docs/09-UX.md` + `docs/04-InvestigationEngine.md` |
| API endpoints | `docs/08-API.md` + `docs/04-InvestigationEngine.md` |
| Reliability / safety | `docs/10-ReliabilityAndSafety.md` |
| Evaluation / scenarios | `docs/11-Evaluation.md` + `docs/01-Product.md` |
| Deployment / infra | `docs/13-Infra.md` |
| Engineering standards / Claude Code workflow | `docs/14-Engineering.md` |
| Demo / submission | `docs/15-Hackathon.md` + `docs/01-Product.md` |
| **Consolidated spec (anything cross-cutting)** | `docs/Specs.md` |
| **Build status / what's next** | `docs/Implementation Tracker.md` |

## Claude Code Session Structure

From [docs/14-Engineering.md §7](docs/14-Engineering.md):

1. State the task in one sentence.
2. State the reference docs being loaded.
3. State the acceptance criteria (often pulled from the doc) — skipping this is the #1 cause of off-target output.
4. Implement.
5. Run the relevant tests / eval.
6. Verify acceptance criteria.
7. Commit with a conventional commit message (`feat(scope): …`).

Good scope: *"Implement `policy_match` tool per `docs/04-InvestigationEngine.md` §5.3.1."* Bad scope: *"Build the engine."* / *"Fix the bug in the trigger."*

## Common Pitfalls (catch in review)

- **Drifting terminology** — reaches for "policy" / "reward" in prompts. Check the table above.
- **Adding files instead of expanding files** — push back unless the new file maps to a distinct concern.
- **Inline strings / hex colors in UI** — enforce `ui/copy.ts` and `ui/tokens.ts`.
- **Skipping the citation contract** — grep new prompts for `[ev-` to verify.
- **Missing `subreddit_id` filters** — non-negotiable on every persisted query.
- **Cross-layer imports** — Devvit ↔ engine imports silently break the architecture.

## Default Behaviors

- **Before editing**, confirm the relevant area doc from the navigation map is loaded.
- **New feature?** Check [docs/01-Product.md](docs/01-Product.md) Non-Goals first.
- **Architecture / schema / tech stack change?** Write an ADR in `docs/adr/` before coding.
- **Unsure whether a behavior should be automatic?** Default to requiring a moderator click.
- **Information missing?** Leave `// TODO(open-question)` and surface it — don't guess.
- **Doc-sync rule:** code changes that invalidate a doc update the doc in the same PR (new endpoint → `08-API.md`; new table → `07-DataLayer.md`; new tool → `04-InvestigationEngine.md`).

## Current Phase & Priorities

**Phase:** Pre-implementation documentation (Days 1–2 of 14).

1. Lock the 10 blocking docs (Product, Architecture, Devvit, Engine, AI Layer, Data, UX, Glossary, this file, foundational ADRs).
2. Stand up Devvit app skeleton with `CommentReport` trigger wired end-to-end to a stub Engine.
3. Build the Tool Registry + Orchestrator with two real tools.
4. Ship the Verdict Card MVP visual.

**Out of scope this phase:** stretch features, full analytics dashboard, OpenENV harness wiring, demo polish.

## Open Questions (don't guess — surface as `TODO(open-question)`)

- Subreddit-level rate limit thresholds — [docs/10-ReliabilityAndSafety.md](docs/10-ReliabilityAndSafety.md).
- Cold-start "learning" badge wording — [docs/09-UX.md](docs/09-UX.md).
- Standard tier defaults to 4 or 5 tools — [docs/04-InvestigationEngine.md](docs/04-InvestigationEngine.md).
- Whether `docs/Glossary.md` and `docs/adr/` get scaffolded this week.

---

*Last updated: 2026-05-12 (Day 1 of build). Next review: end of Day 7.*
