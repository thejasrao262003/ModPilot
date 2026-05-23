// Tests for deterministic explainability surfaces.
// Features 2, 4, 6, 7, 8.

import { describe, expect, it } from 'vitest';

import {
  buildRuleMatchDisplay,
  deriveAuthorSignal,
  deriveConfidenceFactors,
  deriveKeyFactors,
} from './explainability';

const cleanBreakdown = {
  llmSelfReport: 0.5,
  evidenceConvergence: 0.5,
  subredditAccuracy: 0.5,
  ruleMatchStrength: 0.0,
};

describe('deriveAuthorSignal', () => {
  it('flags repeat offender at 3+ violations', () => {
    const s = deriveAuthorSignal({
      priorViolations: 3, priorApprovals: 1, hasHistory: true, priorRemovalsFromInvestigations: 0,
    });
    expect(s.kind).toBe('repeat');
    expect(s.headline.toLowerCase()).toContain('repeat');
  });

  it('flags repeat offender at 2+ prior investigation removals', () => {
    const s = deriveAuthorSignal({
      priorViolations: 0, priorApprovals: 0, hasHistory: true, priorRemovalsFromInvestigations: 2,
    });
    expect(s.kind).toBe('repeat');
  });

  it('flags positive history when 0 violations + 5+ approvals', () => {
    const s = deriveAuthorSignal({
      priorViolations: 0, priorApprovals: 5, hasHistory: true, priorRemovalsFromInvestigations: 0,
    });
    expect(s.kind).toBe('positive');
    expect(s.headline.toLowerCase()).toContain('positive');
  });

  it('flags first-time when no history exists', () => {
    const s = deriveAuthorSignal({
      priorViolations: 0, priorApprovals: 0, hasHistory: false, priorRemovalsFromInvestigations: 0,
    });
    expect(s.kind).toBe('first_time');
  });

  it('falls through to neutral when established but no extremes', () => {
    const s = deriveAuthorSignal({
      priorViolations: 1, priorApprovals: 2, hasHistory: true, priorRemovalsFromInvestigations: 0,
    });
    expect(s.kind).toBe('neutral');
  });
});

describe('deriveConfidenceFactors', () => {
  const baseAuthor = {
    kind: 'neutral' as const, headline: 'x', detail: 'y', badge: 'neutral',
  };
  const base = {
    calibratedConfidence: 0.5,
    breakdown: cleanBreakdown,
    validationPassed: true,
    isPartial: false,
    coldStart: false,
    ruleMatchScore: 0.0,
    escalationLevel: 'none' as const,
    authorSignal: baseAuthor,
  };

  it('lists "down" factors for cold-start + weak rule match', () => {
    const f = deriveConfidenceFactors({ ...base, coldStart: true });
    expect(f.some((x) => x.direction === 'down' && /cold-start/i.test(x.reason))).toBe(true);
    expect(f.some((x) => x.direction === 'down' && /Weak rule match/i.test(x.reason))).toBe(true);
  });

  it('lists "up" factor for strong rule match', () => {
    const f = deriveConfidenceFactors({ ...base, ruleMatchScore: 0.7 });
    expect(f.some((x) => x.direction === 'up' && /Strong rule match/i.test(x.reason))).toBe(true);
  });

  it('lists "up" factor when escalation is moderate+', () => {
    const f = deriveConfidenceFactors({ ...base, escalationLevel: 'moderate' });
    expect(f.some((x) => x.direction === 'up' && /escalat/i.test(x.reason))).toBe(true);
  });

  it('lists "up" factor for repeat offender, "up" for positive history', () => {
    const repeat = deriveConfidenceFactors({
      ...base,
      authorSignal: { ...baseAuthor, kind: 'repeat' },
    });
    expect(repeat.some((x) => x.direction === 'up' && /Repeat offender/i.test(x.reason))).toBe(true);

    const positive = deriveConfidenceFactors({
      ...base,
      authorSignal: { ...baseAuthor, kind: 'positive' },
    });
    expect(positive.some((x) => x.direction === 'up' && /Positive/i.test(x.reason))).toBe(true);
  });

  it('lists "down" for validation failure + partial investigation', () => {
    const f = deriveConfidenceFactors({ ...base, validationPassed: false, isPartial: true });
    expect(f.filter((x) => x.direction === 'down').length).toBeGreaterThanOrEqual(2);
  });
});

