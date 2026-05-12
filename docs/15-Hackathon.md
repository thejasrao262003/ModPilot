# 15 — Hackathon

> **Purpose:** Everything for the submission and demo. Demo script, submission checklist, judging criteria mapping, backup plan, App Directory listing. Load in the final week of the sprint.
>
> **Status:** Evolves until submission; then frozen.

---

## 1. Submission Goal

> Hand judges a tool that feels like it could be installed on a real subreddit tomorrow.

Three things judges remember from a 5-minute demo:
1. **The contrast** ("classify vs investigate").
2. **The Investigation Timeline** (the signature visible moment).
3. **The "I'm unsure" moment** (the trust play).

If those three land, we win the impression battle. Everything else is in service of those three.

---

## 2. Judging Criteria Map

Each criterion mapped to features that satisfy it, where it's shown in the demo, and what the README emphasizes.

| Criterion | Features | Demo position | README emphasis |
|---|---|---|---|
| **Community impact** | Cuts mod time from 90s→20s per report; reduces burnout | 0:00–0:20 cold open, 4:15 analytics | The Problem section, time-saved tile |
| **Moderator time savings** | Adaptive depth, evidence-trail UI, prioritized queue | 1:30 signature moment, 4:15 analytics | Time-saved calculation in Quickstart |
| **Reliable UX** | Graceful degradation, cold-start safety, kill switch, honest uncertainty | 3:00 uncertainty moment, mentioned at 4:45 | Design Principles section |
| **Publish-ready polish** | First-Run Wizard, design tokens, empty/error states, real numbers | 0:30–1:30 install flow | Screenshots, polished tagline |
| **Broad moderator usefulness** | Subreddit personalities, three preset personas, all subreddit sizes | 4:15 personality switch | Personas in product doc |
| **App Directory installability** | Devvit app properly scoped, settings UX, ≤3min onboarding | 0:30 install flow | Install section |
| **Ease of configuration** | First-Run Wizard, personality presets, rule pasting | 0:30–1:30 install | Quickstart screenshots |
| **Measurable moderation improvement** | Analytics dashboard, audit log, ModPilot accuracy metric | 4:15 analytics tile | Time-saved tile description |

When prepping the demo, ask: *which criterion does this beat cover?* If a beat doesn't cover one, replace it.

---

## 3. The 5-Minute Demo Script

Practiced to muscle memory. 10+ rehearsals minimum before submission.

### 3.1 Beat-by-Beat

| Time | Beat | What's on screen | Narration |
|---|---|---|---|
| 0:00–0:20 | **Cold open: the contrast** | Reddit mod queue with reports piling up | "Reddit moderators spend ~90 seconds per report doing the same five lookups. AutoMod can't help — it's a regex engine. Generic AI bots classify content in isolation and can't explain themselves. We built ModPilot: the first context-aware investigation engine for Reddit moderation." |
| 0:20–1:30 | **Install in 90 seconds** | App Directory → install → wizard | "Install from the App Directory. Three-step wizard: pick a personality (Balanced for this sub), paste your rules, set your region. Run a test investigation to see ModPilot work immediately. Done in under three minutes." |
| 1:30–3:00 | **The signature moment** | Mod queue with Verdict Card → click expand Timeline | "Open the queue. ModPilot has already investigated. High risk; recommends Remove; 92% confidence. Click 'View reasoning'. There it is: pulled the user's history — three prior removals. Read the thread context — escalation detected at turn 8. Matched against Rule 2. Each step took milliseconds. Every claim cites the evidence. Click Remove. Done — five seconds of attention, not five minutes." |
| 3:00–3:45 | **The uncertainty moment** | Open a borderline case → LOW confidence | "Now a harder case. 54% confidence. ModPilot says 'I'm unsure — your call' and just surfaces the evidence. No false confidence. No black box. The moderator decides. This is the moment that builds trust." |
| 3:45–4:15 | **Memory + cost** | Click a repeat user → memory view; analytics tile | "ModPilot remembers per subreddit. This user has three prior incidents — surfaced automatically. And economically: 47 investigations today, median 3 seconds, total cost 31 cents. ModPilot is built to run at scale." |
| 4:15–4:45 | **Subreddit personalities** | Same report → flip Balanced → Strict | "Same report. Switch from Balanced to Strict personality. Threshold for action shifts visibly. r/AskHistorians and r/dankmemes don't moderate the same way — and ModPilot doesn't either." |
| 4:45–5:00 | **Close** | ModPilot logo + tagline | "Most moderation tools classify content. ModPilot investigates context. Built moderator-first. Human-in-the-loop by design. Auditable by default. The future of moderation tooling is human-led and context-aware. Thank you." |

### 3.2 Narration Principles

