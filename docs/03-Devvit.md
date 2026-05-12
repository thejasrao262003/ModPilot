# 03 — Devvit

> **Purpose:** Everything Devvit-specific in one place. Lifecycle, triggers, menu actions, scheduled jobs, settings, UI primitives, HTTP client to the Engine, permissions, and the SDK gotchas we've hit. When working anywhere under `devvit-app/`, this is the doc to load.
>
> **Status:** Living. Mostly static for the core sections; the "Gotchas" section evolves as we encounter SDK quirks.

---

## 1. Devvit Execution Model

Devvit apps are not long-running servers. They are **registered handlers that Reddit invokes** on events. Internalizing this changes how you write everything below.

The platform gives us six handler surfaces:

| Surface | When it fires | Typical use |
|---|---|---|
| **Triggers** | Reddit events (report, post, comment, mod action, install) | Main moderation event ingestion |
| **Menu actions** | Moderator clicks a context menu item on a post, comment, user, or subreddit | "Investigate with ModPilot", "Summarize Thread" |
| **Scheduled jobs** | Cron-style intervals | Queue re-prioritization, retries, rollups |
| **Custom posts** | Renders an interactive post in a subreddit | The ModPilot Dashboard |
| **Forms** | Modals invoked from menu actions or custom posts | Configuration prompts, confirmation flows |
| **App lifecycle** | Install, upgrade, remove | Bootstrap, migration, cleanup |

Each handler is a **stateless function** with access to a `context` object exposing:

- `context.reddit` — Reddit API client (read posts/comments/users, take mod actions)
- `context.redis` — Devvit-managed Redis (the only mutable state Devvit gives us in-app)
- `context.settings` — read subreddit-level configuration
- `context.scheduler` — schedule one-off or recurring jobs
- `context.modLog` — write to the moderator action log
- `context.http` — outbound HTTPS to allowlisted domains
- `context.userId`, `context.subredditId`, `context.subredditName` — request-scoped identifiers

**Hard constraints we design around:**

- Per-invocation timeout (treat as ~30 seconds for normal handlers, much less for triggers — design for sub-5-second triggers as a rule).
- No background threads, no `setInterval`, no long-lived sockets. Use the scheduler.
- No filesystem persistence. State goes to Devvit Redis or the Engine.
- Outbound HTTPS only to domains listed in `devvit.yaml`. Configure once; revisit only when adding a new external service.

Everything in this doc obeys these constraints. When something feels like it wants to violate them, it belongs in the Engine, not in Devvit.

---

## 2. App Lifecycle

Three events bracket every install of ModPilot. Handle all three; never assume defaults.

### 2.1 `AppInstall`

Fires once when a moderator installs ModPilot on a subreddit.

**What we do:**

1. Initialize a `SubredditConfig` record in Devvit Redis with the Balanced personality preset.
2. Mark cold-start state: `coldStart = true`, `feedbackEvents = 0`.
3. Register the scheduled jobs (`reprioritizeQueue`, `retryFailed`).
4. Fire a one-time `POST /install` to the Engine so it can create the subreddit's Postgres rows (memory tables, personality config).
5. Trigger the First-Run Wizard to surface in the moderator's UI on next visit.

**What we deliberately do not do:**

- Pull subreddit history retroactively. Cold start means we start clean. Roadmap, not MVP.
- Auto-enable any feature flags beyond defaults.
- Make Engine calls block install completion. If the Engine is down, install still succeeds; the wizard surfaces a "complete setup" prompt later.

### 2.2 `AppUpgrade`

Fires when a new app version is deployed and a moderator's subreddit picks it up.

**What we do:**

1. Read existing `SubredditConfig`; migrate schema if version mismatch.
2. Re-register scheduled jobs (Devvit doesn't always preserve them across upgrades — assume they're gone, re-add).
3. Fire `POST /upgrade` to the Engine with the new version so it can run any data migrations.
4. Increment `configVersion` in Redis.

**Migration rule:** every schema change to `SubredditConfig` ships with an explicit migration in `src/lifecycle/migrations.ts`. Never assume the stored shape; always validate and migrate.

### 2.3 `AppRemove`

Fires when a moderator uninstalls ModPilot.

**What we do:**

1. Cancel scheduled jobs.
2. Fire `POST /uninstall` to the Engine, which marks the subreddit's data for deletion (30-day retention then purge — see `07-DataLayer.md`).
3. Delete local Devvit Redis state for the subreddit.

