# ModPilot

**The context-aware investigation engine for Reddit moderation.**

> Most moderation tools classify content. ModPilot investigates context.

Reddit moderators spend 60-120 seconds per report doing the same five investigative lookups — checking user history, scrolling thread context, cross-referencing rules, watching for report patterns, recalling prior actions. ModPilot does that work for you and surfaces a verdict alongside the full evidence trail. **You decide.** It just stops being repetitive.

---

## What ModPilot Does

When a moderator clicks **Investigate with ModPilot** on a reported post or comment, the app runs an adaptive multi-tool investigation and produces a verdict with cited evidence — in 5–15 seconds:

1. **Strategy Selector** picks an investigation tier (Fast / Standard / Deep) based on cheap signals.
2. **Tool registry** runs in parallel: report velocity, user history, prior actions, thread context, rule match.
3. **Reasoner** (Gemini 2.5 Pro) produces a structured recommendation with inline `[ev-N]` citations.
4. **Citation validator** rejects any claim that doesn't cite real evidence — every word the model writes must be backed by a tool result.
5. **Confidence Calibrator** discounts overconfident LLM self-reports, applies subreddit-personality weighting, and surfaces honest uncertainty.
6. **Verdict UI** opens in the mod queue with the recommendation, evidence chips, Investigation Timeline, priority score, key factors, and a Reasoner panel.
7. **Moderator clicks** Remove / Approve / Lock / Escalate — and optionally generates a draft reply message to the author. Never auto-acted on.

---

## Hard Invariants (Never Violated)

1. **Human-in-the-loop is mandatory.** Every action requires a moderator click.
2. **Every verdict claim cites evidence.** Enforced at the validator, not as a vibe.
3. **Honest confidence.** Low-confidence verdicts say "I'm unsure." Never inflated.
4. **Cold-start safety.** New installs run conservative until ~10 investigations accumulate.
5. **Graceful degradation.** Engine failure never breaks Reddit's native mod queue.
6. **Evidence-first UI.** Every recommendation expands into its Investigation Timeline.
7. **Subreddit isolation.** Every persisted record is scoped to its subreddit.
8. **Moderator decides, always.** ModPilot augments judgment, never overrides it.

---

## Key Features

**Investigation**
- 4 active tools: report_velocity, user_history, prior_actions, thread_context
- Adaptive tier selection (FAST 2 tools / STANDARD 4 tools / DEEP 5+ tools)
- Citation contract enforced post-generation with corrective retry
- Per-subreddit moderation memory (repeat-offender detection, alignment statistics)

**Moderator-facing surfaces**
- **🔥 / ⚠️ / ℹ️ Priority pill** — urgency score derived from confidence × recommendation × pressure × user risk × escalation × rule match
- **Repeat-offender / first-time / positive-history badges**
- **Confidence explanation panel** — surfaces exactly which calibrator inputs pushed confidence up or down
- **Key factors panel** — top contributors sorted by impact (High / Medium / Low)
- **Rule match explainability** — matched rules with score band + cited evidence
- **Escalating-conversation banner** when `thread_context` detects hostility patterns
- **Alignment line** — "ModPilot and your team agree N%" once feedback accumulates
- **Honest uncertainty marginalia** when calibrated confidence < 60%

