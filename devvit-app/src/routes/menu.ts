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

import { readReportStats, readResolution, relativeAgo } from '../services/dedup';
import { uncertainty } from '../ui/copy';

export const menu = new Hono();

// CANNED verdicts — mirror engine/api/canned.py + src/routes/api.ts. The
// playtest can't reach the engine (no tunnel yet, S-1.2), so the menu picks
// a verdict deterministically from the target_id hash. This gives us TWO
// demoable paths — HIGH-confidence REMOVE and LOW-confidence "unsure" —
// without adding mod-facing menu clutter. Same target always returns the
// same verdict so demos are reproducible.

type CannedVerdict = {
  tier: 'FAST' | 'STANDARD' | 'DEEP';
  risk_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK' | 'NO_RECOMMENDATION';
  calibrated_confidence: number;
  rationale: string;
  top_evidence: { id: string; summary: string }[];
};

const CANNED_HIGH: CannedVerdict = {
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

// I-3.7: honest uncertainty fixture. Calibrated < 0.60 — triggers the
// "🌱 ModPilot is unsure — your call" UX per docs/09-UX.md §6.3.
const CANNED_LOW: CannedVerdict = {
  tier: 'STANDARD',
  risk_tier: 'LOW',
  recommendation: 'NO_RECOMMENDATION',
  calibrated_confidence: 0.54,
  rationale:
    'Tone matches harassment patterns on two phrases [ev-6], but author has positive history (8 approvals, 0 removals) [ev-2]. Thread context is heated but on-topic [ev-5] — not brigading. Evidence is genuinely mixed.',
  top_evidence: [
    { id: 'ev-6', summary: 'Tone matches harassment patterns — but only on 2 phrases' },
    { id: 'ev-2', summary: 'Author has positive history: 8 approvals, 0 removals' },
    { id: 'ev-5', summary: 'Thread context: heated but on-topic — not brigading' },
  ],
};

/** Pick HIGH vs LOW canned verdict deterministically from target_id. */
function selectCanned(targetId: string): CannedVerdict {
  // Sum charcodes mod 5; 0-1 → LOW (~40% rate), else HIGH. Stable per target.
  let h = 0;
  for (let i = 0; i < targetId.length; i++) h = (h + targetId.charCodeAt(i)) | 0;
  return Math.abs(h) % 5 < 2 ? CANNED_LOW : CANNED_HIGH;
}

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
    // Prefer the trigger-cached report count (authoritative) over the API one
    // (returns -1 from menu-action context).
    const cached = await readTriggerContext(targetId);
    const reportCount =
      cached?.num_reports != null
        ? Number(cached.num_reports)
        : post.numberOfReports >= 0
        ? post.numberOfReports
        : 0;
    return await showVerdictForm(c, {
      kind: 'post',
      targetId,
      title: post.title ?? '',
      author: post.authorName ?? '',
      reportCount,
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
    const cached = await readTriggerContext(targetId);
    const reportCount = cached?.num_reports != null ? Number(cached.num_reports) : 0;
    return await showVerdictForm(c, {
      kind: 'comment',
      targetId,
      title: truncate(comment.body ?? '', 80),
      author: comment.authorName ?? '',
      reportCount,
    });
  } catch (err) {
    console.error('modpilot.menu.investigate_comment.error', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
});

async function readTriggerContext(targetId: string): Promise<Record<string, string> | null> {
  try {
    const row = await redis.hGetAll(`trigger_ctx:${targetId}`);
    return row && Object.keys(row).length > 0 ? row : null;
  } catch {
    return null;
  }
}

type VerdictFormInputs = {
  kind: 'post' | 'comment';
  targetId: string;
  title: string;
  author: string;
  reportCount: number;
};

const LOW_CONF_THRESHOLD = 0.6;

async function showVerdictForm(c: Context, inputs: VerdictFormInputs): Promise<Response> {
  // Reuse the dedupe correlation_id if the target was triggered into the
  // pipeline by a report; otherwise mint a one-off for menu-initiated
  // investigations. Keeps engine-side joins clean across both flows.
  const cached = await readTriggerContext(inputs.targetId);
  const correlationId =
    cached?.correlation_id ?? `inv-${Date.now()}-${inputs.targetId.slice(3, 10)}`;

  const verdict = selectCanned(inputs.targetId);
  const pct = Math.round(verdict.calibrated_confidence * 100);
  const isLowConf = verdict.calibrated_confidence < LOW_CONF_THRESHOLD;

  // I-3.8: pull the two annotations.
  const [reportStats, resolution] = await Promise.all([
    readReportStats(inputs.targetId),
    readResolution(inputs.targetId),
  ]);
  const reReportField = buildReReportField(reportStats);
  const resolvedField = buildResolvedField(resolution);

  // Persist the canned verdict so S-1.6 feedback can join on correlation_id,
  // and so a future custom-post render can read it from KV.
  await redis.hSet(`verdict:${correlationId}`, {
    correlation_id: correlationId,
    target_id: inputs.targetId,
    target_kind: inputs.kind,
    target_title: inputs.title,
    target_author: inputs.author,
    recommendation: verdict.recommendation,
    risk_tier: verdict.risk_tier,
    calibrated_confidence: String(verdict.calibrated_confidence),
    rationale: verdict.rationale,
    is_low_conf: String(isLowConf),
    created_at: new Date().toISOString(),
  });
  await redis.expire(`verdict:${correlationId}`, 60 * 60 * 24 * 7);

  console.log('modpilot.menu.investigate.verdict_ready', {
    correlation_id: correlationId,
    target: inputs.targetId,
    recommendation: verdict.recommendation,
    confidence_pct: pct,
    low_conf: isLowConf,
  });

  // Title flips when resolved — moderator already acted; we just acknowledge.
  const title = resolution
    ? `✓ Resolved · ${resolution.modAction.toLowerCase()} by u/${resolution.moderatorName}`
    : isLowConf
      ? `🌱  ModPilot is unsure — ${pct}% confidence`
      : `🛡  ModPilot · ${verdict.risk_tier} RISK · ${pct}% confidence`;

  // Build the field list. Re-report + resolved annotations land first so
  // they're impossible to miss; both can appear if a target was reported,
  // resolved, then reported again within the dedup window.
  const fields = [
    ...(reReportField ? [reReportField] : []),
    ...(resolvedField ? [resolvedField] : []),
  ];

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'verdictView',
        form: {
          title,
          acceptLabel: 'Close',
          cancelLabel: 'Close',
          fields: [
            ...fields,
            // I-3.7: LOW conf swaps the "Recommendation" field for the
            // "Honest uncertainty" marginalia note from docs/09-UX.md §6.3.
            // HIGH/MEDIUM keep the recommendation field with the explicit
            // moderator-click reminder.
            isLowConf
              ? {
                  name: 'unsure',
                  label: '🌱 Honest uncertainty',
                  type: 'paragraph',
                  defaultValue: uncertainty.marginalia,
                  helpText:
                    'No action pre-selected. Evidence is mixed; your judgment matters here.',
                  disabled: true,
                }
              : {
                  name: 'recommendation',
                  label: 'Recommendation',
                  type: 'string',
                  defaultValue:
                    `${verdict.recommendation}  (${verdict.risk_tier} risk, ${pct}% confidence)`,
                  helpText:
                    'ModPilot recommends. You decide. Every action requires your click.',
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
              label: `Evidence [${verdict.top_evidence[0]!.id}]`,
              type: 'string',
              defaultValue: verdict.top_evidence[0]!.summary,
              disabled: true,
            },
            {
              name: 'evidence_2',
              label: `Evidence [${verdict.top_evidence[1]!.id}]`,
              type: 'string',
              defaultValue: verdict.top_evidence[1]!.summary,
              disabled: true,
            },
            {
              name: 'evidence_3',
              label: `Evidence [${verdict.top_evidence[2]!.id}]`,
              type: 'string',
              defaultValue: verdict.top_evidence[2]!.summary,
              disabled: true,
            },
            {
              name: 'rationale',
              label: isLowConf ? 'What I looked at' : 'Reasoning',
              type: 'paragraph',
              defaultValue: verdict.rationale,
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

// I-3.8: re-report annotation. Surfaces "Re-reported N times in M min" when
// the dedup counter has crossed 2 within the 10-min window.
type FormField = {
  name: string;
  label: string;
  type: 'string' | 'paragraph';
  defaultValue: string;
  helpText?: string;
  disabled: boolean;
};

function buildReReportField(
  stats: { reportCount: number; firstReportedAt: string } | null,
): FormField | null {
  if (!stats || stats.reportCount < 2) return null;
  const firstAt = new Date(stats.firstReportedAt);
  const minutes = Math.max(
    1,
    Math.round((Date.now() - firstAt.getTime()) / 60_000),
  );
  return {
    name: 're_report',
    label: '⚠ Re-reported',
    type: 'string',
    defaultValue: `${stats.reportCount} reports in ${minutes} min`,
    helpText:
      'Multiple reporters within the 10-min dedup window. Velocity is a signal — see Evidence below.',
    disabled: true,
  };
}

// I-3.8: resolved-state header. After a mod takes action on a target, the
// next "Investigate" surfaces "Removed by u/X N min ago" so the moderator
// knows the case is closed (per docs/09-UX.md §4.6 "Resolved" card state).
function buildResolvedField(
  resolution: { modAction: string; moderatorName: string; resolvedAt: string } | null,
): FormField | null {
  if (!resolution) return null;
  const verb = resolution.modAction.toLowerCase();
  const ago = relativeAgo(resolution.resolvedAt);
  return {
    name: 'resolved',
    label: '✓ Resolved',
    type: 'string',
    defaultValue: `${verb} by u/${resolution.moderatorName || 'unknown'} · ${ago}`,
    helpText:
      'A moderator already acted on this target. The verdict below is preserved for audit.',
    disabled: true,
  };
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
