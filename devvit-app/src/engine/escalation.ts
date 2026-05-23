// Escalation detection (FEATURE 5).
//
// Leverages the existing thread_context tool output. No extra LLM calls —
// derives a categorical level from already-computed Summarizer fields plus
// the per-investigation tool result. Display-only signal; cannot drive a
// removal decision on its own (per F5 requirement).

import type { EvidenceAccumulator } from './accumulator';

export type EscalationLevel = 'none' | 'mild' | 'moderate' | 'high';

export type EscalationResult = {
  level: EscalationLevel;
  headline: string | null;
  summary: string | null;
  evidenceId: string | null;
};

export function deriveEscalation(acc: EvidenceAccumulator): EscalationResult {
  const threadEntry = acc.successfulEntries().find((e) => e.tool === 'thread_context');
  if (!threadEntry) {
    return { level: 'none', headline: null, summary: null, evidenceId: null };
  }
  const d = threadEntry.detail;
  const escalationTurn = typeof d.escalation_turn === 'number' ? d.escalation_turn : null;
  const offTopic = d.off_topic === true;
  const instigatorCount = Array.isArray(d.instigator_candidates) ? d.instigator_candidates.length : 0;
  const totalTurns = typeof d.total_turns === 'number' ? d.total_turns : 0;

  if (escalationTurn === null && !offTopic && instigatorCount === 0) {
    return {
      level: 'none',
      headline: null,
      summary: null,
      evidenceId: threadEntry.id,
    };
  }

  // Categorize: instigators + escalation turn close to end + off-topic stacks.
  let score = 0;
  if (escalationTurn !== null) score += 2;
  if (instigatorCount >= 2) score += 2;
  else if (instigatorCount >= 1) score += 1;
  if (offTopic) score += 1;
  // Late-turn escalation in a long thread is stronger than early-turn in a short one.
  if (escalationTurn !== null && totalTurns > 0 && escalationTurn / totalTurns > 0.6) score += 1;

  const level: EscalationLevel = score >= 5 ? 'high' : score >= 3 ? 'moderate' : 'mild';

  return {
    level,
    headline: level === 'mild' ? 'Mild Escalation Signals' : '🔥 Escalating Conversation',
    summary: typeof d.arc === 'string' ? d.arc.slice(0, 180) : null,
    evidenceId: threadEntry.id,
  };
}
