// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Today's investigate-comment / investigate-post handlers create a custom
// post via reddit.submitCustomPost and navigate the mod to it. Author-history
// enrichment (validated earlier against u/trendy_guy2003) will move to the
// engine side under I-3.1 — pulling it from the menu request keeps the
// platform's OnAction RPC well under its time budget.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { context, reddit, redis } from '@devvit/web/server';

import { readReportStats, readResolution, relativeAgo } from '../services/dedup';
import { runInvestigation } from '../engine/pipeline';
import { resolveGeminiKey } from '../engine/llm/keyResolver';
import type { Verdict } from '../engine/types';
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

/** ADR-0007: run the investigation in-process inside the Devvit app.
 *  No external backend, no HMAC, no domain approval — calls Gemini directly.
 *  Returns the full live Verdict, or a CannedVerdict-shaped fallback on failure. */
async function fetchEngineVerdict(args: {
  correlationId: string;
  subredditId: string;
  inputs: VerdictFormInputs;
}): Promise<Verdict | null> {
  const t0 = Date.now();
  const resolved = await resolveGeminiKey(args.subredditId);
  if (resolved.source === 'missing' || !resolved.key) {
    console.warn('modpilot.menu.engine.no_key', {
      correlation_id: args.correlationId,
      hint:
        'No Gemini key found. Mods can set one via ModPilot: Configure policy. ' +
        'For local dev, fill devvit-app/src/config/geminiConfig.local.ts.',
    });
    return null;
  }
  console.log('modpilot.menu.engine.key_source', {
    correlation_id: args.correlationId,
    source: resolved.source,
  });
  try {
    const v = await runInvestigation({
      geminiApiKey: resolved.key,
      input: {
        correlationId: args.correlationId,
        subredditId: args.subredditId,
        target: {
          kind: args.inputs.kind,
          id: args.inputs.targetId,
          // Pass title + body separately. Posts have both; the Reasoner
          // needs to see the title because that's often where direct
          // character attacks live ("Rohit is a clown" headline with a
          // mild body). Comments have no title.
          title: args.inputs.kind === 'post' ? args.inputs.title : '',
          body: args.inputs.body || args.inputs.title,
          // The engine uses target.author as the user_memory key. To keep
          // it consistent with what onModAction bumps to (t2_<id>), pass
          // the fullname here. The username is preserved separately for
          // the verdict hash + UI display.
          author: args.inputs.authorId || args.inputs.author,
        },
        reporterCount: args.inputs.reportCount,
      },
    });
    console.log('modpilot.menu.engine.verdict', {
      correlation_id: v.correlationId,
      tier: v.tier,
      recommendation: v.recommendation,
      confidence_pct: Math.round(v.calibratedConfidence * 100),
      cost_usd: v.costUsd,
      latency_ms: Date.now() - t0,
      degraded: v.degraded,
    });
    return v;
  } catch (e) {
    console.warn('modpilot.menu.engine.unavailable', {
      correlation_id: args.correlationId,
      err: e instanceof Error ? e.message : String(e),
      latency_ms: Date.now() - t0,
    });
    return null;
  }
}

/** Build a CannedVerdict-shaped object from a real Verdict, for the form fallback. */
/** Build the Redis hash for `verdict:{correlation_id}`. Centralized so the
 *  form-fallback and custom-post paths persist identical shapes. snake_case
 *  on the wire (the engine's Verdict type is camelCase internally). */
