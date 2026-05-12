# 01 — Product

> **Purpose:** Anchor every product decision in a shared understanding of who ModPilot is for, what it does, what it deliberately doesn't do, and why it exists at all. When in doubt about scope, tone, or feature framing — this is the doc that settles it.
>
> **Status:** Canon. Static. Changes here require team-level alignment.

---

## 1. The Problem

Reddit moderation is broken at the investigation layer, not the classification layer.

Every experienced moderator follows roughly the same mental procedure when a report lands in their queue:

1. **Who is this user?** Open their profile, scan recent post/comment history, check karma trends, look for prior removals.
2. **What's the thread context?** Read the comment in situ, scroll up to see what was being responded to, scroll down to see how the conversation evolved.
3. **Which rule, if any, is being violated?** Cross-reference the subreddit's rule list against the content.
4. **Is this part of a pattern?** Are multiple reports landing on similar content? Is this user being brigaded? Is this user *doing* the brigading?
5. **What's our history with this user?** Have we removed their content before? Issued warnings? Approved despite reports?

This procedure takes a competent moderator roughly **60–120 seconds per report**, and it's almost entirely the same five steps every time. At scale — large subreddits process thousands of reports per week — this is the single largest sink of moderator time and cognitive load.

The investigation work is repetitive, mechanical, and exhausting. **The judgment call at the end is the only part that requires a human.** Everything before it is administrative overhead being performed by humans because no existing tool does it well.

This is the bottleneck ModPilot is built to remove.

---

## 2. Why Existing Tools Fail

The market is full of "AI moderation" tools, yet moderator burnout is at all-time highs. That contradiction has a cause: **everyone has been building the wrong layer.**

| Today's tool category | What it does | Why it doesn't solve the real problem |
|---|---|---|
| **AutoMod (regex rules)** | Pattern-matches text against static rules | No reasoning. No context. Every edge case becomes a new rule. Doesn't scale with subreddit nuance. |
| **Single-shot LLM classifiers** | Scores a comment "toxic / not toxic" in isolation | Ignores who said it, where, after what, with what history. Confidently wrong on context-dependent violations. |
| **Generic AI moderation bots** | Wraps GPT around moderation prompts | Opaque verdicts. Mods can't audit why. Builds distrust, not trust. |
| **The native mod queue** | Lists reports chronologically | Dumps work on the mod. Triage is entirely manual. No prioritization, no context, no synthesis. |
| **Manual investigation** | Mod opens 5 browser tabs per report | The status quo. Slow, repetitive, exhausting, and the cause of moderator burnout. |

The pattern is consistent: **every existing tool offloads classification but leaves investigation on the moderator's shoulders.** Investigation is 80% of the work and 100% of the cognitive load.

ModPilot's bet is that automating *investigation* — not classification — is where the real productivity gain lives.

---

## 3. The Thesis

> **Most moderation tools classify content. ModPilot investigates context.**

This is not a slogan; it's an architectural commitment.

ModPilot is built around a fundamentally different paradigm than every other tool in the space:

- **Existing paradigm:** `content → classify → score → act`
- **ModPilot's paradigm:** `report → investigate → reason → recommend → learn`

In our paradigm, classification is a byproduct. The actual product is the **adaptive investigation** that produces a verdict alongside its full evidence trail. The moderator's job becomes *reviewing evidence and making the call*, not *gathering evidence and making the call*.

Three commitments fall out of this thesis:

1. **Investigation is adaptive.** Obvious spam doesn't need the same depth as harassment. The system picks a tier (Fast / Standard / Deep) per report.
2. **Investigation is auditable.** Every verdict ships with its Investigation Timeline. No black boxes. Every claim cites evidence.
3. **Investigation augments judgment, never replaces it.** The moderator decides. Always. ModPilot never takes an action autonomously.

---

## 4. Positioning

### Tagline

> **The context-aware investigation engine for Reddit moderation.**

### One-Sentence Pitch

ModPilot runs the five lookups every experienced moderator does manually — user history, thread context, rule match, report patterns, prior actions — and hands you a verdict with the full evidence trail.

### One-Paragraph Pitch

Reddit moderators spend roughly a minute and a half per report doing the same five investigative lookups. AutoMod can't help — it's a regex engine. Generic AI bots classify in isolation and can't explain themselves. ModPilot is different: it's a context-aware investigation engine built on Devvit that does the repetitive investigation work for you and surfaces a verdict alongside its full reasoning trail. You decide. It just stops being repetitive. Built moderator-first. Human-in-the-loop by design. Auditable by default.

### What We Are Not

- We are **not** an autonomous moderation bot.
- We are **not** an AI replacement for human moderators.
- We are **not** a classifier.
- We are **not** a research project. (Despite being informed by concepts from our OpenENV Content Moderation work, ModPilot is a production engineering system.)

### Voice & Tone

