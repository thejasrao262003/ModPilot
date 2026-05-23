// Public API routes. Mounted at /api in src/index.ts.
// The custom-post webview in src/client/ fetches /api/verdict to populate
// itself, then POSTs to /api/feedback when the mod clicks an action.

import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';

import { recordResolution } from '../services/dedup';
import { ensureSubredditProfile } from '../engine/store/subreddit';
import { GeminiClient } from '../engine/llm/gemini';
import { ResponseDrafter, type DraftInputs } from '../engine/llm/responseDrafter';
import { GEMINI_API_KEY } from '../config/geminiConfig.local';

export const api = new Hono();

type ModAction = 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK';

const VALID_ACTIONS: ReadonlySet<ModAction> = new Set([
  'REMOVE',
  'APPROVE',
  'ESCALATE',
  'LOCK',
] as const);

// POST /api/feedback — moderator clicked an action button in the verdict UI.
// Persists the click + actually performs the moderation via Reddit API.
api.post('/feedback', async (c) => {
  const body = (await c.req.json()) as {
    correlation_id?: string;
    mod_action?: ModAction;
    recommendation?: string;
    source?: 'verdict_card' | 'reddit_native';
    target_id?: string;
  };

  if (!body.correlation_id || !body.mod_action || !VALID_ACTIONS.has(body.mod_action)) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'correlation_id + valid mod_action required',
          retryable: false,
        },
      },
      400,
    );
  }

  // Authorization: only moderators of the current subreddit can take actions.
  // The custom post itself is auto-removed (to the mod queue) by menu.ts, so
  // non-mods shouldn't reach this UI in the first place — but defense in depth:
  // any non-mod hitting this endpoint gets a 403 with no side effects.
  const isMod = await isCallerModerator();
  if (!isMod) {
    console.warn('modpilot.feedback.unauthorized', {
      correlation_id: body.correlation_id,
      user_id: context.userId,
      subreddit_id: context.subredditId,
    });
    return c.json(
      {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only moderators can take action on a ModPilot verdict.',
          retryable: false,
        },
      },
      403,
    );
  }

  const moderator = await safeCurrentUsername();
  const aligned =
    typeof body.recommendation === 'string'
      ? body.mod_action === body.recommendation.toUpperCase()
      : null;

  // Resolve target_id: prefer the body, fall back to the stored verdict hash.
  let targetId = body.target_id;
  let targetKind: 'comment' | 'post' | null = null;
  if (!targetId) {
    const stored = await redis.hGetAll(`verdict:${body.correlation_id}`);
    if (stored?.target_id) {
      targetId = stored.target_id;
      targetKind = stored.target_kind === 'comment' ? 'comment' : 'post';
    }
  } else {
    targetKind = targetId.startsWith('t1_') ? 'comment' : targetId.startsWith('t3_') ? 'post' : null;
  }

  // Perform the moderation action via Reddit API.
  let actionApplied = false;
  let actionError: string | null = null;
  if (targetId && targetKind) {
    try {
      await applyModerationAction({ targetId, targetKind, action: body.mod_action });
      actionApplied = true;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
      console.warn('modpilot.action.failed', {
        correlation_id: body.correlation_id,
        target_id: targetId,
        action: body.mod_action,
        err: actionError,
      });
    }
  }

  const record = {
    correlation_id: body.correlation_id,
    mod_action: body.mod_action,
    recommendation: body.recommendation ?? '',
    source: body.source ?? 'verdict_card',
    moderator: moderator ?? 'unknown',
    aligned: aligned === null ? '' : String(aligned),
    action_applied: String(actionApplied),
    action_error: actionError ?? '',
    at: new Date().toISOString(),
  };

  await redis.hSet(`feedback:${body.correlation_id}`, record);
  await redis.expire(`feedback:${body.correlation_id}`, 60 * 60 * 24 * 7);

  if (targetId) {
    await recordResolution(targetId, {
      correlationId: body.correlation_id,
      modAction: body.mod_action,
      moderatorName: moderator ?? 'unknown',
      rawAction: body.mod_action.toLowerCase(),
      source: body.source ?? 'verdict_card',
    });
  }

  // Bump alignment counter (best-effort) — feeds the Stats menu.
  if (context.subredditId && body.recommendation) {
    try {
      const { bumpAlignmentStats } = await import('../engine/store/stats');
      await bumpAlignmentStats({
        subId: context.subredditId,
        recommendation: body.recommendation.toUpperCase() as ModAction,
        modAction: body.mod_action,
      });
    } catch (err) {
      console.warn('modpilot.feedback.stats_bump_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('modpilot.feedback.recorded', record);
  return c.json({ ok: true, data: record }, 200);
});

async function applyModerationAction(args: {
  targetId: string;
  targetKind: 'comment' | 'post';
  action: ModAction;
}): Promise<void> {
  // Reddit API surfaces: getCommentById/getPostById return objects with
  // .remove(), .approve(), .lock(), .unlock(). ESCALATE is internal (just
  // a status note; no API action) so we no-op there.
  if (args.action === 'ESCALATE') return;

  if (args.targetKind === 'comment') {
    const comment = await reddit.getCommentById(args.targetId as `t1_${string}`);
    if (args.action === 'REMOVE') await comment.remove();
    else if (args.action === 'APPROVE') await comment.approve();
    else if (args.action === 'LOCK') await comment.lock();
  } else {
    const post = await reddit.getPostById(args.targetId as `t3_${string}`);
    if (args.action === 'REMOVE') await post.remove();
    else if (args.action === 'APPROVE') await post.approve();
    else if (args.action === 'LOCK') await post.lock();
  }
}

async function isCallerModerator(): Promise<boolean> {
  // user.modPermissions key shape (id vs name) is inconsistent across Devvit
  // contexts and was returning false for real mods. Authoritative check:
  // resolve the current user's name, then look them up in the subreddit's
  // moderator list. Slower but reliable.
  try {
    const userId = context.userId;
    if (!userId) return false;

    const sub = await reddit.getCurrentSubreddit().catch(() => undefined);
    const subredditName = sub?.name;
    if (!subredditName) return false;

    const user = await reddit.getUserById(userId as `t2_${string}`);
    const username = user?.username;
    if (!username) return false;

    // Cheap path: check the modPermissions map keyed either way.
    if (user) {
      const perms = user.modPermissions;
      if (perms && (perms.has(subredditName) || (context.subredditId && perms.has(context.subredditId)))) {
        return true;
      }
    }

    // Authoritative fallback: scan the subreddit's mod list. Listing.all()
    // is paginated but mod lists are small.
    const subreddit = await reddit.getSubredditByName(subredditName);
    const mods = await subreddit.getModerators({ pageSize: 100 }).all();
    return mods.some((m) => m.username === username);
  } catch (err) {
    console.warn('modpilot.auth.check_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function safeCurrentUsername(): Promise<string | undefined> {
  try {
    const userId = context.userId;
    if (!userId) return undefined;
    const user = await reddit.getUserById(userId as `t2_${string}`);
    return user?.username;
  } catch {
    return undefined;
  }
}

// GET /api/verdict — returns the verdict stored under verdict:{correlation_id}.
// Falls back to a canned verdict if the lookup is empty or fails, so the
// custom-post UI always renders something even if the menu flow didn't run.
// The `c` query param is the correlation_id; if absent we try context.postId
// → its stored postData → correlation_id.
api.get('/verdict', async (c) => {
  let correlationId = c.req.query('c');

  if (!correlationId) {
    correlationId = await readCorrelationFromPostData();
  }
  correlationId ??= 'canned-default';

  let verdict: Record<string, unknown> | null = null;
  let target: Record<string, unknown> | null = null;
  try {
    const row = await redis.hGetAll(`verdict:${correlationId}`);
    if (row?.correlation_id) {
      verdict = projectStoredVerdict(row);
      target = {
        id: row.target_id,
        kind: row.target_kind,
        title: row.target_title,
        author: row.target_author,
      };
    }
  } catch (err) {
    console.warn('modpilot.verdict.lookup_failed', {
      correlation_id: correlationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return c.json(
    {
      ok: true,
      data: verdict ?? cannedVerdict(correlationId),
      target,
    },
    200,
  );
});

// Back-compat: legacy clients hit /api/verdict/canned. Same behaviour now.
api.get('/verdict/canned', async (c) => {
  const correlationId = c.req.query('c') ?? 'canned-default';
  const row = await redis.hGetAll(`verdict:${correlationId}`).catch(() => null);
  return c.json(
    {
      ok: true,
      data:
        row?.correlation_id ? projectStoredVerdict(row) : cannedVerdict(correlationId),
      target: row?.target_id
        ? {
            id: row.target_id,
            kind: row.target_kind,
            title: row.target_title,
            author: row.target_author,
          }
        : null,
    },
    200,
  );
});

async function readCorrelationFromPostData(): Promise<string | undefined> {
  const postId = context.postId;
  // 1) Try the platform-native postData() (Devvit Web 0.12.x sometimes ships it).
  try {
    const postDataFn = (context as unknown as {
      postData?: () => Promise<Record<string, unknown>>;
    }).postData;
    if (postId && typeof postDataFn === 'function') {
      const stored = await postDataFn();
      const cid = stored?.correlation_id;
      if (typeof cid === 'string') return cid;
    }
  } catch {
    // postData isn't available in every render context.
  }
  // 2) Fall back to the post_correlation:{postId} Redis mapping that
  //    menu.ts writes at custom-post creation.
  if (postId) {
    try {
      const cid = await redis.get(`post_correlation:${postId}`);
      if (cid) return cid;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function projectStoredVerdict(row: Record<string, string>): Record<string, unknown> {
  return {
    correlation_id: row.correlation_id,
    target_id: row.target_id,
    target_kind: row.target_kind,
    tier: row.tier ?? 'STANDARD',
    risk_tier: row.risk_tier,
    recommendation: row.recommendation,
    calibrated_confidence: Number.parseFloat(row.calibrated_confidence ?? '0') || 0,
    rationale: row.rationale ?? '',
    top_evidence: parseJsonArray(row.top_evidence_json),
    timeline: parseJsonArray(row.timeline_json),
    confidence_breakdown: parseJsonObject(row.confidence_breakdown_json),
    model_reasoner: row.model_reasoner ?? 'gemini-2.5-pro',
    model_summarizer: row.model_summarizer ?? '',
    cost_usd: Number.parseFloat(row.cost_usd ?? '0') || 0,
    latency_ms: Number.parseInt(row.latency_ms ?? '0', 10) || 0,
    validation_flag: row.validation_flag === 'true',
    degraded: row.degraded === 'true',
    cold_start: row.cold_start === 'true',
    // New explainability + priority surfaces (Features 1-8).
    priority: parseJsonObject(row.priority_json),
    author_signal: parseJsonObject(row.author_signal_json),
    escalation: parseJsonObject(row.escalation_json),
    confidence_factors: parseJsonArray(row.confidence_factors_json),
    key_factors: parseJsonArray(row.key_factors_json),
    rule_matches: parseJsonArray(row.rule_matches_json),
    alignment: parseJsonObject(row.alignment_json),
  };
}

function parseJsonArray(s: string | undefined): unknown[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cannedVerdict(correlationId: string): Record<string, unknown> {
  return {
    correlation_id: correlationId,
    tier: 'DEEP',
    risk_tier: 'HIGH',
    recommendation: 'REMOVE',
    calibrated_confidence: 0.92,
    rationale:
      'Author has [ev-2] three prior removals in this subreddit. Thread shows escalation from turn 8 [ev-5]. Matches Rule 2 [ev-1]. Report velocity confirms the pattern is not a one-off complaint [ev-4].',
    top_evidence: [
      { id: 'ev-4', summary: '4 reports in 6 min (z=6.2) — far above baseline', tool: 'report_velocity' },
      { id: 'ev-2', summary: 'Author: 3 prior removals in last 30 days', tool: 'user_history' },
      { id: 'ev-5', summary: 'Thread escalation detected at turn 8', tool: 'thread_context' },
    ],
    timeline: [
      { tool: 'policy_match', verb: 'Matched against rules', status: 'success', latency_ms: 142, evidence_ids: ['ev-1'] },
      { tool: 'report_velocity', verb: 'Checked report velocity', status: 'success', latency_ms: 23, evidence_ids: ['ev-4'] },
      { tool: 'user_history', verb: 'Pulled author history', status: 'success', latency_ms: 87, evidence_ids: ['ev-2', 'ev-3'] },
      { tool: 'thread_context', verb: 'Read thread context', status: 'success', latency_ms: 1180, evidence_ids: ['ev-5'] },
    ],
    confidence_breakdown: {
      llm_self_report: 0.95,
      evidence_convergence: 0.88,
      subreddit_accuracy: 0.87,
      rule_match_strength: 0.96,
    },
    model_reasoner: 'gemini-2.5-pro',
    model_summarizer: 'gemini-2.5-flash',
    cost_usd: 0.018,
    latency_ms: 1432,
    validation_flag: false,
    degraded: false,
    cold_start: false,
  };
}

// ── FEATURE 9: Moderator Response Generator ─────────────────────────────────
//
// /api/draft-response → generate a draft message based on the action +
//                       optional moderator instructions.
// /api/send-response  → after mod edits + approves, actually send the
//                       message via comment.reply()/post.reply().
//
// Invariants:
//   • Both endpoints require moderator auth.
//   • Send is explicit — we never auto-send.
//   • The action endpoint (/api/feedback) is unchanged; the draft flow is
//     additive. Mods can still skip the draft and just act.

type ModActionUpper = 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK';

api.post('/draft-response', async (c) => {
  const body = (await c.req.json()) as {
    correlation_id?: string;
    mod_action?: ModActionUpper;
    moderator_instructions?: string;
  };

  if (!body.correlation_id || !body.mod_action || !VALID_ACTIONS.has(body.mod_action)) {
    return c.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'correlation_id + valid mod_action required' } },
      400,
    );
  }

  if (!(await isCallerModerator())) {
    return c.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Moderator only.' } }, 403);
  }

  // Pull the verdict + subreddit profile to ground the draft.
  const verdictRow = await redis.hGetAll(`verdict:${body.correlation_id}`);
  if (!verdictRow?.correlation_id) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: 'Verdict not found.' } },
      404,
    );
  }

  const subredditId = context.subredditId;
  if (!subredditId) {
    return c.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing subreddit context.' } },
      400,
    );
  }
  const profile = await ensureSubredditProfile(subredditId);

  const topEvidence = parseJsonArray(verdictRow.top_evidence_json);
  const ruleMatches = parseJsonArray(verdictRow.rule_matches_json);

  const draftInputs: DraftInputs = {
    rules: profile.rules ?? '',
    personality: profile.personality,
    recommendation: (verdictRow.recommendation as DraftInputs['recommendation']) ?? 'NO_RECOMMENDATION',
    modAction: body.mod_action,
    rationale: verdictRow.rationale ?? '',
    evidenceSummary: topEvidence
      .map((r) => (typeof r === 'object' && r && 'summary' in r ? String((r as { summary?: unknown }).summary ?? '') : ''))
      .filter(Boolean),
    matchedRules: ruleMatches
      .map((m) => (typeof m === 'object' && m && 'rule' in m ? String((m as { rule?: unknown }).rule ?? '') : ''))
      .filter(Boolean),
    moderatorInstructions: (body.moderator_instructions ?? '').slice(0, 500),
    targetAuthor: verdictRow.target_author ?? '',
  };

  try {
    const llm = new GeminiClient(GEMINI_API_KEY);
    const drafter = new ResponseDrafter(llm);
    const draft = await drafter.draft(draftInputs, body.correlation_id);
    return c.json({ ok: true, data: draft }, 200);
  } catch (err) {
    console.warn('modpilot.draft.failed', {
      correlation_id: body.correlation_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        ok: false,
        error: {
          code: 'DRAFT_FAILED',
          message: err instanceof Error ? err.message : 'Draft generation failed.',
        },
      },
      502,
    );
  }
});

api.post('/send-response', async (c) => {
  const body = (await c.req.json()) as {
    correlation_id?: string;
    target_id?: string;
    body?: string;          // moderator-edited final draft
    sticky?: boolean;       // optional: distinguish + sticky the reply
  };
  if (!body.correlation_id || !body.target_id || !body.body || !body.body.trim()) {
    return c.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'correlation_id + target_id + non-empty body required' } },
      400,
    );
  }
  if (!(await isCallerModerator())) {
    return c.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Moderator only.' } }, 403);
  }

  const text = body.body.trim().slice(0, 4000);

  try {
    let replyId: string;
    if (body.target_id.startsWith('t1_')) {
      const comment = await reddit.getCommentById(body.target_id as `t1_${string}`);
      const reply = await comment.reply({ text });
      replyId = reply.id;
    } else if (body.target_id.startsWith('t3_')) {
      const post = await reddit.getPostById(body.target_id as `t3_${string}`);
      const reply = await post.addComment({ text });
      replyId = reply.id;
    } else {
      return c.json(
        { ok: false, error: { code: 'BAD_REQUEST', message: 'Unsupported target id.' } },
        400,
      );
    }
    console.log('modpilot.response.sent', {
      correlation_id: body.correlation_id,
      target_id: body.target_id,
      reply_id: replyId,
      body_chars: text.length,
    });
    return c.json({ ok: true, data: { reply_id: replyId } }, 200);
  } catch (err) {
    console.error('modpilot.response.send_failed', {
      correlation_id: body.correlation_id,
      target_id: body.target_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        ok: false,
        error: {
          code: 'SEND_FAILED',
          message: err instanceof Error ? err.message : 'Send failed.',
        },
      },
      502,
    );
  }
});
