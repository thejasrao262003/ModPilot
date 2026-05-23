// Priority Score — deterministic 0..100 derived from existing signals.
// Surfaces urgency separately from recommendation/confidence.
//
// FEATURE 1. Does not affect the recommendation or the calibrated confidence —
// invariants 1–7 stay intact. Just an additional descriptive signal.

import type { Verdict } from './types';

export type PriorityBucket = 'urgent' | 'review_soon' | 'low_risk';

export type PriorityResult = {
  score: number;        // 0..100
  bucket: PriorityBucket;
  drivers: { label: string; weight: number }[]; // top contributors, descending
};

type Inputs = {
  calibratedConfidence: number;     // 0..1
  reporterCount: number;            // raw count
  velocityZscore: number;           // signed
  userRiskTier: 'new' | 'trusted' | 'neutral' | 'watched';
  priorRemovals: number;            // from prior_actions or user_memory
  escalationLevel: 'none' | 'mild' | 'moderate' | 'high';
  ruleMatchScore: number;           // 0..1
  recommendation: Verdict['recommendation'];
};

// Bucket thresholds.
const URGENT_AT = 70;
const REVIEW_AT = 40;

export function computePriority(inp: Inputs): PriorityResult {
  // Weights tuned for the demo. Sum of max contributions ≈ 100.
  const drivers: { label: string; weight: number }[] = [];

  // 1) Confidence × recommend-action signal. Approval / no_rec doesn't add
  //    urgency; remove/lock/escalate scales with confidence.
  const recBoost =
    inp.recommendation === 'REMOVE' || inp.recommendation === 'LOCK'
      ? 1.0
      : inp.recommendation === 'ESCALATE'
        ? 0.7
        : 0.0;
  const confidenceContribution = Math.round(inp.calibratedConfidence * 30 * recBoost);
  if (confidenceContribution > 0) {
    drivers.push({ label: 'recommendation × confidence', weight: confidenceContribution });
  }

  // 2) Velocity / reporter pressure.
  const velocityContribution = Math.min(20, Math.max(0, Math.round(inp.velocityZscore * 5)));
  const reporterContribution = Math.min(15, Math.max(0, inp.reporterCount * 3));
  const pressure = velocityContribution + reporterContribution;
  // Reports raise *urgency* (priority/triage), not violation probability.
  // Labeled accordingly so the driver list never reads as "more reports
  // = more guilty".
  if (pressure > 0) drivers.push({ label: 'community attention (reports)', weight: pressure });

  // 3) User risk.
  let userContribution = 0;
  if (inp.userRiskTier === 'watched') userContribution = 18;
  else if (inp.priorRemovals >= 3) userContribution = 14;
  else if (inp.priorRemovals >= 1) userContribution = 8;
  if (userContribution > 0) drivers.push({ label: 'author risk history', weight: userContribution });

  // 4) Escalation.
  const escalationMap: Record<Inputs['escalationLevel'], number> = {
    none: 0, mild: 5, moderate: 12, high: 20,
  };
  const escalationContribution = escalationMap[inp.escalationLevel];
  if (escalationContribution > 0) {
    drivers.push({ label: 'thread escalation', weight: escalationContribution });
  }

  // 5) Rule match strength.
  const ruleMatchContribution = Math.round(inp.ruleMatchScore * 15);
  if (ruleMatchContribution > 0) {
    drivers.push({ label: 'rule match strength', weight: ruleMatchContribution });
  }

  const rawScore =
    confidenceContribution + pressure + userContribution + escalationContribution + ruleMatchContribution;
  const score = Math.max(0, Math.min(100, rawScore));

  drivers.sort((a, b) => b.weight - a.weight);

  return {
    score,
    bucket: score >= URGENT_AT ? 'urgent' : score >= REVIEW_AT ? 'review_soon' : 'low_risk',
    drivers,
  };
}

export function priorityHeadline(bucket: PriorityBucket): string {
  switch (bucket) {
    case 'urgent': return '🔥 Urgent';
    case 'review_soon': return '⚠️ Review Soon';
    case 'low_risk': return 'ℹ️ Low Risk';
  }
}