**Moderator actions**
- Single-click Remove / Approve / Lock / Escalate (calls Reddit's native APIs)
- Optional **draft moderator reply** generator — pastes Gemini-drafted message to the author with edit-before-send flow
- Moderator authorization re-verified at the API boundary on every action

**Configuration (per subreddit)**
- Moderation posture: strict / balanced / lenient
- Custom rules (the Reasoner cites them by number)
- Region / cultural context
- Investigation depth override (auto / fast / standard / deep)
- Per-subreddit Gemini API key (BYO billing)

**Operations**
- Per-subreddit Stats dashboard: investigations, alignment rate, recommendation mix, tier mix, total cost
- Modmail onboarding on install
- All data stored in Devvit-managed Redis, subreddit-scoped

---

## Architecture

```
Reddit triggers ──▶ Devvit app (TypeScript, Hono)
                      ├── In-process investigation engine
                      │    Strategy → Orchestrator → Tools → Reasoner → Validator → Calibrator
                      ├── Devvit Redis (managed, subreddit-scoped)
                      └── HTTPS → generativelanguage.googleapis.com (Gemini 2.5 Pro + Flash)
                                  │
                                  ▼
                      Verdict custom post (auto-removed to mod queue)
                                  │
                                  ▼
                      Moderator clicks an action → reddit.remove/approve/lock + optional reply
```

The engine runs in-process inside the Devvit app. No external backend, no domain approvals beyond Gemini (which is on Devvit's global allowlist). Per [ADR-0007](../docs/adr/0007-engine-inside-devvit-after-hf-rejection.md).

---

## Quick Start (for mods installing the published app)

1. Install ModPilot from the Reddit Apps directory.
2. Check modmail — you'll receive a setup message titled "👋 ModPilot is installed — finish setup in 2 minutes".
3. Open your subreddit's ⋯ menu → **ModPilot: Configure policy**.
4. Pick a moderation posture, paste your subreddit's rules, optionally add a region/cultural context.
5. (Optional but recommended) Paste your own Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey) so investigations bill to your account.
6. On any reported post or comment, click ⋯ → **Investigate with ModPilot**. Wait ~10 seconds for the verdict UI to open in your mod queue.

---

## Tech Stack

- **Devvit Web** (Hono + Vite) — Reddit's first-class app platform
- **TypeScript** — across the engine, store, and UI
- **Gemini 2.5 Pro** — Reasoner with structured output + thinking budget
- **Gemini 2.5 Flash** — Thread summarizer + moderator-response drafter (thinking disabled)
- **Devvit-managed Redis** — Subreddit-scoped persistence
- **Vitest** — 35-test deterministic suite covering priority / explainability / escalation / rule-match

---

## Development

```bash
cd devvit-app
npm install
npm run dev          # devvit playtest <your-subreddit>
npm run type-check   # tsc --build
npm run lint         # eslint
npm test             # vitest (35 deterministic tests)
npm run build        # vite build → dist/server/index.cjs + dist/client/
```

To upload an updated version to your published app:

```bash
npm run build
npx devvit upload    # bumps version
npx devvit publish   # submits to Reddit's review queue
```

For per-developer setup (Gemini key for the demo path):

1. Copy `src/config/geminiConfig.example.ts` → `src/config/geminiConfig.local.ts` (gitignored).
2. Paste your Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey).
3. The published app uses this as the fallback when an installing subreddit hasn't configured their own key.

---

## Project Structure

```
src/
├── index.ts              # Hono router mount
├── routes/
│   ├── menu.ts           # Investigate menu actions + verdict custom post
│   ├── menuConfigure.ts  # "Configure policy" form
│   ├── menuStats.ts      # "Stats" dashboard
│   ├── api.ts            # /api/verdict, /api/feedback, /api/draft-response, /api/send-response
│   ├── triggers.ts       # onAppInstall + onAppUpgrade + onCommentReport + onModAction
│   ├── forms.ts          # Form submit handlers
│   └── scheduler.ts      # Cron stubs
├── engine/               # In-process investigation engine
│   ├── pipeline.ts       # Strategy → Orchestrator → Reasoner → Validator → Calibrator
│   ├── strategy.ts       # FAST / STANDARD / DEEP tier selection
│   ├── loop.ts           # Orchestrator with budget enforcement + convergence
│   ├── accumulator.ts    # Evidence Accumulator with ev-N citation ids
│   ├── calibrator.ts     # Confidence Calibrator
│   ├── personalities.ts  # Strict / balanced / lenient presets
│   ├── priority.ts       # Priority Score
│   ├── explainability.ts # Author signal, confidence factors, key factors, rule match display
│   ├── escalation.ts     # Escalation level derivation
│   ├── ruleMatch.ts      # Substring rule-match precheck
│   ├── llm/              # gemini, reasoner, summarizer, validator, responseDrafter, keyResolver
│   ├── tools/            # reportVelocity, userHistory, priorActions, threadContext
│   └── store/            # subreddit, userMemory, threadMemory, velocity, investigation, stats
├── client/               # Verdict custom-post webview (HTML + JS + CSS)
├── services/             # dedup
├── config/               # geminiConfig.local.ts (gitignored)
└── ui/                   # Copy strings + design tokens
```

---

## Privacy & Terms

- [Privacy Policy](https://github.com/thejasrao262003/ModPilot/blob/main/docs/PRIVACY.md)
- [Terms & Conditions](https://github.com/thejasrao262003/ModPilot/blob/main/docs/TERMS.md)

Built for the Reddit Devvit hackathon. Open source — MIT licensed.