- **Don't over-explain.** Let the Timeline speak for itself at 1:30. Pause and let judges read.
- **Use concrete numbers.** "47 investigations, 31 cents, 3 seconds" beats "fast and cheap."
- **Never apologize.** Even if something glitches, keep moving. Confidence sells.
- **Tagline lands first and last.** "Classify vs investigate" opens and closes.
- **No jargon.** Avoid "orchestrator," "calibrator," "tier" in narration. Say "ModPilot picks how deep to investigate."

### 3.3 What Not to Do in the Demo

- Don't show internal architecture diagrams. Judges don't want a system tour.
- Don't show code. Keep it product-facing.
- Don't apologize for what isn't built. Stay in the present tense about what works.
- Don't mention RL, OpenENV, or research framing.
- Don't read out the rationale text. The screen does that.

---

## 4. Demo Subreddit Setup

The demo runs against a pre-configured subreddit. Treat as production data; rehearse against it.

### 4.1 Subreddit

- **Name:** `r/modpilot_demo_<unique>` (or whichever the team owns).
- **Visibility:** Restricted; only team + judges (during scoring window) can view.
- **ModPilot installed:** Yes, pre-configured to Balanced personality, US region, with realistic rules pasted in.

### 4.2 Seeded Content

Pre-seed the subreddit with 8–10 reports that exercise each demo beat. Use realistic-looking (synthetic) content. Variety:

| Report | Demo beat | Expected verdict |
|---|---|---|
| Spam link in a hobby comment | Skipped past; just shows the queue priority | FAST / REMOVE |
| Harassment in a heated thread | The 1:30 signature moment | STANDARD / REMOVE / 92% |
| Borderline self-promo | The 3:00 uncertainty moment | STANDARD / NO_ACTION / 54% |
| Repeat offender (set up memory) | The 3:45 memory view | STANDARD / REMOVE / mentions priors |
| Generic angry comment | Reserve case in case of glitch | STANDARD / mid conf |

### 4.3 Pre-Investigation

Run all reports through ModPilot before the demo so verdicts are already in the queue. We're showing a *moderator's daily experience*, not "what happens when a report fires." Pre-warm.

### 4.4 Reset Script

`scripts/seed_demo_subreddit.py` is a one-command reset:
- Clears any actioned items.
- Re-seeds the canonical 8–10 reports.
- Triggers fresh investigations.
- Verifies all expected verdicts present.

Run before every rehearsal. Run one final time 30 minutes before the live demo.

---

## 5. Backup Video Plan

Live demos break. Have a recorded fallback that's just as compelling.

### 5.1 Recording Strategy

- **Format:** 1080p, 60fps screen recording. Voiceover added in post.
- **Length:** 4:30 (slightly tighter than live 5:00 to leave room for natural pauses).
- **Audio:** clean voiceover; no live narration over screen audio.
- **Cuts:** minimal. Aim for the demo to feel real, not over-produced.

### 5.2 Editing Checklist

- Title card: ModPilot logo + tagline.
- Lower-third captions for key numbers ("87% acceptance rate", "$0.31 cost").
- Subtle highlight overlay on the Investigation Timeline expansion (signature moment).
- End card: tagline + App Directory link + team credit.

### 5.3 Hosting

- Upload to YouTube (unlisted) and Loom (backup).
- Embed both links in the submission.
- Embed a GIF (first 10 seconds + signature moment) in the README.

### 5.4 When to Use

- **Default in submission video field.** Submit the recording.
- **Live demo only as bonus** if judging has a live Q&A round.

---

## 6. App Directory Listing

The listing is the front door. Words matter; assets matter more.

### 6.1 Listing Copy

**Name:** ModPilot

**Tagline:**
> The context-aware investigation engine for Reddit moderation.

**Short description (one line, shows in directory):**
> Adaptive investigation that runs the five lookups every mod does manually, then hands you a verdict with full reasoning.

**Long description:**

> Most moderation tools classify content. ModPilot investigates context.
>
> When a report arrives, ModPilot runs the lookups every experienced moderator does manually — user history, thread escalation, rule match, report patterns, prior actions — then surfaces a verdict alongside the full evidence trail. You decide. It just stops being repetitive.
>
> Key features:
> - **Adaptive investigation depth.** Obvious spam gets a fast pass. Harassment gets a deep dive. ModPilot picks the right level per report.
> - **Investigation Timeline.** Every recommendation expands into a transparent reasoning trail. No black-box verdicts.
> - **Honest uncertainty.** When ModPilot isn't sure, it says so — surfaces evidence without recommending action.
> - **Moderation memory.** Longitudinal state per user, thread, and subreddit. Repeat offenders and escalation patterns surface automatically.
> - **Subreddit personalities.** Strict, Balanced, or Lenient. r/AskHistorians and r/dankmemes don't moderate the same way; ModPilot adapts.
> - **Cold-start safety.** Conservative thresholds and a visible "learning" badge while ModPilot calibrates to your subreddit.
> - **Human-in-the-loop.** No autonomous actions. Ever. The moderator always decides.
>
> Built moderator-first. Auditable by default.

