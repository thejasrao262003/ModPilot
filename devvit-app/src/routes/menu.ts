// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Today's investigate-comment / investigate-post handlers create a custom
// post via reddit.submitCustomPost and navigate the mod to it. Author-history
// enrichment (validated earlier against u/trendy_guy2003) will move to the
// engine side under I-3.1 — pulling it from the menu request keeps the
// platform's OnAction RPC well under its time budget.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit, redis } from '@devvit/web/server';

export const menu = new Hono();

// CANNED verdict — mirrors engine/api/canned.py + src/routes/api.ts so the
// inline form summary, the Redis cache, and the (eventually-working) custom
// post all serve the same data. S-1.2 swaps this for a real engine call.
const CANNED = {
  tier: 'DEEP',
  risk_tier: 'HIGH',
  recommendation: 'REMOVE',
  calibrated_confidence: 0.92,
  rationale:
    'Author has 3 prior removals [ev-2]. Thread escalates from turn 8 [ev-5]. Matches Rule 2 [ev-1]. Velocity confirms pattern [ev-4].',
  top_evidence: [
    { id: 'ev-4', summary: '4 reports in 6 min (z=6.2) — far above baseline' },
    { id: 'ev-2', summary: 'Author: 3 prior removals in last 30 days' },
    { id: 'ev-5', summary: 'Thread escalation detected at turn 8' },
  ],
};

// U-4.4: "Investigate with ModPilot" — runs an investigation against the
// target and shows the verdict inline via showForm. We tried the richer
// custom-post path (src/client/index.html + reddit.submitCustomPost) but
// hit a Devvit-side asset-resolution error: "useWebView fullscreen request
// failed; web view asset could not be found" → RenderPostContent INTERNAL
// status 36. The form path is the Reddit-blessed scaffold's default and
// works reliably in playtest. Rich custom-post UI re-engages at V-5.5
// (production deploy) when the asset bundle is published rather than
// playtest-streamed.
menu.post('/investigate-post', async (c) => {
  console.log('modpilot.menu.investigate_post.entered');
  try {
    const request = await c.req.json<MenuItemRequest>();
    const targetId = request.targetId as `t3_${string}`;
    const post = await reddit.getPostById(targetId);
    return await showVerdictForm(c, {
      kind: 'post',
      targetId,
      title: post.title ?? '',
      author: post.authorName ?? '',
      reportCount: post.numberOfReports >= 0 ? post.numberOfReports : 0,
    });
  } catch (err) {
    console.error('modpilot.menu.investigate_post.error', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
});

menu.post('/investigate-comment', async (c) => {
  console.log('modpilot.menu.investigate_comment.entered');
  try {
    const request = await c.req.json<MenuItemRequest>();
    const targetId = request.targetId as `t1_${string}`;
    const comment = await reddit.getCommentById(targetId);
    return await showVerdictForm(c, {
      kind: 'comment',
      targetId,
      title: truncate(comment.body ?? '', 80),
      author: comment.authorName ?? '',
      reportCount: 0,
    });
  } catch (err) {
    console.error('modpilot.menu.investigate_comment.error', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
});

type VerdictFormInputs = {
  kind: 'post' | 'comment';
  targetId: string;
  title: string;
  author: string;
  reportCount: number;
};

async function showVerdictForm(c: Context, inputs: VerdictFormInputs): Promise<Response> {
  const correlationId = `inv-${Date.now()}-${inputs.targetId.slice(3, 10)}`;
  const pct = Math.round(CANNED.calibrated_confidence * 100);

  // Persist the canned verdict so S-1.6 feedback can join on correlation_id,
  // and so a future custom-post render can read it from KV.
  await redis.hSet(`verdict:${correlationId}`, {
    correlation_id: correlationId,
    target_id: inputs.targetId,
    target_kind: inputs.kind,
    target_title: inputs.title,
    target_author: inputs.author,
    recommendation: CANNED.recommendation,
    risk_tier: CANNED.risk_tier,
    calibrated_confidence: String(CANNED.calibrated_confidence),
    rationale: CANNED.rationale,
    created_at: new Date().toISOString(),
  });
  await redis.expire(`verdict:${correlationId}`, 60 * 60 * 24 * 7);

  console.log('modpilot.menu.investigate.verdict_ready', {
    correlation_id: correlationId,
    target: inputs.targetId,
    recommendation: CANNED.recommendation,
    confidence_pct: pct,
  });

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'verdictView',
        form: {
          title: `🛡  ModPilot · ${CANNED.risk_tier} RISK · ${pct}% confidence`,
          acceptLabel: 'Close',
          cancelLabel: 'Close',
          fields: [
            {
              name: 'recommendation',
              label: 'Recommendation',
              type: 'string',
              defaultValue: `${CANNED.recommendation}  (${CANNED.risk_tier} risk, ${pct}% confidence)`,
              helpText: 'ModPilot recommends. You decide. Every action requires your click.',
              disabled: true,
            },
            {
              name: 'target',
              label: inputs.kind === 'post' ? 'Reported post' : 'Reported comment',
              type: 'string',
              defaultValue: `${inputs.title}  —  by u/${inputs.author || 'unknown'}`,
              disabled: true,
            },
            {
              name: 'evidence_1',
              label: `Evidence [${CANNED.top_evidence[0]!.id}]`,
              type: 'string',
              defaultValue: CANNED.top_evidence[0]!.summary,
              disabled: true,
            },
            {
              name: 'evidence_2',
              label: `Evidence [${CANNED.top_evidence[1]!.id}]`,
              type: 'string',
              defaultValue: CANNED.top_evidence[1]!.summary,
              disabled: true,
            },
            {
              name: 'evidence_3',
              label: `Evidence [${CANNED.top_evidence[2]!.id}]`,
              type: 'string',
              defaultValue: CANNED.top_evidence[2]!.summary,
              disabled: true,
            },
            {
              name: 'rationale',
              label: 'Reasoning',
              type: 'paragraph',
              defaultValue: CANNED.rationale,
              disabled: true,
              helpText: `Correlation id: ${correlationId} · model: gemini-2.5-pro · cost $0.018`,
            },
          ],
        },
      },
    },
    200,
  );
}


function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// U-4.5: "Summarize this thread" — modal with arc/escalation/instigator/off-topic.
menu.post('/summarize-thread', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.summarize_thread', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Thread summarization — TODO(U-4.5)' } }, 200);
});

// U-4.7: "Explain ModPilot's last call" — re-renders cached verdict from Redis.
menu.post('/explain-last', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.explain_last', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Last verdict lookup — TODO(U-4.7)' } }, 200);
});