- **Operational, not academic.** "Investigation Engine," not "AI backend." "Evidence Accumulator," not "observation space."
- **Confident about the product, honest about limits.** We're proud of what ModPilot does. We're also the first to surface when it doesn't know.
- **Moderator-first.** Every piece of copy, every UI string, every doc treats the moderator as the primary user and decision-maker.
- **No fearmongering, no hype.** We don't say "AI is moderating Reddit." We say "ModPilot does the lookups so you can make the call."

---

## 5. Personas

Three concrete moderator profiles drive every product decision. When weighing a tradeoff, the test is: *would this work for Sam, Maya, and Priya?*

### Solo Mod Sam — Small Community

- **Subreddit size:** ~5,000 subscribers
- **Role:** Sole moderator of a hobby/niche subreddit
- **Mod hours/week:** 3–5
- **Reports per day:** 5–20
- **Pain points:**
  - Every report feels like an interruption from real life
  - Investigates entirely by memory; no team to share context with
  - Worries about being inconsistent because they don't have time to research
- **Success criterion for ModPilot:**
  - Cuts per-report time from ~90s to under 15s
  - Doesn't require a complex setup or constant tuning
  - Surfaces enough evidence that Sam feels *more confident*, not less

### Mod Team Maya — Mid-Size Community

- **Subreddit size:** ~50,000 subscribers
- **Role:** Member of a 4-person mod team
- **Mod hours/week:** 10–15
- **Reports per day:** 50–150
- **Pain points:**
  - Inconsistent decisions across the team — same content treated differently by different mods
  - Repeat offenders slip through because mods don't share memory
  - The queue builds up faster than the team can handle it
- **Success criterion for ModPilot:**
  - Shared moderation memory means the team makes consistent calls
  - Repeat-offender history surfaces automatically
  - Prioritization triages the queue so urgent stuff hits the top

### Power Mod Priya — Large Community

- **Subreddit size:** 500,000+ subscribers
- **Role:** Lead mod of a large team (15+ moderators)
- **Mod hours/week:** 20+
- **Reports per day:** 500+ across the team
- **Pain points:**
  - Coordinated bad actors (brigading, sockpuppets, influence campaigns) are hard to detect manually
  - Onboarding new mods takes weeks of shadowing
  - Justifying mod decisions to angry users requires citing specific evidence
  - Cost concerns: any AI tooling has to be economical at this scale
- **Success criterion for ModPilot:**
  - Brigading and cross-user pattern detection are first-class features
  - Investigation Timeline becomes the audit trail when decisions get challenged
  - Cost per investigation stays low enough to handle thousands per day
  - Subreddit personality means ModPilot calibrates to *their* mod culture, not a generic one

---

## 6. Use Cases (Canonical Scenarios)

The 10 scenarios ModPilot must handle well. These drive the evaluation harness and the demo.

1. **Obvious spam** — Crypto/affiliate link, copy-paste pattern, throwaway account. Fast tier. Single-tool investigation. Verdict in under 1 second.
2. **Borderline self-promotion** — Established user, occasional self-link, gray area per subreddit norms. Standard tier. Calibration depends on subreddit personality.
3. **Harassment with escalation** — Personal attacks in a heated thread. Deep tier. Thread context + user history + escalation detection drive a high-confidence Remove recommendation.
4. **Coordinated brigading** — Multiple new accounts piling on a single user in a short window. Deep tier. Cross-user pattern detection surfaces the coordination.
5. **Misinformation in political subreddit** — Factually contested claim with high engagement. Standard or Deep tier depending on personality. Evidence trail is critical for justifying the call.
6. **Edge-case approval** — Comment looks bad in isolation but is actually a quote/critique. Standard tier. Thread context flips the recommendation from Remove to Approve.
7. **False-flag report** — Single report against a clearly fine comment, possibly retaliatory. Fast tier. Low-risk verdict; mod can dismiss with one click.
8. **Repeat offender** — User with prior removals posts something borderline. Memory layer surfaces history as a top evidence row. Subreddit personality determines threshold.
9. **Novel violation type** — Content that doesn't match existing rule patterns. Standard tier with low confidence. ModPilot says "I'm unsure" — no recommendation, just evidence.
10. **High-volume queue triage** — 50 reports waiting. ModPilot prioritizes by risk × velocity × user history, surfacing the urgent few at the top.

Each scenario has a corresponding entry in the evaluation harness (see `11-Evaluation.md`).

---

## 7. Non-Goals

Things ModPilot will **deliberately not do**, and why.