function buildVerdictHashFields(args: {
  correlationId: string;
  inputs: VerdictFormInputs;
  engineResult: Verdict | null;
  verdictForForm: CannedVerdict;
  isLowConf: boolean;
  verdictSource: 'engine' | 'canned';
}): Record<string, string> {
  const v = args.verdictForForm;
  const e = args.engineResult;
  return {
    correlation_id: args.correlationId,
    target_id: args.inputs.targetId,
    target_kind: args.inputs.kind,
    target_title: args.inputs.title,
    target_author: args.inputs.author,
    target_author_id: args.inputs.authorId ?? '',
    recommendation: v.recommendation,
    risk_tier: v.risk_tier,
    tier: v.tier,
    calibrated_confidence: String(v.calibrated_confidence),
    rationale: v.rationale,
    is_low_conf: String(args.isLowConf),
    created_at: new Date().toISOString(),
    top_evidence_json: JSON.stringify(
      e
        ? e.topEvidence.map((row) => ({ id: row.id, summary: row.summary, tool: row.tool }))
        : v.top_evidence,
    ),
    timeline_json: JSON.stringify(
      (e?.timeline ?? []).map((s) => ({
        tool: s.tool,
        verb: s.verb,
        status: s.status,
        latency_ms: s.latencyMs,
        evidence_ids: s.evidenceIds,
      })),
    ),
    confidence_breakdown_json: JSON.stringify(
      e
        ? {
            llm_self_report: e.confidenceBreakdown.llmSelfReport,
            evidence_convergence: e.confidenceBreakdown.evidenceConvergence,
            subreddit_accuracy: e.confidenceBreakdown.subredditAccuracy,
            rule_match_strength: e.confidenceBreakdown.ruleMatchStrength,
          }
        : {},
    ),
    // Feature 1: priority surfaced to UI + future queue sort.
    priority_json: JSON.stringify(
      e?.priority ?? { score: 0, bucket: 'low_risk', headline: 'ℹ️ Low Risk', drivers: [] },
    ),
    // Features 2 + 7: author signal (repeat / first-time / positive / neutral).
    author_signal_json: JSON.stringify(e?.authorSignal ?? null),
    // Feature 5: escalation detection.
    escalation_json: JSON.stringify(
      e?.escalation ?? { level: 'none', headline: null, summary: null, evidenceId: null },
    ),
    // Feature 4: confidence explanation panel.
    confidence_factors_json: JSON.stringify(e?.confidenceFactors ?? []),
    // Feature 8: key factors panel.
    key_factors_json: JSON.stringify(e?.keyFactors ?? []),
    // Feature 6: rule match explainability.
    rule_matches_json: JSON.stringify(e?.ruleMatches ?? []),
    // Feature 3: moderator alignment snapshot.
    alignment_json: JSON.stringify(
      e?.alignment ?? { rate: null, sampleSize: 0, aligned: 0 },
    ),
    // Stage 1 content findings (Reasoner's "Current Content Assessment" bullets).
    content_findings_json: JSON.stringify(e?.contentFindings ?? []),
    model_reasoner: e?.modelReasoner ?? 'gemini-2.5-pro',
    model_summarizer: e?.modelSummarizer ?? '',
    cost_usd: String(e?.costUsd ?? 0),
    latency_ms: String(e?.latencyMs ?? 0),
    validation_flag: String(e?.validationFlag ?? false),
    degraded: String(e?.degraded ?? args.verdictSource === 'canned'),
    cold_start: String(e?.coldStart ?? false),
  };
}

