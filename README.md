# ModPilot

### The Context-Aware Investigation Engine for Reddit Moderation

> **Most moderation tools classify content. ModPilot investigates context.**

ModPilot is a Devvit app that runs the five lookups every experienced moderator does manually — user history, thread escalation, rule match, report patterns, prior actions — and hands you a verdict with the full evidence trail. You decide. It just stops being repetitive.

Built moderator-first. Human-in-the-loop by design. Auditable by default.

---

## The Problem

Reddit moderators spend roughly 90 seconds per report doing the same five lookups:

- Who is this user? What's their history here?
- What's the thread context? Is this escalation or an isolated comment?
- Which rule does this violate, if any?
- Are other people reporting similar things right now?
- What have we done about this user before?

AutoMod can't help — it's a regex engine. Generic AI moderation bots classify content in isolation and can't explain themselves. The investigative work that consumes mod attention is still entirely manual.

**That's the gap ModPilot fills.**

---

## How It Works

When a report arrives, ModPilot doesn't classify the content — it **investigates the situation**.

```
Report arrives
   ↓
Risk estimation (cheap, ~50ms)
   ↓
Strategy selection (Fast / Standard / Deep)
   ↓
Evidence gathering (tools run in parallel where possible)
   ↓
Reasoning (every claim cites evidence)
   ↓
Verdict + Investigation Timeline → mod sees one-glance card
   ↓
Moderator decides → feedback refines the system
```

Every recommendation includes:

- **A risk tier** — HIGH / MEDIUM / LOW
- **A suggested action** — Remove / Approve / Escalate / Lock
- **A confidence score** — calibrated, honest, and *low when it should be low*
- **Top evidence rows** — the concrete facts that drove the recommendation
- **A full Investigation Timeline** — every lookup, what it found, why it mattered

ModPilot **never takes a moderation action autonomously**. Every action requires a moderator click. Always.

---

## What Makes ModPilot Different

| Existing tools | ModPilot |
|---|---|
| Classify content in isolation | Investigate the full context |
| Static rule engines (AutoMod regex) | Adaptive investigation depth per report |
| Opaque "trust me" verdicts | Every claim cites visible evidence |
| Treat every report the same | Fast / Standard / Deep tiers based on risk |
| Overconfident even when wrong | Honest uncertainty — says "I'm unsure" |
| Stateless | Longitudinal moderation memory per user / thread / subreddit |
| One-size-fits-all | Subreddit personalities (Strict / Balanced / Lenient) |
| No cold-start safety | Conservative thresholds until feedback accumulates |

---

## Key Features

**Adaptive Investigation Depth.** Obvious spam gets 1 lookup. Harassment gets 4. Brigading gets the full deep dive. The Strategy Selector picks a tier per report, optimizing cost and latency without sacrificing accuracy.

**Investigation Timeline.** The signature feature. Click any verdict to see exactly what ModPilot checked, what it found, and how that drove the recommendation. No black boxes.

**Moderation Memory.** Longitudinal state per user, thread, and subreddit. Repeat offenders, escalating patterns, and prior mod actions all surface as concrete evidence rows — not opaque scores.

**Subreddit Personalities.** r/AskHistorians and r/dankmemes don't moderate the same way. ModPilot adapts confidence thresholds, escalation policy, and reasoning tone per subreddit.

**Cold-Start Safety.** New installs run in conservative mode with a visible "learning" badge. Higher thresholds, no auto-prefill, and a gradual transition as feedback accumulates.

**Honest Uncertainty.** When ModPilot is unsure, it says so — surfaces evidence without recommending an action. This single piece of honest UX is what makes the system deployable.

**Cost-Aware Operation.** Median investigation runs in ~3 seconds at ~$0.01. Token budgets, time budgets, and tool-call budgets are enforced per tier.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              REDDIT PLATFORM                         │
│  Triggers · Mod Queue · Custom Post Dashboard       │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│           DEVVIT APP (edge functions)                │
│  Triggers → Enrichment → Devvit Redis → UI render   │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS (HMAC-signed)
                     ▼