| Non-goal | Why we said no |
|---|---|
| **Autonomous moderation actions** | Erodes moderator trust; legally and culturally fraught; not what mods want. The human judgment call is sacred. |
| **Replacing human moderators** | The pitch is augmentation, not replacement. Anyone framing it otherwise is misreading the product. |
| **Cross-subreddit data sharing without consent** | Privacy and trust risk. Each subreddit's moderation memory stays within that subreddit unless an explicit federation feature is opted into in future. |
| **Real-name PII storage** | We store Reddit usernames where necessary; we never collect, store, or expose real-world identity data. |
| **Bypassing Reddit's content policies** | We respect Reddit's platform rules. ModPilot is a tool *for* moderators operating *within* Reddit's policy framework. |
| **A general-purpose content classifier API** | Scope discipline. ModPilot is for Reddit moderation. Reusing the engine for other use cases is a future-roadmap conversation, not an MVP one. |
| **Online RL training in production** | Operational complexity, debuggability cost, and judge-perception cost outweigh the benefit. Adaptation happens via feedback-weighted heuristics and nightly batch updates. |
| **Custom model fine-tuning UI for moderators** | Out of scope. Moderators configure via Personality presets and policy text, not by training models. |
| **Replacing AutoMod** | We coexist with AutoMod. AutoMod handles deterministic patterns; ModPilot handles judgment-required cases. |
| **Mobile-native moderator app** | Reddit's official mobile apps already serve this; we render through Devvit, which inherits native rendering. |
| **Real-time chat moderation** | Reddit's primary moderation surface is the report queue. Live chat moderation has different patterns and isn't where the time-saving win is. |

---

## 8. Success Criteria

How we know ModPilot works.

**Per-mod-action measurements:**

- Median time from "open report" to "take action" drops from ~90s to under 20s in the demo workflow.
- Investigation Timeline expansion rate >40% — moderators actively check the evidence, indicating engagement and trust.
- Override rate stable at 10–25% — high enough that mods are genuinely exercising judgment, low enough that recommendations are useful.

**Per-subreddit measurements:**

- After 30 days of use, mods report (qualitatively) reduced cognitive load.
- After 60 days, mod decision consistency (variance across team members on similar reports) measurably tightens.
- After 90 days, cold-start protections gracefully relax as the system calibrates to the subreddit.

**System measurements:**

- Median investigation latency under 5 seconds, p95 under 10 seconds.
- Per-investigation cost under $0.02 at Standard tier, under $0.05 at Deep tier.
- Engine availability target: 99.5%. When unavailable, Reddit's native mod queue continues working normally.

**For the hackathon submission specifically:**

- Install-to-first-investigation under 3 minutes.
- Verdict Card + Investigation Timeline visibly polished — the 30-second judge impression lands.
- Demo includes the "I'm unsure" moment — at least one Verdict where ModPilot honestly surfaces low confidence.
- Submission tells the contrast story (classify vs investigate) in the first 30 seconds.

---

## 9. Out of Scope for MVP (Roadmap)

Features that belong in the product narrative but are explicitly cut from the 14-day MVP:

- **Online learning loops** — adaptation happens via nightly batch feedback updates only.
- **Cross-subreddit federation** — moderation memory shared across opted-in subreddits.
- **Brigade detection across subreddits** — currently single-subreddit only.
- **Slack / Discord webhook integrations** — pings mod teams when high-risk reports land.
- **Custom rule pack marketplace** — community-shared rule packs and personalities.
- **Mod onboarding mode** — guided walkthroughs for new mods using ModPilot's investigation as training.
- **Multi-language reasoning** — MVP is English-only; non-English subreddits are a future expansion.
- **Public moderator transparency reports** — auto-generated subreddit transparency dashboards from the audit log.

These belong on the roadmap slide, not in the MVP backlog.

---

## 10. Pillars of Differentiation

The five things ModPilot does that nothing else in the space does:

1. **Adaptive Investigation Depth** — Strategy Selector picks Fast / Standard / Deep per report. Cost-aware, latency-aware, accuracy-preserving.
2. **Investigation Timeline** — Every recommendation expands into a transparent reasoning trail. The signature UI feature.
3. **Moderation Memory** — Longitudinal state per user / thread / subreddit. The system grows more useful over time.
4. **Subreddit Personalities** — Per-subreddit adaptation across investigation depth, confidence thresholds, escalation policy, and reasoning tone.
5. **Investigative Transparency** — Evidence-citation contract enforced at the prompt and validation layer. No verdict without auditable evidence.

When prioritizing features, work on a Pillar before working on anything else.

---

## 11. Product Principles (Decision Rules)

When facing a tradeoff, apply these in order:

1. **Does this preserve human-in-the-loop?** If no, stop. Redesign.
2. **Does this make the investigation more transparent or less?** Always pick more transparent.
3. **Does this respect the moderator's expertise?** Augment judgment; never override it.
4. **Does this scale economically?** Production deployment matters from Day 1.
5. **Does this work in cold-start?** New installs are a first-class case, not an afterthought.
6. **Does this fail gracefully?** If the component breaks, does the mod queue still work?
7. **Does this build or burn trust?** Honest uncertainty > confident wrongness, every time.

---

## 12. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — How the product is architected to deliver on this vision.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — How investigation actually works.
- [`05-Memory.md`](05-Memory.md) — Moderation memory, personalities, cold-start.
- [`09-UX.md`](09-UX.md) — How the product surfaces to moderators.
- [`11-Evaluation.md`](11-Evaluation.md) — How we validate against the canonical use cases.
- [`15-Hackathon.md`](15-Hackathon.md) — How we tell the product story for the submission.
- [`Glossary.md`](Glossary.md) — Terminology rules, especially the banned-words list.