# 05 — Memory

> **Purpose:** Specify ModPilot's longitudinal moderation memory, the subreddit personality system, and cold-start safety. This is what makes ModPilot feel **operationally aware** instead of stateless. When working on memory schemas, personality logic, or any feature that asks "what does ModPilot know about this user/thread/subreddit over time?", this is the doc to load.
>
> **Status:** Living. Schemas evolve with migrations; retention rules tune over time.

---

## 1. What Memory Is (and Isn't)

ModPilot's Moderation Memory is the **longitudinal state** the system maintains per user, per thread, and per subreddit. It is what separates ModPilot from every stateless classifier on the market.

**Memory is:**

- A structured record of what has happened in this subreddit, on this thread, with this user.
- Surfaced as **concrete evidence rows** that moderators can verify.
- Scoped strictly per subreddit. No data crosses subreddit boundaries.
- Used by tools (`user_history`, `prior_actions`) as their primary data source.
- Updated via the feedback loop after every moderator action.

**Memory is not:**

- A profile or "permanent record" of a user. It is a *contextual operational state* relevant to the moderator's job.
- A scoring model or trained classifier. It is structured facts plus simple derived signals.
- A cross-subreddit dossier. Each subreddit's memory is isolated by design (see `10-ReliabilityAndSafety.md`).
- A replacement for moderator judgment. Memory provides evidence; the moderator decides.

Memory's purpose is to surface things like *"this user has 3 prior removals in your subreddit in the last 30 days"* — concrete, auditable, time-bound facts. Not opaque scores.

---

## 2. Three Scopes of Memory

ModPilot maintains memory at three scopes. Each has a distinct schema, retention policy, and use case.

```
┌────────────────────────────────────────────────────────────┐
│                  Subreddit Memory                          │
│  (per-subreddit operational state and learned weights)     │
│                                                            │
│   ┌──────────────────────────────────────────────────┐    │
│   │              Thread Memory                       │    │
│   │  (per-thread escalation, instigators, actions)   │    │
│   │                                                  │    │
│   │   ┌────────────────────────────────────────┐    │    │
│   │   │           User Memory                  │    │    │
│   │   │  (per-user-per-subreddit history)      │    │    │
│   │   └────────────────────────────────────────┘    │    │
│   └──────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

User Memory nests inside Thread Memory nests inside Subreddit Memory — conceptually. They are stored as separate Postgres tables (see `07-DataLayer.md`), all keyed on `subreddit_id`.

---

## 3. User Memory Model

### 3.1 What It Stores

User Memory is per-user-per-subreddit. It is the answer to: *"What do we, as moderators of this subreddit, need to know about this user when we see a new report on them?"*

```python
@dataclass
class UserMemory:
    user_id: str                       # anonymized in LLM prompts
    subreddit_id: str
    first_seen: datetime
    last_seen: datetime

    # Counts (time-bounded)
    prior_violations: dict[str, int]   # category → count, last 90 days
    borderline_incidents: int          # times ModPilot recommended action but mod approved
    mod_overrides_in_favor: int        # times mod approved despite ModPilot recommending remove
    mod_overrides_against: int         # times mod removed despite ModPilot recommending approve
    escalation_flags: int              # times this user appeared in escalation patterns

    # Derived signals
    trust_score: float                 # 0.0-1.0, computed via decay (Section 3.3)
    risk_tier: Literal["new", "trusted", "neutral", "watched"]
    recent_action_velocity: float      # actions per week, decayed

    # Provenance
    last_recomputed_at: datetime
    version: int                       # for migrations