We do **not** immediately hard-delete Engine-side data. A 30-day grace window lets moderators reinstall without losing their moderation memory. The retention policy is documented in `10-ReliabilityAndSafety.md`.

---

## 3. App Internal Structure

The Devvit app's file layout, with each file's responsibility nailed down.

```
devvit-app/src/
├── main.ts                        # entry point; registers everything
├── settings.ts                    # Devvit.addSettings schema
├── triggers/
│   ├── onCommentReport.ts         # hot path: comment is reported
│   ├── onPostReport.ts            # hot path: post is reported
│   ├── onModAction.ts             # feedback capture
│   ├── onAppInstall.ts            # bootstrap
│   ├── onAppUpgrade.ts            # migration
│   └── onAppRemove.ts             # cleanup
├── menu/
│   ├── investigate.ts             # "Investigate with ModPilot" (comment/post)
│   ├── summarizeThread.ts         # "Summarize this thread" (post)
│   ├── showMemory.ts              # "Show Moderation Memory" (user)
│   └── explainLastAction.ts       # "Explain ModPilot's last call" (comment/post)
├── jobs/
│   ├── reprioritizeQueue.ts       # every 60s
│   ├── retryFailed.ts             # every 5 min
│   └── analyticsRollup.ts         # hourly (mostly forwarded to Engine)
├── ui/
│   ├── ModDashboard.tsx           # custom post: dashboard + queue view
│   ├── VerdictCard.tsx            # the signature one-glance card
│   ├── InvestigationTimeline.tsx  # the signature expansion view
│   ├── FirstRunWizard.tsx         # onboarding flow
│   ├── components/                # shared Blocks primitives
│   └── tokens.ts                  # design tokens (colors, spacing)
├── services/
│   ├── engineClient.ts            # signed HTTP client to the Engine
│   ├── redditContext.ts           # wraps context.reddit with our types
│   ├── stateStore.ts              # typed Devvit Redis abstraction
│   └── featureFlags.ts            # read-from-settings flag helpers
├── domain/
│   ├── types.ts                   # Verdict, Evidence, Investigation, Priority
│   ├── priority.ts                # cheap heuristic scoring (no LLM)
│   ├── confidence.ts              # UI tier mapping (High/Medium/Low)
│   └── enrichment.ts              # cheap context enrichment
└── lifecycle/
    └── migrations.ts              # SubredditConfig schema migrations
```

**Convention:** every directory has a single purpose. Triggers do not import from menu, jobs do not import from ui. The dependency graph flows: `triggers/menu/jobs → services → domain`. Never the reverse.

---

## 4. Trigger Specifications

Triggers are the entry points. Each one is specified below with inputs, behavior, latency budget, error handling, and what it must persist.

### 4.1 `onCommentReport`

The hot path. The single trigger we optimize most.

- **Fires when:** a user reports a comment in a subreddit where ModPilot is installed.
- **Latency budget:** target under 500ms total handler time. Engine call is async-fire-and-forget; we do not wait for the verdict in this handler.
- **Inputs:** `commentId`, `subredditId`, `reportReason` (free text), `reportedAt`, plus implicit user/sub context.
- **Behavior:**
  1. Read existing `pending_investigation:<commentId>` from Devvit Redis. If exists with status `complete` and age < 10 minutes, skip — this is a duplicate report.
  2. Fetch cheap enrichment via `context.reddit`: comment body, author profile, post age, comment depth, comment score. (Free, fast.)
  3. Compute priority score via `domain/priority.ts`. No LLM.
  4. Write `pending_investigation:<commentId>` to Devvit Redis with status `queued` and priority score.
  5. Fire `POST /investigate` to the Engine via `engineClient`. Use a 6-second timeout. If the call fails or times out, write status `failed` and let `retryFailed` job pick it up later.
  6. On success, write the returned verdict to Devvit Redis under `verdict:<commentId>` with TTL of 24 hours.
- **Error handling:** Every step wrapped in try/catch. A failure here must never break Reddit's native report flow. Log structured errors with correlation ID.
- **What gets persisted:** `pending_investigation:<commentId>` (status, priority, timestamps), `verdict:<commentId>` (full verdict object) on success.

### 4.2 `onPostReport`

Same shape as `onCommentReport`, with two differences:

- Thread context fetching is more expensive (parent comment chain often longer), so we let the Engine handle it lazily inside the `thread_context` tool rather than pre-fetching.
- Posts have a `title` and `body`; comments only have `body`. The enrichment payload carries both.

Latency budget identical: under 500ms in-handler.

### 4.3 `onModAction`

The feedback path. Critical for adaptive intelligence.

- **Fires when:** any moderator action is taken in the subreddit (approve, remove, ban, lock, etc.).
- **Latency budget:** under 1 second; this is not user-blocking.
- **Behavior:**
  1. Read `verdict:<targetId>` from Devvit Redis. If absent, this action wasn't on a ModPilot-investigated item — log and exit.
  2. Compute alignment: did the mod do what ModPilot recommended?
     - `accepted` — mod's action matches the recommendation.
     - `rejected` — mod took a different action than recommended.
     - `overridden` — mod took action where ModPilot recommended no-action (low confidence).
     - `confirmed-no-action` — ModPilot didn't recommend an action, mod also took none.
  3. Fire `POST /feedback` to the Engine with the verdict ID, action taken, alignment label, and timestamp.
  4. Update Devvit Redis: mark verdict as `resolved` so it disappears from the dashboard.
- **Error handling:** Feedback failures are non-fatal but must be queued for retry. Lose feedback → lose adaptation.

### 4.4 `onAppInstall`, `onAppUpgrade`, `onAppRemove`

Covered in section 2 above. Each is a simple sequence of Redis writes + a single Engine RPC. None take more than a few hundred milliseconds.

### 4.5 Trigger Implementation Pattern

Every trigger follows this skeleton. Deviating from it requires a comment explaining why.

```ts
// triggers/onCommentReport.ts
export const onCommentReport: TriggerHandler<'CommentReport'> = async (event, context) => {
  const correlationId = newCorrelationId();
  const logger = makeLogger(context, correlationId);

  try {
    const { commentId, subredditId } = extractIds(event);

    if (await isDuplicate(context, commentId)) {
      logger.info('duplicate_report_skipped', { commentId });
      return;
    }

    const enrichment = await enrich(context, event);
    const priority = scorePriority(enrichment);

    await stateStore.put(context, `pending_investigation:${commentId}`, {
      status: 'queued',
      priority,
      receivedAt: Date.now(),
      correlationId,
    });

    const verdict = await engineClient.investigate(
      { commentId, subredditId, enrichment, correlationId },
      { timeoutMs: 6000 }
    );

    await stateStore.put(context, `verdict:${commentId}`, verdict, { ttlSeconds: 86400 });
    await stateStore.update(context, `pending_investigation:${commentId}`, { status: 'complete' });

    logger.info('investigation_complete', { commentId, tier: verdict.tier, confidence: verdict.confidence });
  } catch (err) {
    logger.error('trigger_failure', { error: err.message });
    // never rethrow — Reddit's report flow must not break
  }
};
```

This pattern — correlation ID, structured logging, defensive try/catch around everything, no rethrow — is mandatory for every trigger.

---

## 5. Menu Actions

Moderator-invoked entry points. Lower-stakes than triggers (the mod is actively waiting), but still latency-sensitive.

### 5.1 "Investigate with ModPilot"

