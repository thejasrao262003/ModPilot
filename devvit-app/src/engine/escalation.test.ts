// Tests for deriveEscalation (FEATURE 5). Pure function over the accumulator.

import { describe, expect, it } from 'vitest';

import { EvidenceAccumulator } from './accumulator';
import { deriveEscalation } from './escalation';

function makeAcc(detail: Record<string, unknown> | null) {
  const acc = new EvidenceAccumulator();
  // Add a couple of unrelated successful tools first so ev-N numbering is realistic.
  acc.append({ tool: 'report_velocity', status: 'success', summary: '', latencyMs: 1, detail: {} });
  acc.append({ tool: 'user_history', status: 'success', summary: '', latencyMs: 1, detail: {} });
  if (detail) {
    acc.append({ tool: 'thread_context', status: 'success', summary: '', latencyMs: 1, detail });
  }
  return acc;
}

describe('deriveEscalation', () => {
  it('returns level: none when thread_context did not run', () => {
    const r = deriveEscalation(makeAcc(null));
    expect(r.level).toBe('none');
    expect(r.headline).toBeNull();
    expect(r.evidenceId).toBeNull();
  });

  it('returns level: none for a clean thread with no signals', () => {
    const r = deriveEscalation(
      makeAcc({ escalation_turn: null, off_topic: false, instigator_candidates: [], total_turns: 10 }),
    );
    expect(r.level).toBe('none');
    expect(r.evidenceId).toBe('ev-3'); // thread_context evidence id even when level is none
  });

  it('flags mild when only a single mild signal is present', () => {
    const r = deriveEscalation(
      makeAcc({ escalation_turn: null, off_topic: true, instigator_candidates: [], total_turns: 8 }),
    );
    expect(r.level).toBe('mild');
    expect(r.headline).toBeTruthy();
  });

  it('flags moderate when escalation_turn + an instigator', () => {
    const r = deriveEscalation(
      makeAcc({
        escalation_turn: 5,
        off_topic: false,
        instigator_candidates: ['someone'],
        total_turns: 10,
        arc: 'Turned heated at turn 5.',
      }),
    );
    expect(r.level).toBe('moderate');
  });

  it('flags high when escalation late in a long thread + multiple instigators + off-topic', () => {
    const r = deriveEscalation(
      makeAcc({
        escalation_turn: 8,
        off_topic: true,
        instigator_candidates: ['a', 'b'],
        total_turns: 10,
        arc: 'Late-stage escalation in long thread.',
      }),
    );
    expect(r.level).toBe('high');
    expect(r.headline).toContain('Escalating');
  });
});
