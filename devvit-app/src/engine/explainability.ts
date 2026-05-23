// Deterministic explainability — derives moderator-facing panels from
// existing engine signals. No LLM, no hallucinated reasons.
//
// Covers:
//   FEATURE 2 — Repeat offender / positive history surfacing
//   FEATURE 4 — Confidence explanation panel
//   FEATURE 6 — Rule match explainability (display structure)
//   FEATURE 7 — First-time offender signal
//   FEATURE 8 — Key factors panel

import type { ConfidenceBreakdown, Recommendation } from './types';
import type { RuleMatchResult } from './ruleMatch';

// ── FEATURE 2 + 7: Author signal ─────────────────────────────────────────────

export type AuthorSignal = {
  kind: 'repeat' | 'first_time' | 'positive' | 'neutral';
  headline: string;
  detail: string;
  badge: string;
};

export function deriveAuthorSignal(args: {
  priorViolations: number;
  priorApprovals: number;
  hasHistory: boolean;
  priorRemovalsFromInvestigations: number; // from prior_actions tool
}): AuthorSignal {
  // Repeat-offender path. Detail line must match which signal triggered it,
  // otherwise we get confusing "Repeat Offender · 0 prior removals" output
  // (the badge fired from prior_actions but the detail read from user_memory).
  if (args.priorViolations >= 3) {
    return {
      kind: 'repeat',
      headline: '⚠️ Repeat Offender',
      detail: `${args.priorViolations} mod removal${args.priorViolations === 1 ? '' : 's'} · ${args.priorApprovals} approval${args.priorApprovals === 1 ? '' : 's'}`,
      badge: 'repeat-offender',
    };
  }
  if (args.priorRemovalsFromInvestigations >= 2) {
    return {
      kind: 'repeat',
      headline: '⚠️ Pattern of Recommended Removals',
      detail: `ModPilot has previously recommended REMOVE on ${args.priorRemovalsFromInvestigations} posts by this author`,
      badge: 'repeat-offender',
    };
  }
  if (args.priorViolations === 0 && args.priorApprovals >= 5) {
    return {
      kind: 'positive',
      headline: '✓ Positive History',
      detail: `0 prior mod removals · ${args.priorApprovals} prior approvals`,
      badge: 'positive-history',
    };
  }
  if (!args.hasHistory && args.priorRemovalsFromInvestigations === 0) {
    return {
      kind: 'first_time',
      headline: '✓ First-Time Author',
      detail: 'No prior moderation history in this subreddit',
      badge: 'first-time',
    };
  }
  return {
    kind: 'neutral',
    headline: 'Established Author',
    detail: `${args.priorViolations} prior mod removal${args.priorViolations === 1 ? '' : 's'} · ${args.priorApprovals} approval${args.priorApprovals === 1 ? '' : 's'}`,
    badge: 'neutral',
  };
}

// ── FEATURE 4: Confidence Explanation Panel ──────────────────────────────────

export type ConfidenceFactor = {
  direction: 'up' | 'down';
  reason: string;
};

export function deriveConfidenceFactors(args: {
  calibratedConfidence: number;
  breakdown: ConfidenceBreakdown;
  validationPassed: boolean;
  isPartial: boolean;
  coldStart: boolean;
  ruleMatchScore: number;
  escalationLevel: 'none' | 'mild' | 'moderate' | 'high';
  authorSignal: AuthorSignal;
  recommendation?: Recommendation;
}): ConfidenceFactor[] {
  const factors: ConfidenceFactor[] = [];
  const isRemoveCall =
    args.recommendation === 'REMOVE' || args.recommendation === 'LOCK';
  const isApprove = args.recommendation === 'APPROVE';

  // Downward — demotions applied by the Calibrator (mirrored 1:1 with calibrator.ts).
  if (!args.validationPassed) {
    factors.push({ direction: 'down', reason: 'Citation validation failed — Reasoner output didn\'t meet the contract' });
  }
  if (args.isPartial) {
    factors.push({ direction: 'down', reason: 'Partial investigation (budget exhausted before plan completed)' });
  }
  if (args.coldStart && !isApprove) {
    factors.push({ direction: 'down', reason: 'New subreddit — limited moderation history (cold-start)' });
  }
  if (args.breakdown.subredditAccuracy <= 0.5) {
    factors.push({ direction: 'down', reason: 'No feedback history yet to ground subreddit accuracy' });
  }

  // Rule-match: direction depends on the recommendation.
  if (isRemoveCall) {
    if (args.ruleMatchScore < 0.25) {
      factors.push({ direction: 'down', reason: 'Weak rule match — content didn\'t clearly map to a configured rule' });
    } else if (args.ruleMatchScore >= 0.5) {
      factors.push({ direction: 'up', reason: 'Strong rule match' });
    } else {
      factors.push({ direction: 'up', reason: 'Partial rule match supports the removal' });
    }
  } else {
    // For APPROVE / NO_RECOMMENDATION / ESCALATE, the rule's keywords may
    // have matched but the Reasoner judged no violation. Low rule_match
    // strengthens the call (the rule clearly doesn't apply).
    if (args.ruleMatchScore < 0.25) {
      factors.push({ direction: 'up', reason: 'No rule clearly applies — supports approval' });
    } else if (args.ruleMatchScore >= 0.5) {
      factors.push({ direction: 'down', reason: 'Content matched a rule\'s keywords — the Reasoner chose not to remove, but mod judgment matters here' });
    } else {
      factors.push({ direction: 'up', reason: 'Only partial keyword overlap with rules — supports approval' });
    }
  }

  if (args.authorSignal.kind === 'repeat') {
    factors.push({ direction: isApprove ? 'down' : 'up', reason: 'Repeat offender history' });
  }
  if (args.authorSignal.kind === 'positive') {
    factors.push({ direction: 'up', reason: 'Positive participation history' });
  }
  if (args.escalationLevel === 'moderate' || args.escalationLevel === 'high') {
    factors.push({ direction: isApprove ? 'down' : 'up', reason: 'Escalating thread context' });
  }
  if (args.breakdown.evidenceConvergence >= 0.6) {
    factors.push({ direction: 'up', reason: 'Multiple tools agree (evidence convergence)' });
  }

  return factors;
}

