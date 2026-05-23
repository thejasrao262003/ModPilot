// Investigation persistence — hash at `inv:{correlation_id}` plus an
// author-scoped sorted-set index for prior_actions lookups.
//
// Stores the full Verdict JSON in one field for single-read fetch; evidence
// list also JSON-encoded. Mirrors engine/store/postgres.py:start_investigation
// + finalize_investigation + list_prior_actions_on_user, collapsed to KV.

import { redis } from '@devvit/web/server';

import type { Recommendation, RiskTier, StrategyTier, Verdict } from '../types';
import { authorInvIndexKey, investigationKey } from './keys';

export type PriorAction = {
  correlationId: string;
  recommendation: Recommendation;
  riskTier: RiskTier;
  confidence: number;
  targetKind: 'comment' | 'post';
  targetId: string;
  completedAt: string;
};

export async function persistInvestigation(args: {
  subId: string;
  authorId: string;
  targetId: string;
  targetKind: 'comment' | 'post';
  targetBody: string;
  verdict: Verdict;
}): Promise<void> {
  const key = investigationKey(args.verdict.correlationId);
  const completedAt = new Date().toISOString();
  await redis.hSet(key, {
    correlation_id: args.verdict.correlationId,
    subreddit_id: args.subId,
    target_kind: args.targetKind,
    target_id: args.targetId,
    target_body: args.targetBody.slice(0, 2000), // cap for storage
    target_author_id: args.authorId,
    tier: args.verdict.tier,
    risk_tier: args.verdict.riskTier,
    recommendation: args.verdict.recommendation,
    calibrated_confidence: String(args.verdict.calibratedConfidence),
    rationale: args.verdict.rationale,
    model_reasoner: args.verdict.modelReasoner,
    cost_usd: String(args.verdict.costUsd),
    latency_ms: String(args.verdict.latencyMs),
    validation_flag: String(args.verdict.validationFlag),
    degraded: String(args.verdict.degraded),
    cold_start: String(args.verdict.coldStart),
    completed_at: completedAt,
    verdict_json: JSON.stringify(args.verdict),
  });
  if (args.authorId) {
    await redis.zAdd(authorInvIndexKey(args.subId, args.authorId), {
      score: Date.now(),
      member: args.verdict.correlationId,
    });
  }
}

export async function listPriorActionsOnUser(
  subId: string,
  authorId: string,
  limit = 3,
): Promise<PriorAction[]> {
  if (!authorId) return [];
  const key = authorInvIndexKey(subId, authorId);
  // Newest first.
  const members = await redis.zRange(key, 0, limit - 1, { by: 'rank', reverse: true });
  const actions: PriorAction[] = [];
  for (const m of members) {
    const inv = await redis.hGetAll(investigationKey(m.member));
    if (!inv || !inv.correlation_id) continue;
    actions.push({
      correlationId: inv.correlation_id,
      recommendation: (inv.recommendation as Recommendation) || 'NO_RECOMMENDATION',
      riskTier: (inv.risk_tier as RiskTier) || 'LOW',
      confidence: Number.parseFloat(inv.calibrated_confidence ?? '0') || 0,
      targetKind: (inv.target_kind as 'comment' | 'post') || 'comment',
      targetId: inv.target_id || '',
      completedAt: inv.completed_at || '',
    });
  }
  return actions;
}

export function _strategyTier(s: string): StrategyTier {
  if (s === 'FAST' || s === 'STANDARD' || s === 'DEEP') return s;
  return 'STANDARD';
}
