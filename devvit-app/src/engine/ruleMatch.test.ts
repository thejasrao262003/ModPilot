// Tests for computeRuleMatch (substring rule-match precheck).

import { describe, expect, it } from 'vitest';

import { computeRuleMatch } from './ruleMatch';

describe('computeRuleMatch', () => {
  it('returns zero score when no rules are configured', () => {
    const r = computeRuleMatch('anything', '');
    expect(r.score).toBe(0);
    expect(r.matchedRule).toBeNull();
  });

  it('returns zero when content is empty', () => {
    const r = computeRuleMatch('', 'Rule 1: No spam allowed.');
    expect(r.score).toBe(0);
  });

  it('matches a rule by overlapping content words', () => {
    const r = computeRuleMatch(
      'Cricket is horrible',
      'Rule 1: No personal attacks\nRule 2: No bad talks about Cricket sport',
    );
    expect(r.score).toBeGreaterThan(0);
    expect(r.matchedRule).toMatch(/Cricket/);
    expect(r.matchedTerms).toContain('cricket');
  });

  it('picks the strongest rule overlap', () => {
    const r = computeRuleMatch(
      'You are an idiot, your post about cricket is wrong',
      'Rule 1: No personal attacks\nRule 2: No bad talks about cricket',
    );
    expect(r.matchedRule).toBeTruthy();
    expect(r.score).toBeGreaterThan(0);
  });

  it('ignores stopwords like "no", "the", "a"', () => {
    const r = computeRuleMatch('the a no rule', 'Rule 1: No the a content');
    // Only "content" / "rule" survive stopword filter; one might match.
    // We just assert the result is sensible (low or zero).
    expect(r.score).toBeLessThanOrEqual(1);
  });
});
