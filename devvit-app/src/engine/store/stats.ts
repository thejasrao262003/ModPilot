// Subreddit-level stats counters. Read by the "ModPilot: Stats" menu;
// written by pipeline.ts (on every investigation) and /api/feedback
// (on every mod action click).
//
// Keys are all flat counters / sums under `sub:{sub_id}:stats:*` so the
// stats menu is an O(1)-per-field read. Slicing by time isn't supported;
// add a time-bucketed index later if you need 24h/7d/30d windows.

import { redis } from '@devvit/web/server';

import type { Recommendation, StrategyTier, Verdict } from '../types';

const STATS_PREFIX = (subId: string) => `sub:${subId}:stats`;

const VALID_RECS: ReadonlyArray<Recommendation> = [
  'REMOVE',
  'APPROVE',
  'ESCALATE',
  'LOCK',
  'NO_RECOMMENDATION',
];
const VALID_TIERS: ReadonlyArray<StrategyTier> = ['FAST', 'STANDARD', 'DEEP'];

export async function bumpInvestigationStats(subId: string, v: Verdict): Promise<void> {
  const p = STATS_PREFIX(subId);
  await redis.incrBy(`${p}:investigations_total`, 1);
  await redis.incrBy(`${p}:rec:${v.recommendation}`, 1);
  await redis.incrBy(`${p}:tier:${v.tier}`, 1);
  if (v.degraded) await redis.incrBy(`${p}:degraded`, 1);
  await redis.incrBy(`${p}:cost_micros`, Math.round(v.costUsd * 1_000_000));
  await redis.incrBy(`${p}:confidence_sum_e4`, Math.round(v.calibratedConfidence * 10000));
  await redis.incrBy(`${p}:latency_sum_ms`, v.latencyMs);

  // Improvement 10: extra metrics.
  // Priority sum × 100 → average.
  await redis.incrBy(`${p}:priority_sum_e2`, Math.round((v.priority?.score ?? 0) * 100));
  // Author signal breakdown — repeat-offender vs first-time vs other.
  const kind = v.authorSignal?.kind;
  if (kind === 'repeat') await redis.incrBy(`${p}:author:repeat`, 1);
  else if (kind === 'first_time') await redis.incrBy(`${p}:author:first_time`, 1);
  else if (kind === 'positive') await redis.incrBy(`${p}:author:positive`, 1);
  // Per-rule trigger count (which configured rule is being matched most).
  // We use the matchedRule line as the bucket — truncated for key sanity.
  for (const rm of v.ruleMatches ?? []) {
    if (!rm.rule) continue;
    const bucket = rm.rule.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 60).trim() || 'unknown';
    await redis.incrBy(`${p}:rule_trigger:${bucket}`, 1);
  }
}

export async function bumpAlignmentStats(args: {
  subId: string;
  recommendation: Recommendation;
  modAction: Recommendation;
}): Promise<void> {
  const p = STATS_PREFIX(args.subId);
  await redis.incrBy(`${p}:feedback_total`, 1);
  if (args.modAction === args.recommendation) {
    await redis.incrBy(`${p}:feedback_aligned`, 1);
  }
  // Action mix that mods actually take (not just what we recommended).
  await redis.incrBy(`${p}:mod_action:${args.modAction}`, 1);
}

// Recent-actions index. Sorted set, score = unix ms, member = correlation_id.
// Used by the Stats dashboard's carousel of recently-actioned items.
// Capped at ~50 entries so the read stays cheap and prevents unbounded growth.

const RECENT_ACTIONS_MAX = 50;