```

### 3.2 What Drives Each Field

| Field | Update trigger | Computation |
|---|---|---|
| `prior_violations` | `onModAction` with Remove/Ban | Increment by category (harassment, spam, etc.) |
| `borderline_incidents` | `onModAction` with Approve where ModPilot recommended Remove | Increment counter |
| `mod_overrides_in_favor` | Approve action where ModPilot recommended action | Increment |
| `mod_overrides_against` | Remove action where ModPilot recommended no action | Increment |
| `escalation_flags` | Thread context tool detects this user as instigator | Increment |
| `trust_score` | Nightly batch recomputation | Decay formula (Section 3.3) |
| `risk_tier` | Derived from `trust_score` and `prior_violations` | Banded mapping (Section 3.4) |
| `recent_action_velocity` | Nightly batch | Exponential decay over 30-day window |

### 3.3 Trust Score Formula

Trust Score is the single derived signal that captures "how does this user generally behave in this subreddit?"

```python
def compute_trust_score(user: UserMemory, now: datetime) -> float:
    # Start neutral
    score = 0.5

    # Recent violations pull score down (with time decay)
    for category, events in user.violations_with_timestamps.items():
        for event_time in events:
            age_days = (now - event_time).days
            decay = exp(-age_days / 30)         # half-life ~21 days
            severity = VIOLATION_SEVERITY[category]   # 0.05 - 0.30
            score -= severity * decay

    # Mod overrides in favor pull score up (mods explicitly trusted this user)
    for event_time in user.override_in_favor_timestamps:
        age_days = (now - event_time).days
        decay = exp(-age_days / 30)
        score += 0.05 * decay

    # Account tenure adds a small floor
    tenure_days = (now - user.first_seen).days
    tenure_bonus = min(0.10, tenure_days / 1000)
    score += tenure_bonus

    return clamp(score, 0.0, 1.0)
```

Tunable parameters (`VIOLATION_SEVERITY`, decay half-life, tenure cap) live in `engine/personalities/presets.py` and are tunable per subreddit personality. Never hardcode them in branches.

### 3.4 Risk Tier Mapping

```python
def derive_risk_tier(user: UserMemory) -> RiskTier:
    if user.first_seen and (now() - user.first_seen).days < 7:
        return "new"             # cold-start: insufficient history
    if user.trust_score >= 0.75 and sum(user.prior_violations.values()) == 0:
        return "trusted"
    if user.trust_score <= 0.30 or any_violation_in_last_30_days(user):
        return "watched"
    return "neutral"
```

`risk_tier` is what gets shown to mods in the UI. It is human-readable and bounded. The raw `trust_score` float is never shown — only the tier label.

### 3.5 What Memory Reveals to the Engine

When `user_history` runs, it returns evidence rows like:

```python
EvidenceRow(
    id="ev-3",
    tool_name="user_history",
    type="prior_violations",
    summary="3 prior removals in this subreddit (last 30 days): harassment (2), spam (1)",
    detail={
        "count": 3,
        "categories": {"harassment": 2, "spam": 1},
        "window_days": 30,
    },
    weight=0.7,
)
```

```python
EvidenceRow(
    id="ev-4",
    tool_name="user_history",
    type="trust_signal",
    summary="User is in 'watched' tier (low trust score, recent violation)",
    detail={"tier": "watched"},
    weight=0.5,
)
```

Note: the LLM Reasoner sees `summary` and `detail`, but **never the raw user_id** — that's anonymized at the evidence-serialization layer (see `06-AILayer.md`).

### 3.6 Cold-Start for New Users

A user appearing in this subreddit for the first time has no memory. The system handles this explicitly:

- `risk_tier` returns `"new"` regardless of trust score formula
- The `user_history` tool returns an evidence row: `"new user — first appearance in this subreddit"`
- The Calibrator does not down-weight confidence for genuinely new users (we have no negative signal; treat as neutral)

This is different from subreddit-level cold-start (Section 7). User-level cold-start is normal; subreddit-level cold-start is rare.

---

## 4. Thread Memory Model

### 4.1 What It Stores

Thread Memory tracks the conversational arc of a single post and all its comments. It is consulted whenever the `thread_context` tool runs, and updated as new comments arrive.

```python
@dataclass
class ThreadMemory:
    post_id: str
    subreddit_id: str
    created_at: datetime
    last_activity_at: datetime
    comment_count: int

    # Escalation trajectory
    escalation_trajectory: list[EscalationPoint]   # turn-by-turn temperature score
    peak_temperature: float                        # highest observed
    current_temperature: float                     # decayed over time

    # Actors
    instigator_candidates: list[str]               # anonymized user IDs
    participants_count: int

    # Mod actions
    mod_actions_taken: list[ModActionSummary]      # removals, locks, etc.

    # Topic flags
    topic_volatility: float                        # 0.0-1.0, derived from subreddit norms
    off_topic_flag: bool

    # Cached summaries (only populated for threads ≥ 10 comments)
    last_summary: str | None
    last_summary_at: datetime | None
    last_summary_bucket: int | None                # comment_count rounded to nearest 10

