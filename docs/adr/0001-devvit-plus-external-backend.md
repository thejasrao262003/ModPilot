# ADR 0001: Devvit App + External Python Backend

Status: Accepted
Date: 2026-05-12

## Context

ModPilot has two natural homes for its logic: inside the Devvit app (TypeScript, edge-deployed, tightly integrated with Reddit triggers and UI) or in a separate backend service (Python, FastAPI, full control over LLM clients, persistent stores, and orchestration).

Devvit alone is constrained: limited request budgets per trigger, no persistent compute, no long-lived async loops, no native access to Python ML/LLM tooling. But Devvit *is* the only way to receive Reddit triggers, render mod-queue UI, and call the Reddit moderation API.

## Decision

Split the system across two services:

- **Devvit app (TypeScript)** — owns triggers, settings, UI, menu actions, scheduled jobs, and Reddit API calls. Holds no investigation logic.
- **Investigation Engine (Python + FastAPI on Fly.io)** — owns the Strategy Selector, Orchestrator, Tool Registry, Reasoner (Gemini), Calibrator, memory, and audit log.

The two services communicate over HMAC-signed HTTPS. The Devvit app passes enriched report context to the Engine; the Engine returns a fully-formed Verdict.

## Consequences

- The Engine can use any Python tooling (`google-genai`, asyncpg, structlog) without Devvit constraints.
- We pay a network hop per investigation (~50–150 ms). Acceptable at our latency targets.
- Two deploy surfaces, two CI pipelines, two sets of secrets. Worth it for the separation.
- Graceful degradation becomes a hard requirement: if the Engine is unreachable, the Devvit app must let Reddit's native mod queue continue working. See invariant I-5 in [Specs.md](../Specs.md).
- The layer-purity rule (invariant I-8): `devvit-app/` and `engine/` never import from each other. Enforced in `eslint` and `ruff` configs.

## Alternatives Considered

- **Devvit-only.** Rejected: cannot host LLM client + memory store + orchestration within Devvit's request budget.
- **Engine-only with Reddit OAuth bot.** Rejected: loses Devvit's first-class UI and trigger surface; loses moderator install funnel.
- **Cloudflare Workers for the Engine.** Rejected: Python toolchain on Workers is not mature enough for the hackathon timeline.