- **Attached to:** comments and posts.
- **Behavior:** Forces an investigation regardless of whether one already exists. Useful when a mod wants a fresh look or when the original report-triggered investigation isn't available yet.
- **UX:** Shows a loading state (Devvit's progress UI) while the Engine works. Renders the Verdict Card on completion.
- **Latency budget:** acceptable up to 10 seconds; the mod is actively waiting and watching the progress indicator.

### 5.2 "Summarize this thread"

- **Attached to:** posts.
- **Behavior:** Calls the Engine's thread-summarization tool directly, bypassing the full investigation pipeline. Returns a synthesized summary of the conversation arc, instigator candidates, and escalation pattern.
- **Latency budget:** 3–5 seconds.
- **Cost note:** uses Haiku. Cached for the post+comment-count bucket — repeat invocations on the same thread are nearly free.

### 5.3 "Show Moderation Memory"

- **Attached to:** users.
- **Behavior:** Renders a modal showing the user's longitudinal moderation memory in this subreddit: prior violations, borderline incidents, mod overrides, escalation patterns, derived trust score.
- **Latency budget:** under 1 second; this is a pure DB read.
- **Privacy note:** memory is scoped to the current subreddit. Cross-subreddit memory is not exposed and structurally cannot leak (see `10-ReliabilityAndSafety.md`).

### 5.4 "Explain ModPilot's last call"

- **Attached to:** comments and posts that have an existing verdict.
- **Behavior:** Re-renders the full Verdict Card with Investigation Timeline expanded. Useful for explaining decisions to other mods or in modmail.
- **Latency budget:** under 500ms; pure Redis read.

---

## 6. Scheduled Jobs

Background work, registered at install time via `context.scheduler`.

### 6.1 `reprioritizeQueue` — every 60 seconds

- **Purpose:** Keep the mod queue's priority ordering fresh as new reports arrive.
- **Behavior:** Reads all `pending_investigation:*` keys, recomputes priority based on current velocity and age, rewrites priority scores.
- **No LLM, no Engine call.** Pure local computation.
- **Idempotent.** Running multiple instances back-to-back is safe.

### 6.2 `retryFailed` — every 5 minutes

- **Purpose:** Resurrect investigations that failed on the original trigger (Engine timeout, transient error).
- **Behavior:** Scans for `pending_investigation:*` with status `failed` and age < 24 hours. Re-fires `POST /investigate` for each, up to 3 attempts. After 3, marks as `dead` and surfaces in dashboard with an error indicator.
- **Concurrency limit:** processes at most 20 retries per run to avoid stampede.

### 6.3 `analyticsRollup` — hourly

- **Purpose:** Forward aggregated analytics events to the Engine.
- **Behavior:** Reads recent verdicts and feedback markers from Devvit Redis, batches them, fires `POST /analytics/rollup` to the Engine.
- The Engine does the actual aggregation; this job is just the courier.

**Job registration pattern** (in `main.ts`):

```ts
Devvit.addSchedulerJob({
  name: 'reprioritizeQueue',
  onRun: async (_event, context) => { await reprioritizeQueue(context); },
});

// Inside onAppInstall:
await context.scheduler.runJob({
  name: 'reprioritizeQueue',
  cron: '* * * * *', // every minute
});
```

Always re-register jobs in `onAppUpgrade` — Devvit does not guarantee they survive version bumps.

---

## 7. Settings Schema

Subreddit-level configuration, defined via `Devvit.addSettings`. This is what moderators see in the app's settings panel.

```ts
Devvit.addSettings([
  {
    type: 'select',
    name: 'personality',
    label: 'Moderation Personality',
    helpText: 'How aggressively should ModPilot recommend actions?',
    options: [
      { label: 'Strict — recommends action at lower confidence', value: 'strict' },
      { label: 'Balanced — default for most subreddits',          value: 'balanced' },
      { label: 'Lenient — recommends action only with high confidence', value: 'lenient' },
    ],
    defaultValue: 'balanced',
  },
  {
    type: 'select',
    name: 'region',
    label: 'Region',
    helpText: 'Adjusts moderation hints for region-specific norms and legal context.',
    options: [
      { label: 'United States',  value: 'US' },
      { label: 'European Union', value: 'EU' },
      { label: 'United Kingdom', value: 'UK' },
      { label: 'India',          value: 'IN' },
      { label: 'Global',         value: 'GLOBAL' },
    ],
    defaultValue: 'GLOBAL',
  },
  {
    type: 'paragraph',
    name: 'customRules',
    label: 'Subreddit Rules',
    helpText: 'Paste your subreddit rules. ModPilot uses these to ground its reasoning.',
  },
  {
    type: 'number',
    name: 'confidenceThreshold',
    label: 'Confidence Threshold',
    helpText: 'Minimum confidence (0–100) for ModPilot to surface an action recommendation. Lower = more recommendations, higher = fewer but more confident.',
    defaultValue: 60,
  },
  {
    type: 'boolean',
    name: 'enabled',
    label: 'ModPilot Active',
    helpText: 'Master kill switch. When off, ModPilot stops investigating but the queue continues working normally.',
    defaultValue: true,
  },
  {
    type: 'boolean',
    name: 'showCostInDashboard',
    label: 'Show Cost in Dashboard',
    helpText: 'Display per-investigation cost in the analytics dashboard.',
    defaultValue: false,
  },
]);
```

**Settings rules:**

- Every setting has a `helpText`. No bare labels.
- Defaults are conservative. A misconfigured ModPilot should err toward doing less, not more.
- Settings changes propagate within 60 seconds: `engineClient` reads them on every investigation; cached for 60s per subreddit.
- The `enabled` kill switch is read by every trigger handler. When `false`, handlers exit early after logging — no Engine call.

The full settings UX is specified in `09-UX.md` under the First-Run Wizard section.

---

## 8. Devvit Redis Usage

Devvit's managed Redis is our **only in-Devvit mutable state**. Use it judiciously.

### 8.1 Key Schema

| Key | Purpose | TTL | Size budget |
|---|---|---|---|
| `pending_investigation:<targetId>` | Investigation state machine | 24h | < 1KB |
| `verdict:<targetId>` | Full verdict object for UI rendering | 24h | < 8KB |
| `priority:<targetId>` | Just the priority score (read-hot in queue) | 24h | < 100B |
| `subreddit_config:<subredditId>` | Cached settings | 60s | < 2KB |
| `dashboard_summary:<subredditId>` | Aggregated analytics for dashboard | 5min | < 10KB |
| `wizard_state:<subredditId>` | First-run wizard progress | 30 days | < 1KB |

### 8.2 Access Rules

- Always go through `services/stateStore.ts`. Never call `context.redis` directly from triggers or UI.
- Every write specifies a TTL. Unbounded keys are a bug.
- Every read tolerates absence. A missing key is not an error; it's a state.
- Use `MULTI`/`EXEC` for read-modify-write to avoid races.

### 8.3 What Does Not Go Here

- Anything cross-subreddit. Devvit Redis is subreddit-scoped by platform design.
- Anything we'd want to query — Devvit Redis is key-value only, no secondary indexes.
- Anything large (over 10KB per key). Push to Engine and store in Postgres.
- Persistent moderation memory. That lives in the Engine's Postgres.

The line is: **ephemeral, subreddit-scoped, key-lookup-only state goes here. Everything else goes to the Engine.**

---

## 9. HTTP Client to the Engine

`services/engineClient.ts` is the only place that talks to the Engine. Everything else goes through it.

### 9.1 Contract

```ts
interface EngineClient {
  investigate(req: InvestigateRequest, opts?: CallOptions): Promise<Verdict>;
  feedback(req: FeedbackRequest, opts?: CallOptions): Promise<void>;
  summarizeThread(req: SummarizeRequest, opts?: CallOptions): Promise<ThreadSummary>;
  showMemory(req: MemoryRequest, opts?: CallOptions): Promise<UserMemory>;
  health(): Promise<HealthStatus>;
}
```

### 9.2 Request Signing (HMAC)

Every outbound request is HMAC-signed with a shared secret stored in Devvit settings (server-side, never exposed to UI). The signature covers:

- Method
- Path
- Timestamp (replay window: 5 minutes)
- Request body hash

Headers added on every request:

```
X-ModPilot-Subreddit: <subredditId>
X-ModPilot-Timestamp: <unix epoch>
X-ModPilot-Signature: <hex hmac>
X-ModPilot-Correlation-Id: <uuid>
```

The Engine rejects any request with a missing or stale signature.

### 9.3 Timeouts

| Endpoint | Timeout | Rationale |
|---|---|---|
| `/investigate` | 6 seconds (trigger path), 10 seconds (menu path) | Triggers must be quick; menu actions can wait |
| `/feedback` | 3 seconds | Non-blocking; retried if it fails |
| `/summarize` | 5 seconds | Menu action; under user attention |
| `/memory` | 2 seconds | Pure DB read; should be fast |
| `/health` | 1 second | Used for kill-switch dashboard surfacing |

### 9.4 Retry Policy

- Idempotent endpoints (`/feedback`, `/memory`, `/health`): retry on timeout/5xx with exponential backoff. Max 3 attempts.
- Non-idempotent endpoints (`/investigate`): never retry from Devvit. Let `retryFailed` job handle it. Why: triggers must return quickly; sustained retries on hot path blow latency budgets.
- 4xx responses: never retry. Log and surface.

### 9.5 Circuit Breaker

If the Engine fails for >10 consecutive requests in a 60-second window, open the circuit:

- Triggers skip the Engine call entirely (mark investigations as `deferred`).
- The dashboard surfaces a banner: "ModPilot is temporarily unavailable. Investigations will resume automatically."
- Half-open every 30 seconds with a single probe call. Close on success.

This is the graceful-degradation guarantee in `10-ReliabilityAndSafety.md`. It must be implemented before MVP ships.

### 9.6 Allowlist Configuration

In `devvit.yaml`:

```yaml
http:
  domains:
    - modpilot-engine.fly.dev
```

We allowlist exactly one domain — the Engine. Never use wildcards. Never allowlist a domain we don't own. Judges check this.

---

## 10. Permissions & Scopes

Every scope requested has a justification. Requesting more than needed is a red flag for production-readiness.

In `devvit.yaml`:

```yaml
permissions:
  reddit:
    asUser: false
    scope:
      - read              # read posts, comments, user profiles
      - modposts          # take mod actions on posts (only when mod clicks)
      - modcontributors   # ban/approve users (only when mod clicks)
      - modlog            # write to mod action log for transparency
      - modwiki           # read subreddit rules from wiki (optional)
```

### Scope-by-scope justification:

- **`read`** — required to fetch comment/post content, author profile, thread context. Used by every trigger and menu action.
- **`modposts`** — required to execute the Remove/Approve/Lock actions when the mod confirms a recommendation. Never used autonomously.
- **`modcontributors`** — required to execute Ban/Mute when the mod escalates. Always mod-confirmed.
- **`modlog`** — required to write our own actions to the mod log for transparency. Mods can see "ModPilot suggested Remove → Mod confirmed" in the standard mod log.
- **`modwiki`** — optional. If the subreddit stores rules in the wiki, we can auto-import them into the `customRules` setting during install. Falls back gracefully if not granted.

### What we deliberately do not request:

- No `mysubs`, no `subscribe`, no `submit`, no `edit`. ModPilot has no need to read the mod's other subscriptions or post on their behalf.
- No private-message scopes. ModPilot is queue-facing, not modmail-facing (for MVP).
- No identity scopes beyond what's needed for moderation context.

This minimal-scope discipline is documented and visible. Each scope's justification is repeated in the App Directory listing.

---

## 11. UI Primitives

Devvit Blocks is our UI runtime. Not React-with-extra-steps; a constrained JSX-like primitive set that renders inside Reddit's clients.

### 11.1 What Blocks Gives Us

- Layout primitives: `vstack`, `hstack`, `zstack`
- Content: `text`, `image`, `icon`
- Interaction: `button`, `form`
- State: hooks (`useState`, `useAsync`)
- Theming: built-in dark/light support via design tokens

### 11.2 What Blocks Doesn't Give Us

- No custom CSS. Style via design tokens in `ui/tokens.ts`.
- No external React libraries (no Recharts, no MUI, no shadcn). We render charts as SVG primitives.
- No DOM access. No `document`, no `window`.
- No animations beyond what Blocks provides natively. Don't try.
- No localStorage/sessionStorage. State is Devvit Redis or in-memory only.

The constraints are tight. Design within them; do not fight them.

### 11.3 Design Tokens

```ts
// ui/tokens.ts
export const tokens = {
  color: {
    riskHigh:   '#D93025',   // red
    riskMedium: '#F9AB00',   // amber
    riskLow:    '#1E8E3E',   // green
    surface:    'neutral-background',
    surfaceAlt: 'neutral-background-weak',
    text:       'neutral-content',
    textWeak:   'neutral-content-weak',
    accent:     'primary-background',
  },
  spacing: {
    xs: 'xsmall', s: 'small', m: 'medium', l: 'large', xl: 'xlarge',
  },
  radius: {
    s: 'small', m: 'medium', l: 'large',
  },
} as const;
```

Use tokens everywhere. Never hardcode color or spacing values. Detailed UX specs live in `09-UX.md`.

### 11.4 Component Inventory (MVP)

| Component | Purpose | Lives in |
|---|---|---|
| `VerdictCard` | One-glance triage card; the signature feature | `ui/VerdictCard.tsx` |
| `InvestigationTimeline` | Expandable evidence trail | `ui/InvestigationTimeline.tsx` |
| `ConfidenceBadge` | Visual treatment of High/Medium/Low confidence | `ui/components/ConfidenceBadge.tsx` |
| `EvidenceRow` | Single evidence item in card or timeline | `ui/components/EvidenceRow.tsx` |
| `ActionBar` | Remove/Approve/Escalate/Lock buttons | `ui/components/ActionBar.tsx` |
| `ColdStartBadge` | "ModPilot is learning your subreddit" indicator | `ui/components/ColdStartBadge.tsx` |
| `ModDashboard` | Custom post: queue + analytics | `ui/ModDashboard.tsx` |
| `FirstRunWizard` | Onboarding flow | `ui/FirstRunWizard.tsx` |

Each component is specified in detail in `09-UX.md`.

---

## 12. Devvit Gotchas

The maintained list of SDK quirks. Append-only. Future contributors will thank you.

### 12.1 Scheduled jobs may not survive `AppUpgrade`

Always re-register jobs in `onAppUpgrade`. Treat them as ephemeral.

### 12.2 Trigger handlers can be invoked more than once for the same event

Idempotency matters. Always check `pending_investigation:<targetId>` before doing work.

### 12.3 Per-invocation memory limits are tight

Don't load large objects (full thread trees, big embedding arrays) into Devvit memory. Push the work to the Engine.

### 12.4 `context.reddit.getCommentById` can return null for deleted/removed content

Always handle the null case. Reports can fire on content that's already been removed by AutoMod between report and trigger.

### 12.5 Settings reads are not transactional

If a mod updates settings during an in-flight investigation, the investigation may use the old values. Acceptable for MVP; revisit if it causes confusion.

### 12.6 Devvit Redis has no `KEYS` command in production

To scan keys (e.g., for `pending_investigation:*`), use `SCAN` with cursor pagination. Never assume `KEYS` works.

### 12.7 `context.scheduler.runJob` with cron requires a string in cron format

The SDK accepts `cron: '* * * * *'` (every minute) but not interval objects. Stick to cron strings.

### 12.8 HTTP allowlist enforced strictly

Any HTTPS call to a domain not in `devvit.yaml` throws. There's no error masking — the call fails hard.

### 12.9 Custom posts cannot directly modify subreddit settings

Settings must be modified through the standard Devvit settings UI by a moderator. The First-Run Wizard cannot programmatically set the personality preset; it can only deep-link the moderator to the settings page with a recommendation.

### 12.10 Form responses are not durable

A form modal closes after submission. Persist form input to Redis immediately on submit; don't rely on the form's own state.

(Update this list as we hit new ones during the build.)

---

## 13. Implementation Order (Build-Time Sequencing)

For the Days 1–10 sprint, build the Devvit app in this order. Each step is a working end-to-end slice.

1. **`main.ts` + `onAppInstall` + `onAppRemove`** — install/uninstall works cleanly.
2. **`settings.ts` + Personality preset** — settings panel is visible and editable.
3. **`engineClient.ts` skeleton + `/health` call** — Devvit can reach the Engine.
4. **`onCommentReport` with stub Engine response** — full path from report → Devvit Redis works.
5. **`VerdictCard` rendering a hardcoded verdict** — UI visible in the mod queue.
6. **Live Engine integration** — real `/investigate` returning real verdicts.
7. **`InvestigationTimeline`** — the signature expansion.
8. **`onModAction` + `/feedback`** — feedback loop closes.
9. **`ModDashboard` custom post** — analytics tile + queue view.
10. **`FirstRunWizard`** — onboarding polish.
11. **Scheduled jobs** — `reprioritizeQueue`, `retryFailed`.
12. **Circuit breaker + graceful degradation** — production-readiness pass.

Polish (loading states, error states, copy review) happens in parallel with steps 9–12, not as a separate phase.

---

## 14. Related Documents

- [`02-Architecture.md`](02-Architecture.md) — Where Devvit sits in the overall system.
- [`04-InvestigationEngine.md`](04-InvestigationEngine.md) — What the Engine does when Devvit calls `/investigate`.
- [`08-API.md`](08-API.md) — Full request/response specs for every Engine endpoint Devvit calls.
- [`09-UX.md`](09-UX.md) — Detailed UI specs for every Blocks component.
- [`10-ReliabilityAndSafety.md`](10-ReliabilityAndSafety.md) — Circuit breaker, kill switch, graceful degradation details.
- [`13-Infra.md`](13-Infra.md) — Engine deployment URL, secret management for the HMAC key.
- [`14-Engineering.md`](14-Engineering.md) — TS coding standards, testing strategy for Devvit handlers.