@dataclass
class EscalationPoint:
    turn: int                    # comment ordinal in the thread
    timestamp: datetime
    temperature: float           # 0.0-1.0, single-comment intensity
    drivers: list[str]           # which features drove the score
```

### 4.2 Escalation Trajectory

The escalation trajectory is what lets ModPilot identify *escalating* conversations versus *isolated* heated comments. It's the single most distinctive feature of the Thread Memory.

```python
def compute_escalation_temperature(comment: Comment, prior: list[Comment]) -> float:
    # Cheap signals, no LLM
    intensity = (
        0.3 * normalized_caps_ratio(comment.body)
      + 0.2 * normalized_personal_pronoun_attack_rate(comment.body)
      + 0.2 * slur_or_aggressive_lexicon_hit(comment.body)
      + 0.15 * reply_velocity(comment, prior)      # rapid back-and-forth
      + 0.15 * sentiment_swing_from_parent(comment, prior)
    )
    return clamp(intensity, 0.0, 1.0)
```

The trajectory is the time series of these scores. A thread that goes 0.1 → 0.2 → 0.3 → 0.7 → 0.9 over 5 turns is **escalating**. A thread with isolated spikes is **not** escalating. The `thread_context` tool reads this trajectory directly and surfaces it as evidence.

### 4.3 Instigator Detection

A user is flagged as an instigator candidate if:

- They authored a comment at a local peak in the escalation trajectory (a turn where temperature rose ≥0.3 above the running average)
- They responded to a calmer parent comment with a hotter one (temperature delta ≥0.4)

Instigator detection is **heuristic, not deterministic**. The Reasoner sees instigator candidates as a hint, not a verdict. The actual decision about whether a user is "the instigator" remains a moderator judgment call, always.

### 4.4 Thread Summary Caching

For threads with ≥10 comments, the Engine summarizes via Haiku (`thread_context` tool). The summary is cached against a bucket key:

- Bucket = `comment_count // 10 * 10` (rounded to nearest 10)
- Cache key: `thread_summary:<postId>:<bucket>`
- TTL: 24 hours

Why bucket? Most threads grow incrementally. A summary at 47 comments is functionally equivalent to one at 49 comments. Bucketing means we don't re-summarize on every new comment — we re-summarize only when the thread materially grows (every ~10 turns).

Cache hit rate target: >70% on active threads. This is the single most expensive tool; caching is non-negotiable.

### 4.5 Thread Memory Retention

- Active threads (last activity within 7 days): full memory retained
- Stale threads (no activity 7–30 days): retain escalation trajectory + mod actions; drop cached summaries
- Old threads (>30 days): drop trajectory detail; retain `peak_temperature`, `mod_actions_taken`, summary string for audit log
- After 180 days: thread memory is deleted entirely (audit log entries persist separately per `10-ReliabilityAndSafety.md`)

---

## 5. Subreddit Memory Model

### 5.1 What It Stores

Subreddit Memory is the per-subreddit operational state. It captures what the moderation team's behavior reveals about the subreddit's actual norms — distinct from its written rules.

```python
@dataclass
class SubredditMemory:
    subreddit_id: str
    installed_at: datetime
    config_version: int

    # Effective rules (what mods actually enforce, derived from action history)
    rule_enforcement_rates: dict[str, float]   # rule_id → fraction of reports where action taken
    most_enforced_rules: list[str]             # top 3 by volume

    # Team behavior
    mod_decision_distribution: dict[Recommendation, int]   # action histogram
    avg_decision_time_seconds: float                       # mod response latency
    inter_mod_consistency: float                           # 0.0-1.0, similar-report agreement

    # ModPilot performance
    feedback_events: int                       # cumulative; cold-start exit at 50
    accepted_count: int
    rejected_count: int
    overridden_count: int
    historical_accuracy: float                 # derived: accepted / (accepted + rejected + overridden)

    # Patterns
    peak_activity_hours: list[int]             # UTC hours with high report volume
    recurring_brigade_vectors: list[str]       # known external referrers (post-MVP)
    false_positive_categories: dict[str, int]  # ModPilot remove-recs that mods overrode, by category

    # Personality state
    active_personality: Personality            # Strict | Balanced | Lenient | Custom
    risk_weights: dict[str, float]             # tunable Strategy Selector weights
    baseline_risk: float                       # 0.0-1.0, sub-level prior on action-rate
```

