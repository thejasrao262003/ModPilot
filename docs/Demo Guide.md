# ModPilot — End-to-End Demo Guide

A copy-paste-ready walkthrough for recording the hackathon submission. Designed for a 3–5 minute video that surfaces every shipped feature. Test content + sample community guidelines included.

---

## 0. Pre-Demo Setup (one-time, 5 minutes)

Do this once before recording. Don't film this.

**Pre-flight checklist:**

```bash
cd devvit-app
npm install                    # if you haven't already
npm run type-check && npm test # sanity
npm run build
npx devvit upload              # publishes the latest version
```

**Create the test subreddit:**

1. Reddit → **+ Create a community** → name it `r/ModPilotDemo` (or any unused name).
2. Make yourself a moderator (you are by default since you created it).
3. Note the exact slug for the playtest command.

**Start the playtest pointed at your demo sub:**

```bash
npx devvit playtest <YourDemoSub>
```

Wait for `✓ Playtest ready`. Watch the terminal for:
```
modpilot.install { subreddit: '<YourDemoSub>' }
modpilot.install.modmail_sent { subreddit: '<YourDemoSub>' }
```

**Create the four test posts** (instructions in §3). The video then becomes a smooth walkthrough of the verdict UI without "waiting for content" dead air.

---

## 1. Setup Walkthrough (filmable, 30s)

**Open shot — the install signal:**

1. Open `https://www.reddit.com/r/<YourDemoSub>/` in a browser.
2. Click **Mod Tools** → **Mod Mail**.
3. Show the inbox containing:
   > 👋 **ModPilot is installed — finish setup in 2 minutes**
4. Open the message. Show the 6-bullet onboarding text that points to "Configure policy" and "Stats".

**Voice-over hook:**
> *"When a subreddit installs ModPilot, the mod team gets a one-time setup message in modmail. Two-minute onboarding, no separate dashboard, no logins."*

---

## 2. Configure Subreddit Policy (filmable, 60s)

**Camera shot:**

1. Go back to the subreddit's main page.
2. Click the **⋯ kebab menu** in the top-right (next to "Joined" / community icon).
3. Pick **ModPilot: Configure policy**.

**Paste these into the form** (copy-paste-ready — open this doc on a second monitor):

```
Moderation posture: Strict

Subreddit rules:
Rule 1: No personal attacks on other users or public figures.
Rule 2: No bad-mouthing the sport of cricket itself.
Rule 3: No abuse, insults, or character attacks directed at any cricket player.
Rule 4: Stay on topic — posts must relate to cricket.
Rule 5: No spam, affiliate links, or self-promotion without mod approval.

Region / cultural context: India, Australia, England — cricket-passionate audience

Investigation depth override: Auto
```

Click **Save**. Show the toast confirming `Saved · strict · tier=auto · 287 chars of rules`.

**Voice-over hook:**
> *"The moderation team configures their community's posture — strict, balanced, or lenient — plus the rules in plain English. ModPilot will use these as context on every investigation, and the LLM Reasoner will cite specific rules in its recommendations."*

---

## 3. Test Posts to Create (in the demo sub)

Submit these from **a separate test account** (e.g. an alt). Use simple text posts. The Reasoner will see each one's title + body.

### Post A — clear rule violation (REMOVE target)

**Title:** `Honest opinion`
**Body:**
```
I hate Virat Kohli. He's overrated trash. Cricket is a stupid, horrible sport and anyone watching it is wasting their life.
```

> Hits Rule 2 (bad-talk about cricket), Rule 3 (abuse toward player), Rule 1 (personal attack vibe).

### Post B — borderline content (NO_RECOMMENDATION target)

**Title:** `Tough day for Kohli`
**Body:**
```
Virat had a rough innings today — struggled with his timing against the short ball. Not his best form. Hoping he bounces back next match.
```

> Specific criticism without abuse. Engine should weigh this as ambiguous → low confidence or APPROVE.

### Post C — clearly fine (APPROVE target)

**Title:** `Incredible slip catch by Kohli`
**Body:**
```
That diving slip catch by Kohli to dismiss Smith was insane. One of the best catches I've seen this season. What a player.
```

> Positive, on-topic, no rule violations. Should be APPROVE with reasonable confidence.

### Post D — spam (REMOVE target)

**Title:** `Free 1000 crypto tokens for cricket fans!`
**Body:**
```
Hey cricket lovers! Visit cryptocricketairdrop dot com and claim your free 1000 IPL-tokens before they run out. Limited offer — DM me for invite codes!
```

> Hits Rule 5 (spam/affiliate). Should be high-confidence REMOVE.

### Post E — personal attack in comments (use as comment target)

**Comment under any post (made by alt account):**
```
You're an absolute moron. Anyone who defends Kohli has no idea what cricket is. Brain-dead take.
```

> Hits Rule 1 (personal attacks). Comment-level investigation.

---

## 4. Investigation Walkthrough (filmable, 90s — the headline section)

This is your money shot. Each post showcases different panels.