### 6.2 Required Assets

- **Icon:** 512×512 PNG, the ModPilot mark.
- **Hero image:** 1200×630 PNG showing the Verdict Card.
- **Screenshots:** 5–7, in order of impact:
  1. Verdict Card with HIGH risk
  2. Investigation Timeline expanded
  3. Uncertainty UX (LOW confidence)
  4. Dashboard with analytics
  5. First-Run Wizard
  6. Memory view modal
  7. Settings page (showing personality presets)

### 6.3 Categories / Tags

- Primary: Moderation
- Secondary: AI Tools, Analytics

### 6.4 Permissions Justification

Lifted from `03-Devvit.md` Section 10. Every scope explained.

---

## 7. Submission Checklist

Final checklist for the submission form. Walk through this the day before submitting.

### 7.1 Code

- [ ] All MVP features from `01-Product.md` Section 9 work end-to-end.
- [ ] Demo subreddit pre-configured and seeded.
- [ ] No `TODO(open-question)` markers left in user-facing code paths.
- [ ] No banned terminology in user-facing strings (run grep against `Glossary.md`).
- [ ] All eval scenarios passing (`make eval-gate`).
- [ ] CI green on `main`.

### 7.2 App Directory

- [ ] Devvit app published to App Directory.
- [ ] Listing copy reviewed by team.
- [ ] All required assets uploaded.
- [ ] Permissions justified in listing description.
- [ ] Install flow tested from a fresh moderator account.
- [ ] First-Run Wizard completes in under 3 minutes for someone who hasn't seen it.

### 7.3 Demo

- [ ] Live demo rehearsed at least 10 times.
- [ ] Backup video recorded, edited, hosted (YouTube + Loom).
- [ ] GIF embedded in README.
- [ ] Demo subreddit reset script run.
- [ ] Demo accounts (mod and observer) verified.

### 7.4 Repository

- [ ] README is the polished version with the contrast story up top.
- [ ] All 18 docs present and reviewed.
- [ ] License file present.
- [ ] `.env.example` files current.
- [ ] No secrets in git history (verify with `gitleaks` or equivalent).
- [ ] Repo tagged with submission version (`v1.0-hackathon`).

### 7.5 Submission Form

- [ ] Project name: ModPilot
- [ ] Tagline matches App Directory
- [ ] Demo video link works (test in private browser)
- [ ] App Directory link works
- [ ] GitHub repo link works
- [ ] Team members listed
- [ ] Acknowledgements: OpenENV Content Moderation as concept source
- [ ] Categories selected: Moderation Tools

### 7.6 The Final 24 Hours

- [ ] Re-run the full demo end-to-end against the production deploy.
- [ ] Test the App Directory install flow one more time.
- [ ] Verify Engine health (`/v1/ready` returns OK).
- [ ] Verify cost caps are configured correctly so a brigade can't blow the budget mid-demo.
- [ ] Confirm someone on the team has admin access to the demo subreddit during judging.
- [ ] Get sleep.

---

## 8. README Polish

The README is judge-facing. It runs alongside the App Directory listing.

### 8.1 Required Sections

In order:
1. Hero (tagline + 1-paragraph pitch + GIF)
2. The Problem
3. How It Works (cognition diagram)
4. What Makes ModPilot Different (contrast table)
5. Key Features (the five pillars)
6. Quickstart (install + try it)
7. Architecture (high-level diagram)
8. Documentation (links into `docs/`)
9. Design Principles (the trust commitments)
10. Status (hackathon build)
11. Acknowledgements (OpenENV)
12. License

Already drafted in the project's root `README.md`. Final polish in the last 48 hours focuses on:
- The hero GIF (must be punchy; show signature moment).
- Screenshot freshness (match current UI exactly).
- Link verification (no 404s).

### 8.2 The Hero GIF

The single most important visual asset. Show:
- 0:00–0:02: empty mod queue
- 0:02–0:05: Verdict Card appearing
- 0:05–0:10: Investigation Timeline expanding
- 0:10–0:12: action click + resolved state

Loop seamlessly. Under 3MB. Hosted in the repo.

---

## 9. Story Talking Points

For Q&A, panel discussion, or short conversations with judges between demos.

### 9.1 The Elevator Pitch (30 seconds)

> "Reddit moderators spend a minute and a half per report doing the same five lookups manually. AutoMod can't help — it's a regex engine. Generic AI bots classify content in isolation and can't explain themselves. ModPilot is different: it's a context-aware investigation engine that does the lookups, shows its work, and hands the moderator a recommendation with the full evidence trail. The moderator decides; ModPilot stops the repetitive part. Most moderation tools classify content. ModPilot investigates context."

