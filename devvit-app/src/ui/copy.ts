// User-facing copy — centralized per docs/09-UX.md UX invariant §15.8.
// UI components NEVER inline strings. Every label, badge, banner, toast,
// modal title, and tooltip is exported from this file with a stable name.
//
// Banned-terminology check runs in CI (scripts/check-banned-terms.sh) against
// this file + the rest of src/. See docs/Glossary.md for the banned list.

// === Risk tier labels (docs/Glossary.md §4) ===========================
export const riskTier = {
  high: 'High risk',
  medium: 'Medium',
  low: 'Low conf.',
  unsure: 'Low conf.',
} as const;

// === Recommendation phrasing — docs/09-UX.md §4.7 =====================
// Capitalization differs by confidence tier; keep exact text.
export const recommendation = {
  highConfRemove: 'ModPilot recommends: **Remove**',
  highConfApprove: 'ModPilot recommends: **Approve**',
  highConfEscalate: 'ModPilot recommends: **Escalate**',
  highConfLock: 'ModPilot recommends: **Lock**',
  mediumConfAny: 'ModPilot suggests',
  lowConf: 'ModPilot is unsure — your call',
  coldStart: 'ModPilot is learning — surfacing evidence only',
} as const;

// === Honest uncertainty UX — docs/09-UX.md §6.3 =======================
// THE single most demoable trust feature. Centralized; never inline.
export const uncertainty = {
  badge: '🌱 ModPilot is unsure — your call',
  marginalia:
    "I found the following but I'm not confident enough to recommend an action. " +
    'Your judgment matters here.',
} as const;

// === Action button labels — docs/09-UX.md §4.4 ========================
export const action = {
  remove: 'Remove',
  approve: 'Approve',
  escalate: 'Escalate',
  lock: 'Lock',
} as const;

// === Action confirmations — docs/09-UX.md §10.1 =======================
export const confirm = {
  remove: 'Remove? [Yes] [Cancel]',
  approve: 'Approve? [Yes] [Cancel]',
  escalate: 'Escalate? [Yes] [Cancel]',
  lock: 'Lock thread? [Yes] [Cancel]',
} as const;

// === Action toasts (post-success) =====================================
export const toast = {
  removed: 'Removed. Feedback recorded.',
  approved: 'Approved. Feedback recorded.',
  escalated: 'Escalated. Feedback recorded.',
  locked: 'Locked. Feedback recorded.',
  failedReddit: 'Reddit rejected the action. Try again or do it manually.',
} as const;

// === Tool verb map — docs/Glossary.md §6, docs/09-UX.md §5.4 ==========
// Internal snake_case tool names → user-facing past-tense verbs.
// NEVER expose raw tool names in the UI.
export const toolVerb = {
  policy_match: 'Matched against rules',
  report_velocity: 'Checked report velocity',
  user_history: 'Pulled author history',
  prior_actions: 'Reviewed prior mod actions',
  thread_context: 'Read thread context',
} as const;

export type ToolName = keyof typeof toolVerb;

// === Confidence breakdown labels — docs/09-UX.md §5.3 =================
export const confidenceLabel = {
  llmSelfReport: 'LLM self-report',
  evidenceConvergence: 'Evidence convergence',
  subredditAccuracy: 'Sub accuracy (30d)',
  ruleMatchStrength: 'Rule-match strength',
} as const;

// === Confidence tier indicators =======================================
export const confidenceTier = {
  high: '▲ High tier',
  medium: '● Medium tier',
  low: '▼ Low tier',
} as const;

// === Cold-start badge — docs/09-UX.md §12 =============================
export const coldStart = {
  badge: (current: number, threshold = 50): string =>
    `🌱 ModPilot is learning your subreddit (${current} / ${threshold} feedback events).`,
  badgeFollowup:
    'Recommendations will become more confident as you provide feedback.',
  explainer:
    'We use the first 50 of your moderation decisions to calibrate ModPilot to your ' +
    "subreddit's style. During this window, ModPilot is more cautious and never " +
    'pre-fills action buttons.',
} as const;

// === Empty states — docs/09-UX.md §11.1 ===============================
export const empty = {
  queue: 'Nothing in the queue right now. ModPilot is ready when something comes in.',
  noUserMemory: "First time we've seen this user in your subreddit.",
  coldStartIdle: "ModPilot is set up. We'll surface investigations as reports come in.",
  wizardPending: 'Set up ModPilot in under 3 minutes →',
} as const;

// === Error states — docs/09-UX.md §11.2 ===============================
export const error = {
  engineUnreachable:
    "ModPilot is temporarily unavailable. Reddit's queue continues working normally.",
  killSwitch: 'ModPilot is paused. Re-enable in settings.',
  rateLimited: (resumeAt: string): string =>
    `ModPilot is throttled for this hour to stay within budget. Investigations resume at ${resumeAt}.`,
  timeout: 'Investigation timed out — partial evidence below.',
  reasonerDegraded: 'Basic signals only — full reasoning unavailable.',
  validationFlagged: 'ModPilot is unsure about this analysis',
} as const;

// === Card state annotations — docs/09-UX.md §4.6 ======================
export const cardState = {
  loading: 'ModPilot is investigating…',
  partial: 'Partial investigation — budget reached',
  reReported: (count: number, withinMinutes: number): string =>
    `Re-reported ${count} times in ${withinMinutes} min`,
  resolved: (action: string, moderator: string, agoLabel: string): string =>
    `✓ ${action} by u/${moderator} ${agoLabel}`,
} as const;

// === Investigation Timeline early-exit notes — docs/09-UX.md §5.5 =====
export const timelineExit = {
  converged: (step: number): string => `→ Stopped early — evidence converged at step ${step}`,
  budgetReached: (step: number): string =>
    `→ Stopped early — budget reached after step ${step}`,
} as const;

// === Banners / dashboard chrome =======================================
export const dashboard = {
  investigatedToday: 'investigated today',
  timeSaved: 'time saved',
  acceptanceRate: 'acceptance rate',
  costToday: "today's cost",
  accuracyFooter: (pct: number): string =>
    `ModPilot accuracy in your subreddit: ${pct}% (last 30 days)`,
} as const;

// === Menu action labels — docs/09-UX.md §9 ============================
export const menu = {
  investigate: 'Investigate with ModPilot',
  summarize: 'Summarize this thread',
  memory: 'Show Moderation Memory',
  explainLast: "Explain ModPilot's last call",
  wipeMemory: "Wipe this user's memory",
} as const;
