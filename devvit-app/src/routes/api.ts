// Public API routes. Mounted at /api in src/index.ts.
// The verdict UI in public/ fetches /api/verdict/canned to populate itself.

import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';

export const api = new Hono();

// S-1.6: feedback recording. The Verdict Card UI POSTs here when a mod
// clicks Remove / Approve / Escalate / Lock. Persists to Devvit Redis under
// `feedback:{correlation_id}` for the engine to aggregate (V-5.x will
// proxy to the engine's /feedback once S-1.2's tunnel is in place).
api.post('/feedback', async (c) => {
  const body = (await c.req.json()) as {
    correlation_id?: string;
    mod_action?: 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK';
    recommendation?: string;
    source?: 'verdict_card' | 'reddit_native';
  };

  if (!body.correlation_id || !body.mod_action) {
    return c.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'correlation_id + mod_action required', retryable: false } },
      400,
    );
  }

  // Identify the moderator from request context where possible.
  const moderator = await safeCurrentUsername();

  const aligned =
    typeof body.recommendation === 'string'
      ? body.mod_action === body.recommendation.toUpperCase()
      : null;

  const record = {
    correlation_id: body.correlation_id,
    mod_action: body.mod_action,
    recommendation: body.recommendation ?? '',
    source: body.source ?? 'verdict_card',
    moderator: moderator ?? 'unknown',
    aligned: aligned === null ? '' : String(aligned),
    at: new Date().toISOString(),
  };

  await redis.hSet(`feedback:${body.correlation_id}`, record);
  await redis.expire(`feedback:${body.correlation_id}`, 60 * 60 * 24 * 7); // 7d retention

  console.log('modpilot.feedback.recorded', record);
  return c.json({ ok: true, data: record }, 200);
});

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

// Canned verdict — mirrors engine/api/canned.py so both UIs render identically.
// S-1.2 will replace this with a real call to the Investigation Engine.
// Spec: docs/Specs.md §10.2.
api.get('/verdict/canned', async (c) => {
  const correlationId = c.req.query('c') ?? 'canned-default';
  let target: Record<string, unknown> | null = null;

  // If the custom post stored its target metadata at creation, surface it for the UI masthead.
  try {
    const postId = context.postId;
    const postDataFn = (context as unknown as { postData?: () => Promise<Record<string, unknown>> }).postData;
    if (postId && typeof postDataFn === 'function') {
      const stored = await postDataFn();
      if (stored && typeof stored.target === 'object' && stored.target !== null) {
        target = stored.target as Record<string, unknown>;
      }
    }
  } catch (_err) {
    // postData isn't available in every render context; the UI degrades gracefully.
  }

  return c.json(
    {
      ok: true,
      data: cannedVerdict(correlationId),
      target,
    },
    200,
  );
});

function cannedVerdict(correlationId: string) {
  return {
    correlation_id: correlationId,
    tier: 'DEEP',
    risk_tier: 'HIGH',
    recommendation: 'REMOVE',
    calibrated_confidence: 0.92,
    rationale:
      'Author has [ev-2] three prior removals in this subreddit. Thread shows escalation from turn 8 [ev-5]. Matches Rule 2 [ev-1]. Report velocity confirms the pattern is not a one-off complaint [ev-4].',
    top_evidence: [
      {
        id: 'ev-4',
        summary: '4 reports in 6 min (z=6.2) — far above baseline',
        tool: 'report_velocity',
      },
      {
        id: 'ev-2',
        summary: 'Author: 3 prior removals in last 30 days',
        tool: 'user_history',
      },
      {
        id: 'ev-5',
        summary: 'Thread escalation detected at turn 8',
        tool: 'thread_context',
      },
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
    input_tokens: 1842,
    output_tokens: 312,
    validation_flag: false,
    degraded: false,
    cold_start: false,
  };
}