### 5.2 Why Subreddit Memory Exists

Three concrete uses:

1. **Strategy Selector tuning.** `risk_weights` and `baseline_risk` directly affect tier selection. Subreddits with high action rates trigger Standard/Deep tiers at lower thresholds.

2. **Personality refinement.** The nightly batch reads recent feedback and adjusts weights so the Engine drifts toward agreeing with the mod team's actual decisions over time.

3. **Mod-facing analytics.** The dashboard pulls from here: "ModPilot's accuracy in your subreddit is 87%", "Your team's average response time is 4 minutes", "Most enforced rule: Rule 2 (Personal Attacks)".

### 5.3 Inter-Mod Consistency

For multi-mod subreddits, we compute how consistently mod team members rule on similar reports. This is a useful signal for the team itself ("are we calibrated?") and also informs whether ModPilot's recommendations are likely to match any given mod's judgment.

Computed nightly:

```python
def inter_mod_consistency(actions: list[ModAction]) -> float:
    # For each pair of actions on "similar" items (same author or same thread or same evidence pattern),
    # check whether the actions match.
    # Returns the fraction of pairs that agree.
```

Surfaces in the dashboard. Not used to gate Engine behavior; it's purely informational.

### 5.4 Subreddit Memory Update Cadence

Most fields update **on every event** (`feedback_events`, action counts, rule enforcement rates) — these are simple counters or running averages.

A subset updates **nightly** via `engine/jobs/feedback_rollup.py`:

- `risk_weights`
- `baseline_risk`
- `historical_accuracy` (recomputed from last 30 days only — older signal is less relevant)
- `inter_mod_consistency`
- `peak_activity_hours`

Nightly batch is documented in `04-InvestigationEngine.md` Section 11.

---

## 6. Subreddit Personalities

The personality system is what makes ModPilot adapt per subreddit. r/AskHistorians and r/dankmemes don't moderate the same way; ModPilot doesn't either.

### 6.1 The Four Adaptation Axes

A personality is defined by adjustments along four axes:

| Axis | Effect | Where applied |
|---|---|---|
| **Investigation depth bias** | Earlier triggering of Standard / Deep tiers | Strategy Selector |
| **Confidence thresholds** | Lower threshold for surfacing recommendations | Calibrator + UI |
| **Escalation preference** | Whether to recommend user-level (ban) or thread-level (lock) actions | Reasoner prompt |
| **Reasoning tone** | Formality and verbosity of generated rationale | Reasoner prompt |

### 6.2 The Three Presets

Personalities ship as three presets, plus a Custom mode for hand-tuning.

```python
PERSONALITY_PRESETS = {
    "strict": Personality(
        fast_tier_ceiling=0.25,         # less generous to FAST tier
        deep_tier_floor=0.55,           # easier to escalate to DEEP
        confidence_threshold=0.50,      # recommend at lower confidence
        escalation_preference="user",   # prefer user-level actions
        reasoning_tone="formal",
        prompt_phrasing=(
            "If the evidence suggests a possible violation, lean toward recommending action. "
            "This subreddit has chosen a strict moderation posture."
        ),
    ),
    "balanced": Personality(
        fast_tier_ceiling=0.30,
        deep_tier_floor=0.70,
        confidence_threshold=0.60,
        escalation_preference="contextual",
        reasoning_tone="neutral",
        prompt_phrasing=(
            "Recommend action when evidence supports it; recommend no action when evidence is mixed. "
            "Balance protective and lenient considerations."
        ),
    ),
    "lenient": Personality(
        fast_tier_ceiling=0.35,
        deep_tier_floor=0.80,
        confidence_threshold=0.75,
        escalation_preference="thread",
        reasoning_tone="conversational",
        prompt_phrasing=(
            "Only recommend action when evidence clearly supports it. "
            "Default to no action when evidence is ambiguous. "
            "This subreddit values openness and tolerates more discussion."
        ),
    ),
}
```