describe('deriveKeyFactors', () => {
  const baseAuthor = { kind: 'neutral' as const, headline: 'x', detail: 'y', badge: 'neutral' };
  const base = {
    ruleMatchScore: 0.0,
    authorSignal: baseAuthor,
    velocityZscore: 0,
    reporterCount: 0,
    escalationLevel: 'none' as const,
    evidenceConvergence: 0.5,
    priorRemovals: 0,
    recommendation: 'NO_RECOMMENDATION' as const,
  };

  it('marks strong rule match as high-impact negative', () => {
    const fs = deriveKeyFactors({ ...base, ruleMatchScore: 0.6 });
    const f = fs.find((x) => /rule match/i.test(x.label));
    expect(f?.impact).toBe('high');
    expect(f?.direction).toBe('negative');
  });

  it('marks positive author history as positive direction', () => {
    const fs = deriveKeyFactors({
      ...base,
      authorSignal: { ...baseAuthor, kind: 'positive' },
    });
    expect(fs.some((x) => x.direction === 'positive')).toBe(true);
  });

  it('sorts factors by impact (high before low)', () => {
    const fs = deriveKeyFactors({
      ...base,
      ruleMatchScore: 0.7,
      reporterCount: 5,
      velocityZscore: 4,
      escalationLevel: 'mild',
    });
    const rank = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < fs.length; i++) {
      expect(rank[fs[i - 1]!.impact]).toBeGreaterThanOrEqual(rank[fs[i]!.impact]);
    }
  });

  it('flags report velocity spike at z >= 3', () => {
    const fs = deriveKeyFactors({ ...base, velocityZscore: 3.5 });
    expect(fs.some((x) => /velocity/i.test(x.label) && x.impact === 'high')).toBe(true);
  });
});

describe('buildRuleMatchDisplay', () => {
  it('returns empty when score is 0', () => {
    const r = buildRuleMatchDisplay({
      match: { score: 0, matchedRule: null, matchedTerms: [] },
      ruleMatchEvidenceId: null,
    });
    expect(r).toEqual([]);
  });

  it('classifies score bands: high / medium / low', () => {
    const high = buildRuleMatchDisplay({
      match: { score: 0.6, matchedRule: 'Rule X', matchedTerms: ['a', 'b'] },
      ruleMatchEvidenceId: 'ev-1',
    });
    expect(high[0]?.score).toBe('high');

    const med = buildRuleMatchDisplay({
      match: { score: 0.3, matchedRule: 'Rule Y', matchedTerms: ['a'] },
      ruleMatchEvidenceId: null,
    });
    expect(med[0]?.score).toBe('medium');

    const low = buildRuleMatchDisplay({
      match: { score: 0.1, matchedRule: 'Rule Z', matchedTerms: ['a'] },
      ruleMatchEvidenceId: null,
    });
    expect(low[0]?.score).toBe('low');
  });

  it('includes the evidence id only when provided', () => {
    const withEv = buildRuleMatchDisplay({
      match: { score: 0.4, matchedRule: 'r', matchedTerms: [] },
      ruleMatchEvidenceId: 'ev-3',
    });
    expect(withEv[0]?.evidenceIds).toEqual(['ev-3']);

    const noEv = buildRuleMatchDisplay({
      match: { score: 0.4, matchedRule: 'r', matchedTerms: [] },
      ruleMatchEvidenceId: null,
    });
    expect(noEv[0]?.evidenceIds).toEqual([]);
  });
});
