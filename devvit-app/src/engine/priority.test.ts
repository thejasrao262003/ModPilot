// Tests for computePriority (FEATURE 1). Pure function, no I/O.

import { describe, expect, it } from 'vitest';

import { computePriority, priorityHeadline } from './priority';

const base = {
  calibratedConfidence: 0.5,
  reporterCount: 0,
  velocityZscore: 0,
  userRiskTier: 'new' as const,
  priorRemovals: 0,
  escalationLevel: 'none' as const,
  ruleMatchScore: 0,
  recommendation: 'NO_RECOMMENDATION' as const,
};

describe('computePriority', () => {
  it('returns low_risk for an empty/cold signal set', () => {
    const r = computePriority(base);
    expect(r.bucket).toBe('low_risk');
    expect(r.score).toBeLessThan(40);
  });

  it('NO_RECOMMENDATION never contributes confidence to priority', () => {
    const r = computePriority({ ...base, calibratedConfidence: 0.95, recommendation: 'NO_RECOMMENDATION' });
    const drivers = r.drivers.map((d) => d.label);
    expect(drivers).not.toContain('recommendation × confidence');
  });

  it('APPROVE recommendation never contributes confidence', () => {
    const r = computePriority({ ...base, calibratedConfidence: 0.95, recommendation: 'APPROVE' });
    expect(r.drivers.map((d) => d.label)).not.toContain('recommendation × confidence');
  });

  it('REMOVE × high confidence dominates the score', () => {
    const r = computePriority({ ...base, calibratedConfidence: 0.9, recommendation: 'REMOVE' });
    expect(r.drivers[0]?.label).toBe('recommendation × confidence');
    expect(r.score).toBeGreaterThanOrEqual(20);
  });

  it('watched user + escalation + reports stacks into urgent', () => {
    const r = computePriority({
      ...base,
      calibratedConfidence: 0.9,
      recommendation: 'REMOVE',
      reporterCount: 5,
      velocityZscore: 4,
      userRiskTier: 'watched',
      escalationLevel: 'high',
      ruleMatchScore: 0.7,
    });
    expect(r.bucket).toBe('urgent');
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('score is clamped to 0..100', () => {
    const r = computePriority({
      ...base,
      calibratedConfidence: 1.0,
      recommendation: 'REMOVE',
      reporterCount: 20,
      velocityZscore: 10,
      userRiskTier: 'watched',
      escalationLevel: 'high',
      ruleMatchScore: 1.0,
      priorRemovals: 10,
    });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('drivers are sorted descending by weight', () => {
    const r = computePriority({
      ...base,
      calibratedConfidence: 0.9,
      recommendation: 'REMOVE',
      reporterCount: 2,
      escalationLevel: 'moderate',
    });
    for (let i = 1; i < r.drivers.length; i++) {
      expect(r.drivers[i - 1]!.weight).toBeGreaterThanOrEqual(r.drivers[i]!.weight);
    }
  });

  it('headline maps each bucket to a distinct label', () => {
    expect(priorityHeadline('urgent')).toContain('Urgent');
    expect(priorityHeadline('review_soon')).toContain('Review');
    expect(priorityHeadline('low_risk')).toContain('Low Risk');
  });
});