### 6.3 What "Lenient" Doesn't Mean

A common misread of these presets: "Lenient = lower accuracy." It does not.

Lenient personalities **don't lower the bar for evidence quality** — they raise the bar for *acting on* evidence. A Lenient subreddit gets the same quality of investigation; the difference is whether the Reasoner crosses into "recommend Remove" territory. Lenient subs see more `NO_ACTION` recommendations with evidence still surfaced, letting the mod make the call.

### 6.4 Custom Personalities

Power Mod Priya (per `01-Product.md`) needs the ability to hand-tune. The Custom mode exposes the personality dataclass fields directly in the settings UI (advanced section), letting a head mod write their own weights.

This is a post-MVP feature, but the dataclass shape is designed to support it from day one — every personality is just a `Personality` instance, presets are predefined ones.

### 6.5 Personality Evolution via Feedback

Personalities are **starting points**, not fixed identities. The nightly batch nudges weights based on feedback:

```python
def evolve_personality(sub_mem: SubredditMemory, recent_feedback: list[FeedbackEvent]) -> Personality:
    p = sub_mem.active_personality.copy()
    overrides = count_overrides(recent_feedback)
    accepts = count_accepts(recent_feedback)

    # If recommendations are being overridden too often → become more lenient
    if overrides / (overrides + accepts + 1) > 0.30:
        p.confidence_threshold += 0.02     # raise the bar
        p.deep_tier_floor += 0.02

    # If recommendations are being accepted nearly universally and action rate is high → can be more aggressive
    if accepts / (overrides + accepts + 1) > 0.90 and sub_mem.baseline_risk > 0.6:
        p.confidence_threshold -= 0.02

    # Bound the drift — never let a personality drift more than 0.15 from its preset
    p.confidence_threshold = clamp(p.confidence_threshold, preset.threshold - 0.15, preset.threshold + 0.15)
    return p
```

Bounded drift keeps personalities recognizable. A Strict sub stays recognizably strict even after months of feedback. The drift is for fine-tuning, not for changing identity.

### 6.6 Why This Matters for Differentiation

Most "AI moderation" tools have one mode. ModPilot has subreddit-specific moderation personalities that evolve from feedback. Even a *lightly* implemented version of this dramatically separates ModPilot from competitors. It is one of the five Pillars (per `01-Product.md`) and must be demonstrable in the hackathon submission.

---

## 7. Cold-Start Safety

Cold-start is what ModPilot does **before it has feedback to learn from**. It is the single most important operational maturity signal in the product.

### 7.1 Why Cold-Start Exists

A fresh install has:

- No `feedback_events` in subreddit memory
- No `historical_accuracy` data to calibrate confidence with
- No `risk_weights` tuning from this team's behavior
- No `mod_decision_distribution` to learn the team's style

If we ran full Engine behavior with default weights against a subreddit we know nothing about, we'd produce confident-looking recommendations that are actually uncalibrated. That destroys trust before it's even established.

Cold-start mode prevents this.

### 7.2 The Cold-Start Threshold

```python
COLD_START_THRESHOLD = 50   # feedback events
```

A subreddit is in cold-start mode while `subreddit_memory.feedback_events < 50`. The transition is one-way: once we exit cold-start, we don't return (unless explicitly reset).

50 is the working default. It's set in `engine/personalities/cold_start.py` and is tunable per-deployment. The number is calibrated to be reachable within the first 1–2 weeks of moderate use — short enough that subs see normal behavior soon, long enough to actually calibrate.

### 7.3 What Changes in Cold-Start Mode

Cold-start applies **four explicit modifications** to the Engine's behavior:

#### 7.3.1 Conservative tier selection
```python
if profile.feedback_events < COLD_START_THRESHOLD:
    if risk < 0.6:
        return STANDARD_PLAN          # never FAST during cold-start
    return DEEP_PLAN                  # higher tier sooner
```

In cold-start, we'd rather over-investigate than miss context. The tier-cost story for a new install is *"we're spending more upfront to learn your subreddit faster."*