### 4.1 Investigate Post A (REMOVE)

1. Open Post A on Reddit.
2. Click ⋯ on the post → **Investigate with ModPilot**.
3. Wait ~10s. Devvit navigates you to a new custom post in the mod queue titled `🛡 ModPilot · REMOVE · NN% · Honest opinion`.
4. Open the verdict post.

**What to point out on camera, in order:**

1. **🔥 Urgent priority pill** (header, right side) — Feature 1
2. **🔥 Escalating Conversation banner** — Feature 5 (if thread_context engaged)
3. **⚠️ Repeat Offender** or **✓ First-Time Author** banner — Feature 2 + 7
4. **Confidence percentage + tier band** — core feature
5. **"What most influenced this"** panel — Feature 8 — should show "Strong rule match · HIGH" and "Report pressure · MEDIUM"
6. **"Potential rule matches"** panel — Feature 6 — Rule 2 + Rule 3 with score bands
7. **"Why confidence is what it is"** panel — Feature 4 — ▲ Strong rule match · ▼ New subreddit
8. **Evidence chips** [ev-1] [ev-2] [ev-3] in the rationale
9. **Investigation Timeline** (click "View reasoning") — every tool run + the Reasoner verdict block

**Voice-over hook:**
> *"Every recommendation expands into its full Investigation Timeline. Every claim cites a specific evidence row. Confidence calibration is transparent — you see exactly which signals pushed it up or down. No black boxes."*

### 4.2 Investigate Post B (uncertain)

Same flow on Post B.

**What to point out:**
- **ℹ️ Low Risk** priority pill
- **🌱 ModPilot is unsure — your call** marginalia (since confidence < 60%)
- "Honest uncertainty" copy: *"No action pre-selected. Evidence is mixed; your judgment matters here."*
- Confidence factors panel lists multiple `▼ reduced` reasons

**Voice-over hook:**
> *"When the evidence is genuinely mixed, ModPilot says so. No false confidence."*

### 4.3 Investigate Post C (APPROVE)

**What to point out:**
- **✓ First-Time Author** or **✓ Positive History** banner — Feature 7
- "Key factors" panel skews `positive` direction
- Recommendation: APPROVE
- No escalation banner

**Voice-over hook:**
> *"Equally important: ModPilot helps moderators approve when appropriate. False positives erode community trust as much as missed removals."*

---

## 5. Response Generator (filmable, 75s — the wow moment)

Back on Post A's verdict UI.

1. Click **Remove**.
2. **Modal opens**: "REMOVE · draft a response (optional)".
3. **Paste this into the guidance box:**
   ```
   Be firm but respectful. Explain that Rule 2 and Rule 3 don't allow this. First offense — no ban, just a clear warning that next time may lead to removal of all future posts.
   ```
4. Click **Generate draft**.
5. Wait ~3s. The modal shows:
   - **Subject** field (auto-filled, e.g. "Your post has been removed")
   - **Body** field (60–160 words explaining Rule 2 violation, citing the rule by number, respectful tone)

6. **Edit the draft if needed** (show that you can — change a word, fix tone).
7. Click **Take action + send reply**.
8. Wait ~2s. Status shows: `REMOVE applied · reply sent (t1_...)`.

**Verify on Reddit (split-screen if possible):**

1. Refresh Post A on Reddit. It now shows `[removed]`.
2. Open the comment thread. ModPilot has posted the moderator-drafted reply as a comment.

**Voice-over hook:**
> *"After clicking Remove, ModPilot can optionally generate a draft message for the author — grounded in the actual rules, calibrated to subreddit personality, respecting the moderator's freeform guidance. The moderator reviews and sends. Never auto-sent. Every word is reviewed."*

### 5.1 Alternate guidance examples to show variety

If you want to record multiple draft variations, try these instructions:

- *"Be polite. Don't sound harsh. Explain Rule 2."*
- *"Tell them clearly that future violations may lead to removal of all their posts."*
- *"Don't penalize this user this time — they're new. Just warn them."*
- *"Match a community-friendly tone. Reference Rule 3 but stay warm."*

Each one produces a measurably different draft. Great for showing the freeform-instructions layer.

---

## 6. Stats Dashboard (filmable, 30s)

After investigating 3–4 posts:

1. Subreddit → ⋯ kebab → **ModPilot: Stats**.

**What's on screen:**

- **Investigations: 4**
- **Average calibrated confidence: NN%**
- **Average latency: ~10s**
- **Total LLM cost: ~$0.01**
- **Recommendation mix: REMOVE: 2 · APPROVE: 1 · NO_RECOMMENDATION: 1**
- **Tier mix: STANDARD: 3 · DEEP: 1**
- **Alignment rate: 100% (4/4 mod actions)** — if you actioned each verdict aligned with the recommendation
- **Mod actions taken: REMOVE: 2 · APPROVE: 1 · ...**

**Voice-over hook:**
> *"Every action feeds back into per-subreddit stats — investigation count, alignment rate between ModPilot's recommendations and the moderator's actual decisions, total cost. The whole loop is auditable."*

