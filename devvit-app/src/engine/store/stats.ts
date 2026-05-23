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
  // Total investigations.
  await redis.incrBy(`${p}:investigations_total`, 1);
  // Per-recommendation counter.
  await redis.incrBy(`${p}:rec:${v.recommendation}`, 1);
  // Per-tier counter.
  await redis.incrBy(`${p}:tier:${v.tier}`, 1);
  // Degraded count (Reasoner failed twice).
  if (v.degraded) await redis.incrBy(`${p}:degraded`, 1);
  // Cumulative cost in micro-dollars (so we can use integer incrBy).
  await redis.incrBy(`${p}:cost_micros`, Math.round(v.costUsd * 1_000_000));
  // Confidence sum × 10000 — divide later to get the average.
  await redis.incrBy(`${p}:confidence_sum_e4`, Math.round(v.calibratedConfidence * 10000));
  // Latency sum (ms).
  await redis.incrBy(`${p}:latency_sum_ms`, v.latencyMs);
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
  byRecommendation: Record<string, number>;
  byTier: Record<string, number>;
  byModAction: Record<string, number>;
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

  return {
    investigationsTotal,
    degradedTotal: num(degraded),
    totalCostUsd: num(costMicros) / 1_000_000,
    avgConfidence: investigationsTotal > 0 ? num(confSumE4) / 10000 / investigationsTotal : 0,
    avgLatencyMs: investigationsTotal > 0 ? num(latencySum) / investigationsTotal : 0,
    byRecommendation,
    byTier,
    byModAction,
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