#### 7.3.2 Confidence demotion
```python
if cold_start:
    calibrated_confidence *= 0.85
```

A 15% confidence demotion applied in the Calibrator. A verdict that would have been HIGH (0.88) in a mature sub becomes MEDIUM (0.75) in cold-start. This is appropriate epistemic humility.

#### 7.3.3 No high-confidence prefill
Some power users opt into "auto-prefill action button for HIGH confidence recommendations" — this is **disabled** during cold-start regardless of opt-in setting. Mods always click action explicitly during the learning window.

#### 7.3.4 Visible "Learning" badge in UI
The Verdict Card, Dashboard, and Settings all display:

> 🌱 **ModPilot is learning your subreddit.** Recommendations will improve as you provide feedback. (`X / 50` feedback events so far.)

This is the most important part. We don't just behave differently — we **tell the user we're behaving differently and why**. Honest UX is non-negotiable.

### 7.4 Cold-Start Exit Transition

The transition out of cold-start happens **gradually**, not as a hard cliff. As `feedback_events` approaches 50, the confidence demotion eases:

```python
def cold_start_demotion_factor(feedback_events: int) -> float:
    if feedback_events >= COLD_START_THRESHOLD:
        return 1.0    # no demotion
    progress = feedback_events / COLD_START_THRESHOLD
    return 0.85 + (0.15 * progress)    # 0.85 at 0 events, 1.0 at threshold
```

A sub at 30 feedback events has demotion factor 0.94 — meaningfully eased from the initial 0.85 but still applied. By the time the badge disappears, the system has been progressively calibrating toward normal behavior. There's no jarring discontinuity.

### 7.5 Manual Cold-Start Reset

A subreddit setting lets the head mod manually trigger cold-start (e.g., after a major rule change or mod team turnover). This:

- Resets `feedback_events` toward zero (we cap the reset at the last 30 days of feedback retained)
- Re-displays the learning badge
- Re-applies cold-start behaviors

This is rare but operationally important. Mod teams should have the option to say "ignore what you learned; let's recalibrate."

### 7.6 What Cold-Start Doesn't Disable

To be explicit about boundaries:

- Memory still accumulates normally. User Memory, Thread Memory, Subreddit Memory all update. We just don't *trust* the derived weights yet.
- Tools still run normally. `user_history` still surfaces "this is a new user" or "this user has 3 priors" — those are facts.
- The Reasoner still generates verdicts. They're just more cautious.
- The Investigation Timeline still renders fully. Cold-start has zero effect on transparency.

Cold-start affects **confidence and recommendations**, not **investigation quality**.

---

## 8. Memory Retention Policy

How long things live, and why.

| Memory type | Hot retention | Warm retention | Cold (archived) | Hard delete |
|---|---|---|---|---|
| User Memory — active | Indefinite while user active in sub | 90 days post last activity | Aggregated to summary record at 1 year | 2 years |
| User Memory — banned users | Indefinite | Indefinite | Retained for ban-evasion detection | Only on subreddit uninstall + 30d grace |
| Thread Memory — active | 7 days | 7-30 days | 30-180 days (trajectory dropped) | 180 days |
| Subreddit Memory | Indefinite | — | — | Only on uninstall + 30d grace |
| Feedback events | Indefinite for analytics | — | — | Only on uninstall + 30d grace |
| Audit log | Indefinite | — | — | Per `10-ReliabilityAndSafety.md` |

### 8.1 Retention Principles

1. **User Memory respects the user.** We don't keep behavioral records on users who haven't been in this subreddit for years. The 2-year hard delete is firm.
2. **Banned users are an exception.** Ban-evasion detection requires retaining records. The mod team chose to ban; we retain that fact.
3. **Thread Memory ages aggressively.** Old threads are rarely relevant; only their summary footprint persists.
4. **Subreddit Memory persists.** Operational state for the subreddit itself is retained as long as ModPilot is installed.
5. **Uninstall has a grace period.** 30 days after `AppRemove`, all data is hard-deleted. The grace window allows accidental uninstalls or reinstalls to recover.

### 8.2 PII and Privacy Rules

The detailed PII rules live in `10-ReliabilityAndSafety.md`. Memory-specific rules:

- **User IDs are anonymized in LLM prompts.** The Engine maintains an anonymization layer (`engine/llm/anon.py`) that replaces user IDs with stable in-investigation tokens (e.g., `u_a`, `u_b`). The Reasoner sees only the tokens; UI rehydrates the real IDs.
- **Comment content is not retained beyond evidence rows.** We store our derived signals (escalation temperature, instigator flag), not the raw text. Reddit's content is Reddit's; we don't hoard it.
- **Mod-initiated forgetting.** A mod can request that a specific user's memory be wiped from their subreddit (e.g., a user appealed and was given a fresh start). The setting is in the mod tools menu; it sets `user_memory` to deleted and writes an audit log entry.

### 8.3 What Happens on Uninstall

Per the lifecycle in `03-Devvit.md`:

1. `AppRemove` fires.
2. Engine receives `POST /uninstall` for the subreddit.
3. Memory tables for that subreddit are marked `pending_deletion` with `delete_at = now + 30 days`.
4. A nightly job purges records where `delete_at < now`.
5. After 30 days, all User Memory, Thread Memory, and Subreddit Memory for that subreddit are physically deleted.

The grace window is critical for trust. Mods who uninstall to test something shouldn't lose months of learned context.

---

## 9. Memory Access Patterns

How the Engine actually reads and writes memory.

### 9.1 Read Patterns

Memory is read by:

- **Strategy Selector** — reads `UserMemory.trust_score` and `SubredditMemory.baseline_risk` + `risk_weights` (cached, 60s TTL)
- **`user_history` tool** — reads full `UserMemory` for the report author (cached per investigation)
- **`prior_actions` tool** — reads recent audit log entries for this user in this subreddit
- **`thread_context` tool** — reads `ThreadMemory` for the post; may trigger summary refresh
- **Calibrator** — reads `SubredditMemory.historical_accuracy`
- **Mod-facing analytics** — reads aggregated `SubredditMemory` fields

All reads go through `engine/memory/{user,thread,subreddit}.py`. No tool or component bypasses the memory layer to query Postgres directly.

### 9.2 Write Patterns

Memory is written by:

- **`POST /feedback` endpoint** — updates `UserMemory` counters, `SubredditMemory.feedback_events`, audit log entry
- **`thread_context` tool** — updates `ThreadMemory.escalation_trajectory` with newly observed comments
- **Nightly batch (`feedback_rollup.py`)** — recomputes derived fields: `trust_score`, `risk_tier`, `historical_accuracy`, `risk_weights`, `inter_mod_consistency`
- **`AppInstall` handler** — creates initial empty memory records
- **`AppRemove` handler** — marks records `pending_deletion`

### 9.3 Caching

User Memory is cached in Redis under `user_profile:<userId>:<subredditId>` with a 1-hour TTL. This is the highest-volume read in the system; uncached reads would saturate Postgres quickly.

Thread Memory's `escalation_trajectory` is hot during active discussions but cools quickly. We cache the most recent 50 trajectory points in Redis (`thread_traj:<postId>`) with 6-hour TTL. Older points stay in Postgres only.

Subreddit Memory's fast-moving fields (`feedback_events`, counts) live in Redis as atomic counters, flushed to Postgres every 5 minutes. Slow-moving derived fields (`historical_accuracy`, `risk_weights`) live only in Postgres and are read with 60-second cache.

The detailed cache layout is in `07-DataLayer.md`.

### 9.4 Consistency Guarantees

- **Feedback events are durable on receipt.** Every `POST /feedback` writes the audit log entry to Postgres before responding. No batching.
- **Memory counter writes are eventually consistent.** The 5-minute Redis-to-Postgres flush is acceptable for analytics and tier selection. If the Engine reads a slightly stale counter, it doesn't change a decision materially.
- **Derived fields are nightly.** Mods know their analytics dashboard refreshes once per day. We don't pretend otherwise.

---

## 10. Memory in the Investigation Flow

For concreteness, here's how memory flows through a single investigation:

```
1. Report arrives → Strategy Selector
   ├─ reads SubredditMemory.baseline_risk (cached, ~1ms)
   ├─ reads UserMemory.trust_score (cached, ~1ms)
   └─ produces InvestigationPlan

2. Orchestrator runs tools
   ├─ policy_match → uses cached policy embeddings (no memory read)
   ├─ report_velocity → reads Redis counters (~1ms)
   ├─ user_history → reads UserMemory (cached, ~5ms)
   │     └─ produces evidence rows citing prior_violations, trust_signal
   ├─ prior_actions → reads recent audit log entries (~10ms)
   │     └─ produces evidence rows citing last mod actions on this user
   └─ thread_context → reads ThreadMemory + may trigger Haiku summary (~500-1500ms)
         └─ produces evidence rows citing escalation trajectory, instigators

3. Reasoner generates verdict (with anonymized memory-derived evidence)

4. Verdict returned to Devvit; rendered with memory rows surfaced as evidence

5. Mod takes action → onModAction → POST /feedback
   ├─ writes feedback row to Postgres (durable)
   ├─ updates UserMemory counters (Redis, eventual)
   ├─ updates SubredditMemory.feedback_events (Redis, eventual)
   ├─ updates ThreadMemory.mod_actions_taken (Redis + Postgres)
   └─ writes audit log entry (Postgres, durable)

6. Nightly batch recomputes derived fields:
   ├─ UserMemory.trust_score for active users
   ├─ SubredditMemory.historical_accuracy
   ├─ SubredditMemory.risk_weights
   └─ SubredditMemory.inter_mod_consistency
```

Memory is consulted at every meaningful step. Memory is updated at every meaningful step. This is what "longitudinal" means in practice.

---

## 11. Memory Invariants

Properties that must always hold:

1. **Every memory record has a `subreddit_id`.** No cross-subreddit reads or writes are possible because all queries are scoped on this field.
2. **Memory writes are durable for feedback events; eventually consistent for counters.** We don't lose feedback. We may briefly serve stale counts.
3. **LLM prompts never contain raw user IDs.** Anonymization happens at evidence-serialization. Enforced by tests.
4. **Trust scores never appear in the UI as numbers.** Only tier labels (`new`, `trusted`, `neutral`, `watched`).
5. **Cold-start state is one-way unless explicitly reset.** No bug can re-enter cold-start; only the manual reset setting can.
6. **Personality drift is bounded.** No personality can drift more than 0.15 from its preset values in any field. Enforced in `evolve_personality()`.
7. **Memory deletion respects the grace window.** Uninstall doesn't delete data immediately; the 30-day window is enforced by a `delete_at` timestamp.
8. **No memory data crosses to LLM provider logs.** Anonymized prompts only; raw IDs never sent to providers.

Violating any of these is a bug.

---

## 12. Open Questions

Decisions deferred until evidence arrives:

- **Should `trust_score` use a global model or pure per-subreddit history?** Currently per-subreddit only. Roadmap consideration: opt-in federation where subreddits choose to share signals.
- **What's the right cold-start threshold for very small subreddits (<1k subscribers)?** A small sub might never reach 50 feedback events in reasonable time. Defer to per-sub tuning; the default 50 is fine for MVP.
- **Should Thread Memory's escalation trajectory be visible in the UI?** Currently it's internal-only; surfaces as evidence rows but not as a chart. Possible future feature.
- **Should we expose User Memory directly to mods via a "user lookup" UI?** The "Show Memory" menu action is the MVP version. Whether to expand it is a UX iteration.

Tracked in root `CLAUDE.md` open questions.

---

## 13. Related Documents

- [`01-Product.md`](01-Product.md) — Why Moderation Memory is a Pillar of differentiation.
- [`02-Architecture.md`](02-Architecture.md) — Where the Memory Layer fits in the Engine architecture.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — How tools and the Calibrator consume memory.
- [`06-AILayer.md`](06-AILayer.md) — Anonymization, prompt injection of evidence, citation contract.
- [`07-DataLayer.md`](07-DataLayer.md) — Postgres schemas, Redis cache layout for memory.
- [`08-API.md`](08-API.md) — `/feedback` endpoint that drives memory updates.
- [`09-UX.md`](09-UX.md) — How memory surfaces in the Verdict Card and "Show Memory" UI.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — PII rules, retention, mod-initiated forgetting.
- [`11-Evaluation.md`](11-Evaluation.md) — Cold-start scenarios in the eval harness.