---

## 7. Submission Talking Points (script for voice-over)

A tight 60-second pitch covering the headline contrast.

### Opening hook
> *"Reddit moderators spend 60 to 120 seconds per report — opening profiles, scrolling threads, cross-referencing rules, checking patterns. Every existing AI moderation tool tries to classify content. None of them investigate. ModPilot is different."*

### The architecture
> *"When a report lands, ModPilot runs the five lookups an experienced mod does manually — user history, thread context, rule match, report patterns, prior actions. Gemini 2.5 Pro reasons over the evidence, with a strict citation contract: every claim must cite a specific evidence row. Confidence is calibrated honestly — cold-start subs see lower numbers, strong rule matches see higher."*

### The differentiators
> *"Five things nothing else in the space does:*
> - *Adaptive investigation depth — Fast for obvious spam, Deep for harassment*
> - *Investigation Timeline — every recommendation expands into its reasoning trail*
> - *Moderation memory — per-user, per-thread, per-subreddit, accumulating with every action*
> - *Subreddit personalities — strict, balanced, lenient, tuned per community*
> - *Citation contract — enforced at the validator, not as a vibe*
> *Plus, after action, ModPilot can draft the moderator's reply — grounded in the actual rules. Never sent without explicit moderator approval."*

### The closer
> *"Human-in-the-loop, mandatory. The moderator decides, always. ModPilot just stops the lookups from being repetitive."*

---

## 8. Filming Checklist

Before you hit record:

- [ ] Playtest is running (`✓ Playtest ready`)
- [ ] Demo subreddit exists, you're a moderator
- [ ] Policy is configured (Rule 1–5 above pasted in)
- [ ] All 4–5 test posts created from an alt account
- [ ] Browser zoomed in for legibility (Cmd+= a few times)
- [ ] Devvit playtest terminal visible in a corner of screen (optional but powerful — shows the live `reasoner.response` logs)
- [ ] Microphone test
- [ ] Practice run through §1–6 once silently to nail the timing

Total filming time: **3–4 minutes** if you don't pause. Plan for 1–2 takes per section.

---

## 9. Test Queries / Edge Cases to Show Variety

If your video runs short, here's spare content to add depth.

### Show that personality actually matters

Re-run **ModPilot: Configure policy** → change personality from **strict** to **lenient**. Re-investigate Post B (the borderline one).
- Strict version: tends toward LOW conf removal
- Lenient version: tends toward APPROVE

### Show the Investigation Timeline depth

On any verdict post, click **View reasoning** to expand the right-hand panel:
- Each tool row: tool name + status glyph + latency + evidence id
- Reasoner verdict block: full rationale with `[ev-N]` citation chips, model name, token counts, cost
- Click any `[ev-N]` chip to see the evidence linking light up

### Show graceful degradation

Temporarily blank out `geminiConfig.local.ts`'s key (set to `''`), rebuild, retry. The menu falls back to a canned verdict. Restore the key after the take. Demonstrates: *"The investigation engine never breaks Reddit's native mod queue."*

### Show the auto-removed verdict posts

Open the demo sub as a **logged-out user** in a private window. The verdict posts (titled `🛡 ModPilot · REMOVE · ...`) are **not visible** in the public feed — they only live in the mod queue. Demonstrates the privacy/operational hygiene of the surface.

---

## 10. After Recording — Submission Checklist

- [ ] Upload video (with captions if possible)
- [ ] Include `docs/Overview.md` link in the submission text
- [ ] Mention: "Built on Devvit Web · TypeScript · Gemini 2.5 Pro + Flash · Devvit-managed Redis"
- [ ] Mention: "Open source, MIT, see GitHub link"
- [ ] Include 1–2 screenshots of the verdict UI (showing the panels)
- [ ] Note Devvit publish status (still playtest mode unless you ran `devvit publish`)

---

## 11. Troubleshooting During Recording

| Symptom | Fix |
|---|---|
| Modmail welcome didn't arrive | Check terminal for `modpilot.install.welcome_skip` — it was already sent in a prior run. Force resend with: `redis.del('sub:{sub_id}:welcome_sent')` then upload again. |
| "Investigate with ModPilot" menu item missing | Refresh Reddit. Check `npx devvit playtest` is still running. Confirm you're a mod of the sub. |
| Verdict UI shows "ModPilot couldn't load this verdict" | Devvit Redis hash didn't write. Check terminal for `engine.persist_failed`. Re-investigate. |
| `engine.profile_loaded` shows `rules_chars: 0` | The Configure policy form save didn't persist. Re-open the form and save again. |
| Response Drafter modal hangs on Generate | Check terminal for `responseDrafter.prompt` — if absent, Gemini key is missing. Check `geminiConfig.local.ts`. |
| 403 on action click | You're not a moderator of the sub. Reddit doesn't reflect newly-added mod status for ~30s after granting. |

---

*Made for the hackathon submission. Last updated: 2026-05-23.*