// ── FEATURE 6: Rule Match Explainability ─────────────────────────────────────

export type RuleMatchDisplay = {
  rule: string;
  score: 'high' | 'medium' | 'low';
  evidenceIds: string[]; // only success-status ids; passes ADR-0003 visibility filter
};

export function buildRuleMatchDisplay(args: {
  match: RuleMatchResult;
  ruleMatchEvidenceId: string | null;  // ev-N for the policy_match row, if appended
}): RuleMatchDisplay[] {
  if (!args.match.matchedRule || args.match.score === 0) return [];
  const score: RuleMatchDisplay['score'] =
    args.match.score >= 0.5 ? 'high' : args.match.score >= 0.25 ? 'medium' : 'low';
  return [
    {
      rule: args.match.matchedRule,
      score,
      evidenceIds: args.ruleMatchEvidenceId ? [args.ruleMatchEvidenceId] : [],
    },
  ];
}

// ── FEATURE 8: Key Factors Panel ─────────────────────────────────────────────

export type KeyFactor = {
  label: string;
  impact: 'high' | 'medium' | 'low';
  direction: 'positive' | 'negative' | 'neutral';
};

export function deriveKeyFactors(args: {
  ruleMatchScore: number;
  authorSignal: AuthorSignal;
  velocityZscore: number;
  reporterCount: number;
  escalationLevel: 'none' | 'mild' | 'moderate' | 'high';
  evidenceConvergence: number;
  priorRemovals: number;
  recommendation: Recommendation;
}): KeyFactor[] {
  const factors: KeyFactor[] = [];

  if (args.ruleMatchScore >= 0.5) {
    factors.push({ label: 'Strong rule match', impact: 'high', direction: 'negative' });
  } else if (args.ruleMatchScore >= 0.25) {
    factors.push({ label: 'Partial rule match', impact: 'medium', direction: 'negative' });
  }

  if (args.authorSignal.kind === 'repeat') {
    factors.push({ label: 'Repeat offender history', impact: 'high', direction: 'negative' });
  } else if (args.authorSignal.kind === 'positive') {
    factors.push({ label: 'Positive participation history', impact: 'medium', direction: 'positive' });
  } else if (args.authorSignal.kind === 'first_time') {
    factors.push({ label: 'First-time author', impact: 'low', direction: 'neutral' });
  }

  // Report velocity / reporter count: these are community-attention signals,
  // not violation evidence. They raise priority (urgency) without
  // implying the content is bad. Mark them as 'neutral' direction so the
  // panel doesn't read "many reports → support removal" — that would be
  // exactly the anchoring bias we're correcting.
  if (args.velocityZscore >= 3.0 || args.reporterCount >= 4) {
    factors.push({ label: 'High community attention (many reports)', impact: 'high', direction: 'neutral' });
  } else if (args.velocityZscore >= 1.5 || args.reporterCount >= 2) {
    factors.push({ label: 'Elevated community attention', impact: 'medium', direction: 'neutral' });
  }

  if (args.escalationLevel === 'high') {
    factors.push({ label: 'High thread escalation', impact: 'high', direction: 'negative' });
  } else if (args.escalationLevel === 'moderate') {
    factors.push({ label: 'Moderate thread escalation', impact: 'medium', direction: 'negative' });
  } else if (args.escalationLevel === 'mild') {
    factors.push({ label: 'Mild escalation signals', impact: 'low', direction: 'negative' });
  } else if (args.escalationLevel === 'none') {
    factors.push({ label: 'No thread escalation detected', impact: 'low', direction: 'positive' });
  }

  if (args.evidenceConvergence >= 0.6) {
    factors.push({ label: 'Evidence convergence across tools', impact: 'medium', direction: 'negative' });
  } else if (args.evidenceConvergence < 0.3) {
    factors.push({ label: 'Sparse evidence', impact: 'low', direction: 'positive' });
  }

  // Sort by impact (high > medium > low), preserving direction tie-break (negative first for action-leaning).
  const impactRank: Record<KeyFactor['impact'], number> = { high: 3, medium: 2, low: 1 };
  factors.sort((a, b) => impactRank[b.impact] - impactRank[a.impact]);

  return factors;
}