function projectVerdictForForm(v: Verdict): CannedVerdict {
  return {
    tier: v.tier,
    risk_tier: v.riskTier,
    recommendation: v.recommendation,
    calibrated_confidence: v.calibratedConfidence,
    rationale: v.rationale,
    top_evidence: v.topEvidence
      .slice(0, 3)
      .map((row) => ({ id: row.id, summary: row.summary })),
  };
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
    return await showVerdictUI(c, {
      kind: 'post',
      targetId,
      title: post.title ?? '',
      // Self-post text. Link posts have no body; fall back to title so the
      // Reasoner still has *something* content-shaped to read.
      body: post.body ?? post.title ?? '',
      author: post.authorName ?? '',
      authorId: post.authorId ?? '',
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
    return await showVerdictUI(c, {
      kind: 'comment',
      targetId,
      title: truncate(comment.body ?? '', 80),
      body: comment.body ?? '',
      author: comment.authorName ?? '',
      authorId: comment.authorId ?? '',
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
  body: string;
  /** Display name (e.g. "trendy_guy2003"). Shown in UI. */
  author: string;
  /** Reddit user fullname (e.g. "t2_ewyhkkhu"). Used as the user_memory
   *  key so it matches what onModAction's bump uses. CRITICAL — these must
   *  agree across read and write paths or memory data lives in two
   *  separate hashes. */
  authorId: string;
  reportCount: number;
};

const LOW_CONF_THRESHOLD = 0.6;

/** Run the investigation, persist the verdict, then try to open the rich
 *  custom-post webview. If submitPost fails (older Devvit asset-bundling
 *  issue, missing subreddit context, etc.) fall back to the form modal. */
async function showVerdictUI(c: Context, inputs: VerdictFormInputs): Promise<Response> {
  // Compute correlation_id ONCE — bugfix for the dual-ID race where
  // runAndPersistVerdict and submitVerdictPost each minted a Date.now()-based
  // id and ended up storing the verdict under one and mapping the post to the
  // other, leaving the webview unable to find the verdict.
  const cached = await readTriggerContext(inputs.targetId);
  const correlationId =
    cached?.correlation_id ?? `inv-${Date.now()}-${inputs.targetId.slice(3, 10)}`;

  // Step 1: run the engine + persist the verdict.
  await runAndPersistVerdict(correlationId, inputs);

  // Step 2: try the rich UI (custom post + navigateTo).
  try {
    const postResp = await submitVerdictPost(c, correlationId, inputs);
    if (postResp) return postResp;
  } catch (err) {
    console.warn('modpilot.menu.custom_post.failed', {
      target_id: inputs.targetId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: fall back to the form modal.
  return await showVerdictForm(c, inputs, correlationId);
}

async function runAndPersistVerdict(
  correlationId: string,
  inputs: VerdictFormInputs,
): Promise<string> {
  // If we already persisted this correlation in the same playtest, skip the LLM call.
  const existing = await redis.hGetAll(`verdict:${correlationId}`);
  if (existing?.correlation_id) {
    return correlationId;
  }

  const cached = await readTriggerContext(inputs.targetId);
  const engineResult = await fetchEngineVerdict({
    correlationId,
    // context.subredditId is the authoritative current sub on a menu click.
    // cached?.subreddit_id is only populated if a report trigger ran first.
    subredditId: context.subredditId ?? cached?.subreddit_id ?? '',
    inputs,
  });
  const verdict = engineResult
    ? projectVerdictForForm(engineResult)
    : selectCanned(inputs.targetId);
  const isLowConf = verdict.calibrated_confidence < LOW_CONF_THRESHOLD;
  const verdictSource: 'engine' | 'canned' = engineResult ? 'engine' : 'canned';

  await redis.hSet(
    `verdict:${correlationId}`,
    buildVerdictHashFields({
      correlationId,
      inputs,
      engineResult,
      verdictForForm: verdict,
      isLowConf,
      verdictSource,
    }),
  );
  await redis.expire(`verdict:${correlationId}`, 60 * 60 * 24 * 7);
  return correlationId;
}

async function submitVerdictPost(
  c: Context,
  correlationId: string,
  inputs: VerdictFormInputs,
): Promise<Response | null> {
  const subreddit = await reddit.getCurrentSubreddit();
  if (!subreddit?.name) return null;

  const stored = await redis.hGetAll(`verdict:${correlationId}`);
  const recommendation = stored?.recommendation ?? 'NO_RECOMMENDATION';
  const conf = Number.parseFloat(stored?.calibrated_confidence ?? '0') || 0;
  const pct = Math.round(conf * 100);

  // Match the in-webview low-conf label. The post TITLE used to read
  // "APPROVE · 47%" even when the webview correctly showed "Review
  // Recommended" — that disagreement read as the engine contradicting
  // itself. Now they agree.
  const titleVerb = labelForPostTitle(recommendation, conf);

  const post = await reddit.submitCustomPost({
    subredditName: subreddit.name,
    title: `🛡 ModPilot · ${titleVerb} · ${pct}% · ${truncate(inputs.title || inputs.targetId, 60)}`,
    postData: { correlation_id: correlationId },
    textFallback: {
      text: `ModPilot verdict for ${inputs.targetId}: ${titleVerb} (${pct}% confidence).`,
    },
  });

  // Visibility: ModPilot verdict posts are an internal mod tool, not feed content.
  // Auto-remove so the post lands in the mod queue (visible only to mods).
  // The webview still works when mods open it from the queue; non-mods can't
  // see it in their feed or open it.
  try {
    await post.remove();
  } catch (err) {
    console.warn('modpilot.menu.custom_post.auto_remove_failed', {
      post_id: post.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Belt-and-suspenders: map post id → correlation_id in Redis so /api/verdict
  // can rehydrate even if context.postData() isn't available in the webview.
  await redis.set(`post_correlation:${post.id}`, correlationId, {
    expiration: new Date(Date.now() + 60 * 60 * 24 * 7 * 1000),
  });

  console.log('modpilot.menu.custom_post.created', {
    correlation_id: correlationId,
    post_id: post.id,
    permalink: post.permalink,
  });

  return c.json<UiResponse>(
    {
      navigateTo: `https://reddit.com${post.permalink}`,
    },
    200,
  );
}

async function showVerdictForm(
  c: Context,
  inputs: VerdictFormInputs,
  correlationIdIn?: string,
): Promise<Response> {
  // Reuse the dedupe correlation_id if the target was triggered into the
  // pipeline by a report; otherwise mint a one-off for menu-initiated
  // investigations. Caller (showVerdictUI) passes correlationIdIn to keep
  // form fallback and custom-post path on the same id.
  const cached = await readTriggerContext(inputs.targetId);
  const correlationId =
    correlationIdIn ?? cached?.correlation_id ?? `inv-${Date.now()}-${inputs.targetId.slice(3, 10)}`;

  // S-1.2: try the real engine first; fall back to a canned verdict only
  // if the engine is unreachable. Per Specs §13.1 graceful degradation —
  // the moderator always sees *something*, never an error.
  const engineResult = await fetchEngineVerdict({
    correlationId,
    // context.subredditId is the authoritative current sub on a menu click.
    // cached?.subreddit_id is only populated if a report trigger ran first.
    subredditId: context.subredditId ?? cached?.subreddit_id ?? '',
    inputs,
  });
  const verdict = engineResult
    ? projectVerdictForForm(engineResult)
    : selectCanned(inputs.targetId);
  const verdictSource: 'engine' | 'canned' = engineResult ? 'engine' : 'canned';

  const pct = Math.round(verdict.calibrated_confidence * 100);
  const isLowConf = verdict.calibrated_confidence < LOW_CONF_THRESHOLD;

  // I-3.8: pull the two annotations.
  const [reportStats, resolution] = await Promise.all([
    readReportStats(inputs.targetId),
    readResolution(inputs.targetId),
  ]);
  const reReportField = buildReReportField(reportStats);
  const resolvedField = buildResolvedField(resolution);

  // Persist the verdict so the custom-post webview can rehydrate it.
  // Includes the full top_evidence + timeline + confidence_breakdown as JSON
  // so /api/verdict can return everything without a second engine call.
  await redis.hSet(`verdict:${correlationId}`, {
    correlation_id: correlationId,
    target_id: inputs.targetId,
    target_kind: inputs.kind,
    target_title: inputs.title,
    target_author: inputs.author,
    recommendation: verdict.recommendation,
    risk_tier: verdict.risk_tier,
    tier: verdict.tier,
    calibrated_confidence: String(verdict.calibrated_confidence),
    rationale: verdict.rationale,
    is_low_conf: String(isLowConf),
    created_at: new Date().toISOString(),
    // Rich shape for the webview — JSON-encoded.
    // Wire-format (snake_case) so the client's main.js can render without
    // a per-field mapping. The engine's Verdict type is camelCase internally.
    top_evidence_json: JSON.stringify(
      engineResult
        ? engineResult.topEvidence.map((e) => ({ id: e.id, summary: e.summary, tool: e.tool }))
        : verdict.top_evidence,
    ),
    timeline_json: JSON.stringify(
      (engineResult?.timeline ?? []).map((s) => ({
        tool: s.tool,
        verb: s.verb,
        status: s.status,
        latency_ms: s.latencyMs,
        evidence_ids: s.evidenceIds,
      })),
    ),
    confidence_breakdown_json: JSON.stringify(
      engineResult
        ? {
            llm_self_report: engineResult.confidenceBreakdown.llmSelfReport,
            evidence_convergence: engineResult.confidenceBreakdown.evidenceConvergence,
            subreddit_accuracy: engineResult.confidenceBreakdown.subredditAccuracy,
            rule_match_strength: engineResult.confidenceBreakdown.ruleMatchStrength,
          }
        : {},
    ),
    model_reasoner: engineResult?.modelReasoner ?? 'gemini-2.5-pro',
    model_summarizer: engineResult?.modelSummarizer ?? '',
    cost_usd: String(engineResult?.costUsd ?? 0),
    latency_ms: String(engineResult?.latencyMs ?? 0),
    validation_flag: String(engineResult?.validationFlag ?? false),
    degraded: String(engineResult?.degraded ?? verdictSource === 'canned'),
    cold_start: String(engineResult?.coldStart ?? false),
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
            // Evidence rows — render only what the verdict actually produced.
            // The degraded fallback path (Reasoner failed twice) can return
            // fewer than 3 rows; older code unconditionally indexed [0..2]
            // and crashed with `Cannot read properties of undefined`.
            ...verdict.top_evidence.slice(0, 3).map((ev, i) => ({
              name: `evidence_${i + 1}`,
              label: `Evidence [${ev.id}]`,
              type: 'string' as const,
              defaultValue: ev.summary,
              disabled: true,
            })),
            {
              name: 'rationale',
              label: isLowConf ? 'What I looked at' : 'Reasoning',
              type: 'paragraph',
              defaultValue: verdict.rationale,
              disabled: true,
              helpText:
                verdictSource === 'engine'
                  ? `Correlation id: ${correlationId} · live engine verdict · model: gemini-2.5-pro`
                  : `Correlation id: ${correlationId} · canned (engine unreachable) · gemini-2.5-pro`,
            },
          ],
        },
      },
    },
    200,
  );
}


/** Label used in the custom-post TITLE. Must agree with the in-webview
 *  titleFor() in client/main.js — when calibrated confidence is below the
 *  action threshold (60%), the post title should say REVIEW / FLAGGED
 *  instead of APPROVE / REMOVE, so the moderator sees consistent framing
 *  in the mod queue list and inside the verdict UI. */
function labelForPostTitle(recommendation: string, confidence: number): string {
  if (recommendation === 'NO_RECOMMENDATION') return 'REVIEW';
  if (confidence < 0.60) {
    if (recommendation === 'REMOVE' || recommendation === 'LOCK') return 'REVIEW (rule concern)';
    if (recommendation === 'APPROVE') return 'REVIEW (likely benign)';
    if (recommendation === 'ESCALATE') return 'REVIEW (mixed signals)';
    return 'REVIEW';
  }
  return recommendation; // 60%+ — show the firm label
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
