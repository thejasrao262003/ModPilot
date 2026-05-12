# Glossary

> **Terminology authority.** Banned terms, preferred terms, and the internal→product translation table. Loaded for any user-facing copy, prompt, or doc change.
>
> **Status:** Canon. Changes require an ADR.

---

## 1. Banned Terms

Never use in user-facing code, UI, prompts, or docs:

`RL` · `reinforcement learning` · `policy` · `reward` · `training` · `episode` · `action space` · `observation space` · `value function` · `agent` · `trajectory`

These leak research-paper framing into a product surface. They also misrepresent what ModPilot does — there is no online learning, no reward signal, no policy gradient. The system investigates evidence; it does not optimize against a reward.

---

## 2. Translation Table (internal → product)

| Internal concept | Product term |
|---|---|
| Action space | Tool Registry |
| Observation space | Evidence Accumulator |
| Trajectory | Investigation Timeline |
| Reward signal | Confidence Calibration |
| Policy | Investigation Strategy |
| Scenario generator | Evaluation Harness |
| Multi-step reasoning | Adaptive Investigation |
| Inference call | LLM call |
| Backend service | Investigation Engine |

Backend is always **Investigation Engine**, never "AI backend" or "the model."

---

## 3. Preferred UI Vocabulary

Use these when describing what ModPilot does:

`investigation` · `evidence` · `confidence` · `strategy` · `recommendation` · `reasoning` · `memory` · `verdict` · `escalation` · `pattern` · `trust tier`

Two specific rules:
- **"Memory" never appears as a number.** Only tier labels: `new` · `trusted` · `neutral` · `watched`.
- **"Confidence" never appears as a bare percentage.** Always paired with a tier indicator (▲ HIGH, ● MEDIUM, ▼ LOW).

---

## 4. Risk Tiers

Three values only. Capitalized in prompts and API; titlecased or pill-styled in UI.

| Tier | Meaning | Calibrated confidence |
|---|---|---|
| **HIGH** | High likelihood of violation; reasoner confident | ≥ 0.80 |
| **MEDIUM** | Possible violation; senior judgment helpful | 0.60 – 0.80 |
| **LOW** | Insufficient evidence; ModPilot is unsure | < 0.60 |

LOW tier triggers the "honest uncertainty" UX — see [09-UX.md §6](09-UX.md).

---

## 5. Recommendation Verbs

Five values. No others. The Reasoner outputs one of these strings verbatim.

`REMOVE` · `APPROVE` · `ESCALATE` · `LOCK` · `NO_RECOMMENDATION`

`NO_RECOMMENDATION` is emitted only when confidence is LOW. It is never inferred elsewhere.

---

## 6. Tool Verb Map (UI-facing)

Internal tool names are `snake_case` and never appear in UI. The user-facing verb is past tense — the investigation already happened.

| Tool (internal) | UI verb |
|---|---|
| `policy_match` | Matched against rules |
| `report_velocity` | Checked report velocity |
| `user_history` | Pulled author history |
| `prior_actions` | Reviewed prior mod actions |
| `thread_context` | Read thread context |

---

## 7. Investigation Tiers

The Strategy Selector picks one per report.

| Tier | Use | Tool budget |
|---|---|---|
| **FAST** | Obvious spam, clear-cut rule breaks | 1–2 tools |
| **STANDARD** | Default tier | 4–5 tools |
| **DEEP** | Harassment, brigading, escalation patterns | 5+ tools, may re-loop |

---

## 8. People & Roles

| Term | Meaning |
|---|---|
| **Moderator** / **mod** | The human using ModPilot. The audience for every UI surface. |
| **Author** | The Reddit user whose content is being investigated. Never "the offender" or "the target." |
| **Reporter** | A user who filed a report. Always plural in copy unless count is known to be 1. |
| **Subreddit** | Not "sub" in formal copy. "Sub" is fine in casual contexts (settings labels, dashboard chrome). |

---

## 9. System Surfaces

| Term | What it refers to |
|---|---|
| **Verdict Card** | The one-glance triage card in the mod queue. Signature surface. |
| **Investigation Timeline** | The expandable forensic ledger below the Verdict Card. |
| **Mod Dashboard** | The custom-post overview with tiles + queue. |
| **First-Run Wizard** | The 3-step onboarding flow. |
| **Cold-start badge** | The green "learning" indicator visible until 50 feedback events. |
| **Evidence chip** | The `[ev-N]` pill that links a claim to a tool result. |
| **Confidence breakdown** | The 4-bullet calibration audit trail in the Timeline. |

---

## 10. Doc-Sync Rule

This file is canon. If a new term enters production copy or prompts, it lands here in the same PR. If you find a banned term in code, fix it; if you find one in this file, file an issue — it should not be here.

---

## 11. Related Documents

- [Specs.md §3](Specs.md) — the same terminology contract at higher altitude.
- [09-UX.md §13](09-UX.md) — accessibility + copy reading-level rules.
- [06-AILayer.md §4](06-AILayer.md) — prompt construction that respects this glossary.
- [CLAUDE.md](../CLAUDE.md) — defaults that point here.