### 9.2 If Asked: "How Is This Different From <Existing Tool>?"

- **AutoMod:** AutoMod is rules. It can't reason about context. ModPilot reasons.
- **Generic AI moderation bot:** Those classify content in isolation. ModPilot investigates the situation — user history, thread context, prior actions — and shows its work.
- **A GPT wrapper:** ModPilot is built around an evidence-citation contract. Every claim cites a specific piece of evidence. It's auditable. It's not a chatbot answering questions; it's an investigation engine producing structured verdicts.

### 9.3 If Asked: "How Do You Prevent Hallucination?"

> "Three layers. First, the prompt instructs the model that every claim must cite an evidence ID. Second, after generation we validate every citation against the evidence accumulator — hallucinated IDs fail validation. Third, on validation failure we demote confidence and surface it in the UI. The system fails closed: if it can't ground a claim in evidence, the verdict is marked low-confidence and the moderator decides."

### 9.4 If Asked: "How Does It Adapt?"

> "Three adaptive systems. Investigation depth — Fast, Standard, or Deep — picked per report based on risk signals. Subreddit personalities — Strict, Balanced, or Lenient — that affect when ModPilot recommends action. And feedback-weighted heuristics that tune to each subreddit's actual moderation style over time. We do not train models. We adapt through configuration and feedback. It's debuggable, explainable, and auditable."

### 9.5 If Asked: "Why Not Automate the Action?"

> "Because moderator trust is the entire product. Every other piece of the system serves the trust commitment. Auto-actions erode trust the moment they get something wrong. Our bet — and we think it's the right one — is that augmenting moderator judgment beats replacing it. Mods aren't asking us to replace them. They're asking for the repetitive work to disappear so they can focus on the judgment calls. That's what we built."

### 9.6 If Asked: "What's Next?"

> "Cross-subreddit pattern detection for coordinated brigading, Slack and Discord integrations for mod teams, multi-language reasoning, and an audit-log export for mod transparency reports. We have a clear roadmap. The MVP nails the core investigation loop and ships it production-ready."

---

## 10. Risk & Contingency

What could go wrong and what we do.

| Risk | Mitigation | Contingency |
|---|---|---|
| Live demo glitches | Pre-recorded backup video | Switch to backup mid-demo if needed |
| Engine down during judging | Cost caps + graceful degradation | Mod queue still works; show recovery in the demo |
| Devvit platform issue during judging | None — outside our control | Use the backup video |
| LLM provider degraded | Fallback verdicts | Show the fallback in the demo as a feature |
| Demo subreddit accidentally moderated by Reddit | Pre-emptive Reddit support ticket | Spin up backup demo subreddit |
| Judging happens in a different time zone than expected | Schedule check 48h before | Recorded demo handles it |
| Team member sick on demo day | Each demo step practiced by multiple people | Sub in |

---

## 11. Stretch Polish (If Time Allows)

In priority order. Cut from the bottom as the deadline approaches.

1. **Smoother loading states** — skeleton shimmer on the Verdict Card while investigating.
2. **Animation polish** — smoother Timeline expand.
3. **Sound design** in the backup video — subtle ambient.
4. **README hero image** — designer-touched if a designer is on the team.
5. **A second demo video** — 90-second teaser for social.
6. **Onboarding email/DM** sent to first installs (post-MVP feature; could ship as a stretch).

Don't sacrifice the must-haves for these. The list exists so we know what to defer.

---

## 12. After Submission

### 12.1 Within 24 Hours

- Tag the submission commit (`v1.0-hackathon-submission`).
- Freeze main; new work goes on `post-hackathon` branch.
- Capture metrics: install count from App Directory, eval gate status, latency / cost numbers from prod.
- Write a one-paragraph retrospective for the team.

### 12.2 Judging Window

- Monitor the demo subreddit. Be available for judge questions.
- Don't push changes during the judging window. Stable >>> new.
- Engine health checked every few hours.

### 12.3 Win or Lose

- Open-source moment: regardless of outcome, the architecture, docs, and Engine are well-built artifacts.
- Engage with feedback. Judges' written notes are gold.
- Decide post-hackathon: continue developing, or freeze for portfolio. Don't decide before submission.

---

## 13. Related Documents

- [`01-Product.md`](01-Product.md) — Vision, positioning, the personas judges should imagine.
- [`02-Architecture.md`](02-Architecture.md) — Architecture for the README diagram.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — The signature moment's substrate.
- [`09-UX.md`](09-UX.md) — Every UI surface in the demo.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Trust talking points.
- [`11-Evaluation.md`](11-Evaluation.md) — The "we regression-test" defense.
- [`12-Analytics.md`](12-Analytics.md) — The numbers in the analytics moment.
- [`Glossary.md`](Glossary.md) — Banned terms; preferred phrasing for narration.