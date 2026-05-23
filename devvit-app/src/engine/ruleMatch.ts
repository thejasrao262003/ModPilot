// Lightweight rule-match precheck. We don't have embeddings in the TS port
// (policy_match needs them), but a substring score over content words is
// enough to feed `rule_match_strength` into the Strategy Selector + Calibrator.
//
// Score ∈ [0, 1] across all configured rules: the strongest single-rule match
// wins. A score ≥ 0.5 means at least half of a rule's content words appear in
// the target text — strong signal that the rule is implicated.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'no', 'not', 'of', 'on', 'or', 'the',
  'this', 'to', 'with', 'about', 'rule', 'rules',
]);

export type RuleMatchResult = {
  score: number; // 0..1, max across rules
  matchedRule: string | null;
  matchedTerms: string[];
};

export function computeRuleMatch(content: string, rules: string): RuleMatchResult {
  const lines = rules
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || !content.trim()) {
    return { score: 0, matchedRule: null, matchedTerms: [] };
  }

  const contentTokens = tokens(content);
  if (contentTokens.size === 0) {
    return { score: 0, matchedRule: null, matchedTerms: [] };
  }

  let best: RuleMatchResult = { score: 0, matchedRule: null, matchedTerms: [] };
  for (const rule of lines) {
    const ruleTokens = [...tokens(rule)];
    if (ruleTokens.length === 0) continue;
    const matched = ruleTokens.filter((t) => contentTokens.has(t));
    if (matched.length === 0) continue;
    const score = matched.length / ruleTokens.length;
    if (score > best.score) {
      best = { score, matchedRule: rule, matchedTerms: matched };
    }
  }
  return best;
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}