┌─────────────────────────────────────────────────────┐
│          INVESTIGATION ENGINE                        │
│  ┌─────────────────────────────────────────────┐    │
│  │ Strategy Selector (Fast/Standard/Deep)      │    │
│  └────────────────────┬────────────────────────┘    │
│                       ▼                              │
│  ┌─────────────────────────────────────────────┐    │
│  │ Orchestrator → Tool Registry → Evidence     │    │
│  │ Accumulator → Reasoner → Confidence Calib.  │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  Moderation Memory · Subreddit Personalities         │
│  Cold-Start Safety · Cost Budgets · Caching          │
│                                                      │
│  ┌────────────────┐         ┌─────────────────┐     │
│  │  Postgres      │         │  Redis cache    │     │
│  │  (memory,      │         │  (profiles,     │     │
│  │   feedback,    │         │   summaries,    │     │
│  │   audit log)   │         │   verdicts)     │     │
│  └────────────────┘         └─────────────────┘     │
└─────────────────────────────────────────────────────┘
```

**Tech stack:** Devvit (TypeScript) · Python 3.11 + FastAPI · Gemini 2.5 Pro (reasoning) · Gemini 2.5 Flash (planning, summarization) · Postgres · Redis · Fly.io

---

## Repository Layout

```
modpilot/
├── CLAUDE.md                  ← system memory for AI-assisted dev
├── README.md                  ← you are here
├── devvit-app/                ← TypeScript Devvit app
│   ├── src/
│   │   ├── main.ts
│   │   ├── triggers/          ← report, mod action, install handlers
│   │   ├── menu/              ← investigate, summarize, explain
│   │   ├── jobs/              ← scheduled re-prioritization, rollups
│   │   ├── ui/                ← Verdict Card, Timeline, Dashboard
│   │   ├── services/          ← Engine client, Reddit context
│   │   └── settings.ts        ← subreddit-level config
│   └── devvit.yaml
├── engine/                    ← Python Investigation Engine
│   ├── api/                   ← FastAPI endpoints
│   ├── orchestrator/          ← Strategy Selector, loop, budgets
│   ├── tools/                 ← UserHistory, ThreadContext, etc.
│   ├── llm/                   ← Claude client, prompts
│   ├── memory/                ← user/thread/subreddit memory
│   └── store/                 ← Postgres, Redis layers
├── eval/                      ← scenarios + harness (OpenENV-derived)
└── docs/                      ← architecture, design docs, ADRs
```

---

## Quickstart

> ⚠️ ModPilot is in active hackathon development. Production install instructions will land here once published to the Devvit App Directory.

**For developers building locally:**

```bash
# Devvit app
cd devvit-app
npm install
devvit upload                  # publishes to your test subreddit

# Investigation Engine
cd engine
uv sync                        # or pip install -r requirements.txt
cp .env.example .env           # fill in GEMINI_API_KEY, DB urls
uv run uvicorn api.main:app --reload
```

Detailed setup including database provisioning, secret management, and end-to-end local testing lives in [`docs/13-Infra.md`](docs/13-Infra.md).

---

## Documentation

Everything about how ModPilot is designed and built lives in `docs/`:

- [`01-Product.md`](docs/01-Product.md) — Vision, positioning, personas, non-goals
- [`02-Architecture.md`](docs/02-Architecture.md) — System design, topology, data flow
- [`03-Devvit.md`](docs/03-Devvit.md) — Triggers, settings, lifecycle, UI primitives
- [`04-InvestigationEngine.md`](docs/04-InvestigationEngine.md) — Strategy selector, orchestrator, tools, reasoner
- [`05-Memory.md`](docs/05-Memory.md) — Moderation memory + personalities + cold-start
- [`06-AILayer.md`](docs/06-AILayer.md) — LLM abstraction, prompts, citation contract
- [`07-DataLayer.md`](docs/07-DataLayer.md) — Postgres schema, Redis keyspace, retention
- [`08-API.md`](docs/08-API.md) — Engine API surface, signing, errors
- [`09-UX.md`](docs/09-UX.md) — Moderator journey, verdict card, timeline, wizard
- [`10-ReliabilityAndSafety.md`](docs/10-ReliabilityAndSafety.md) — Degradation, HITL, PII, trust
- [`11-Evaluation.md`](docs/11-Evaluation.md) — Eval harness, scenarios
- [`12-Analytics.md`](docs/12-Analytics.md) — Metrics, events, impact
- [`13-Infra.md`](docs/13-Infra.md) — Deployment, secrets, observability, local dev
- [`14-Engineering.md`](docs/14-Engineering.md) — Standards, testing, Claude Code workflow
- [`15-Hackathon.md`](docs/15-Hackathon.md) — Demo script, submission checklist

---

## Design Principles

**Investigate, don't classify.** Classification is a byproduct. Investigation is the product.

**Evidence before verdict.** Every recommendation cites the specific facts that drove it.

**Honest uncertainty.** When ModPilot doesn't know, it says so. Trust is built on calibration, not confidence theater.

**Human-in-the-loop, always.** No autonomous actions. Ever. The moderator's judgment is sacred.

**Cost-aware by design.** Production deployment matters. ModPilot is engineered to scale economically.

**Graceful degradation.** If the Engine is down, the mod queue still works.

**Auditable by default.** Every recommendation and every mod action lives in a queryable audit log.

---

## Status

🚧 **Hackathon build in progress.** Built for the Reddit Mod Tools and Migrated Apps Hackathon.

Target: production-grade, installable from the Devvit App Directory, polished enough that moderators could realistically install it tomorrow.

---

## Acknowledgements

ModPilot's adaptive investigation architecture is informed by concepts originally developed in our **OpenENV Content Moderation** project — a multi-step moderation reasoning framework. Those concepts have been re-architected here as a production engineering system, not a research artifact. The OpenENV scenario library now powers our offline evaluation harness.

---

## License

MIT (TBD — final license decision pending submission).

---

> *ModPilot — the future of moderation tooling is human-led and context-aware.*