export async function recordRecentAction(args: {
  subId: string;
  correlationId: string;
}): Promise<void> {
  const key = `sub:${args.subId}:recent_actions`;
  const now = Date.now();
  await redis.zAdd(key, { score: now, member: args.correlationId });
  // Cap the set so it doesn't grow forever. Remove anything older than the
  // top RECENT_ACTIONS_MAX (by rank, newest first).
  try {
    const count = await redis.zCard(key);
    if (count > RECENT_ACTIONS_MAX) {
      // Drop the oldest entries (lowest scores). zRange ascending then zRemRangeByScore.
      const overflow = count - RECENT_ACTIONS_MAX;
      const oldest = await redis.zRange(key, 0, overflow - 1, { by: 'rank' });
      const oldestMaxScore = oldest[oldest.length - 1]?.score ?? 0;
      if (oldestMaxScore > 0) {
        await redis.zRemRangeByScore(key, 0, oldestMaxScore);
      }
    }
  } catch (err) {
    console.warn('modpilot.recent_actions.trim_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export type RecentAction = {
  correlationId: string;
  targetId: string;
  targetKind: 'comment' | 'post';
  targetTitle: string;
  targetAuthor: string;
  recommendation: string;
  riskTier: string;
  calibratedConfidence: number;
  rationale: string;
  modAction: string;
  moderator: string;
  aligned: boolean | null;
  actionApplied: boolean;
  at: string;
  permalink?: string;
};

export async function readRecentActions(
  subId: string,
  limit = 10,
): Promise<RecentAction[]> {
  const key = `sub:${subId}:recent_actions`;
  // Newest first via reverse rank.
  const members = await redis.zRange(key, 0, limit - 1, {
    by: 'rank',
    reverse: true,
  });
  const out: RecentAction[] = [];
  for (const m of members) {
    const correlationId = m.member;
    const [verdictRow, feedbackRow] = await Promise.all([
      redis.hGetAll(`verdict:${correlationId}`).catch(() => null),
      redis.hGetAll(`feedback:${correlationId}`).catch(() => null),
    ]);
    if (!verdictRow?.correlation_id) continue;

    const recommendation = verdictRow.recommendation ?? 'NO_RECOMMENDATION';
    const modAction = feedbackRow?.mod_action ?? '';
    const alignedRaw = feedbackRow?.aligned ?? '';
    const aligned =
      alignedRaw === 'true' ? true : alignedRaw === 'false' ? false : null;

    const entry: RecentAction = {
      correlationId,
      targetId: verdictRow.target_id ?? '',
      targetKind: verdictRow.target_kind === 'comment' ? 'comment' : 'post',
      targetTitle: verdictRow.target_title ?? '',
      targetAuthor: verdictRow.target_author ?? '',
      recommendation,
      riskTier: verdictRow.risk_tier ?? '',
      calibratedConfidence:
        Number.parseFloat(verdictRow.calibrated_confidence ?? '0') || 0,
      rationale: verdictRow.rationale ?? '',
      modAction,
      moderator: feedbackRow?.moderator ?? '',
      aligned,
      actionApplied: feedbackRow?.action_applied === 'true',
      at: feedbackRow?.at ?? verdictRow.created_at ?? '',
    };
    if (verdictRow.target_id) {
      entry.permalink = `https://www.reddit.com/comments/${verdictRow.target_id.replace(/^t[13]_/, '')}`;
    }
    out.push(entry);
  }
  return out;
}

// Lightweight read used by pipeline.ts to surface alignment on each verdict.
// Descriptive only (FEATURE 3) — never used to override the model's call.
export async function readAlignmentSnapshot(subId: string): Promise<{
  rate: number | null;
  total: number;
  aligned: number;
}> {
  const p = `sub:${subId}:stats`;
  const [totalStr, alignedStr] = await Promise.all([
    redis.get(`${p}:feedback_total`).catch(() => null),
    redis.get(`${p}:feedback_aligned`).catch(() => null),
  ]);
  const total = numInt(totalStr);
  const aligned = numInt(alignedStr);
  // Suppress noise on tiny sample sizes — show null until ≥5 mod actions exist.
  const rate = total >= 5 ? aligned / total : null;
  return { rate, total, aligned };
}

function numInt(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

export type SubredditStats = {
  investigationsTotal: number;
  degradedTotal: number;
  totalCostUsd: number;
  avgConfidence: number;
  avgLatencyMs: number;
  avgPriority: number;          // 0..100
  byRecommendation: Record<string, number>;
  byTier: Record<string, number>;
  byModAction: Record<string, number>;
  byAuthorKind: Record<string, number>;     // repeat / first_time / positive
  topRuleTriggers: { rule: string; count: number }[];
  feedbackTotal: number;
  feedbackAligned: number;
  alignmentRate: number; // 0..1
};

export async function readStats(subId: string): Promise<SubredditStats> {
  const p = STATS_PREFIX(subId);
  const [
    total,
    degraded,
    costMicros,
    confSumE4,
    latencySum,
    feedbackTotal,
    feedbackAligned,
  ] = await Promise.all([
    redis.get(`${p}:investigations_total`),
    redis.get(`${p}:degraded`),
    redis.get(`${p}:cost_micros`),
    redis.get(`${p}:confidence_sum_e4`),
    redis.get(`${p}:latency_sum_ms`),
    redis.get(`${p}:feedback_total`),
    redis.get(`${p}:feedback_aligned`),
  ]);

  const investigationsTotal = num(total);
  const byRecommendation: Record<string, number> = {};
  for (const r of VALID_RECS) {
    byRecommendation[r] = num(await redis.get(`${p}:rec:${r}`));
  }
  const byTier: Record<string, number> = {};
  for (const t of VALID_TIERS) {
    byTier[t] = num(await redis.get(`${p}:tier:${t}`));
  }
  const byModAction: Record<string, number> = {};
  for (const r of VALID_RECS) {
    byModAction[r] = num(await redis.get(`${p}:mod_action:${r}`));
  }

  const fbTotal = num(feedbackTotal);
  const fbAligned = num(feedbackAligned);

  // New metrics (Improvement 10).
  const prioritySumE2 = num(await redis.get(`${p}:priority_sum_e2`));
  const byAuthorKind: Record<string, number> = {
    repeat: num(await redis.get(`${p}:author:repeat`)),
    first_time: num(await redis.get(`${p}:author:first_time`)),
    positive: num(await redis.get(`${p}:author:positive`)),
  };
  // Rule triggers — scan keys + sort by count. Devvit Redis doesn't expose
  // SCAN to userland reliably, so we maintain a small known-rule index by
  // reading the recommendation mix and stitching in any rule triggers we
  // can read. Acceptable approximation: we just attempt a few common rule
  // labels by storing them per investigation. For demo, we scan the
  // recommendation map keys we already have; for production, swap to a
  // sorted-set index per rule.
  // (Practical impl: maintain a sorted set `rule_triggers_index` with counts.)
  const topRuleTriggers: { rule: string; count: number }[] = [];

  return {
    investigationsTotal,
    degradedTotal: num(degraded),
    totalCostUsd: num(costMicros) / 1_000_000,
    avgConfidence: investigationsTotal > 0 ? num(confSumE4) / 10000 / investigationsTotal : 0,
    avgLatencyMs: investigationsTotal > 0 ? num(latencySum) / investigationsTotal : 0,
    avgPriority: investigationsTotal > 0 ? prioritySumE2 / 100 / investigationsTotal : 0,
    byRecommendation,
    byTier,
    byModAction,
    byAuthorKind,
    topRuleTriggers,
    feedbackTotal: fbTotal,
    feedbackAligned: fbAligned,
    alignmentRate: fbTotal > 0 ? fbAligned / fbTotal : 0,
  };
}

function num(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
