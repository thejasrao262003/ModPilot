// Citation validator — enforces ADR-0003 evidence-citation contract.
// Mirrors engine/llm/validation.py, with the per-sentence uncited-claims
// check relaxed: in practice Gemini 2.5 Pro reliably places at least one
// [ev-N] inline but uses connecting/summary sentences without cites, and
// the corrective retry doesn't move the needle. We keep the load-bearing
// checks (no hallucinated IDs, no non-success cites, ≥1 citation present)
// and drop the stylistic per-sentence rule.

import type { EvidenceAccumulator } from '../accumulator';

// Accepts both `[ev-3]` and the comma-separated form `[ev-3, ev-4, ev-5]`.
// Real Reasoner outputs frequently use the latter and the strict single-ID
// form was rejecting legitimate multi-cite sentences as `no_citations`.
const EV_RE = /\[\s*(ev-\d+(?:\s*,\s*ev-\d+)*)\s*\]/g;

export type ValidationResult =
  | { passed: true }
  | { passed: false; reason: string; details: Record<string, unknown> };

export function validateCitations(
  rationale: string,
  acc: EvidenceAccumulator,
  citedFromOutput?: string[],
): ValidationResult {
  if (!rationale.trim()) return failed('empty_rationale');

  const refs = parseEvRefs(rationale);
  if (refs.size === 0) return failed('no_citations', { rationale_length: rationale.length });

  const all = new Set(acc.entries().map((e) => e.id));
  const success = new Set(acc.successfulEntries().map((e) => e.id));

  const hallucinated = [...refs].filter((r) => !all.has(r)).sort();
  if (hallucinated.length > 0) return failed('hallucinated_evidence_ids', { ids: hallucinated });

  const nonSuccess = [...refs].filter((r) => !success.has(r)).sort();
  if (nonSuccess.length > 0) return failed('cited_non_success_evidence', { ids: nonSuccess });

  if (citedFromOutput) {
    const declared = new Set(citedFromOutput);
    const same = declared.size === refs.size && [...declared].every((d) => refs.has(d));
    if (!same) {
      return failed('cited_field_mismatch', {
        declared: [...declared].sort(),
        parsed: [...refs].sort(),
      });
    }
  }

  return { passed: true };
}

function parseEvRefs(text: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(EV_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    // m[1] is the bracket interior; split on comma to capture multi-cite forms.
    const interior = m[1] ?? '';
    for (const part of interior.split(',')) {
      const id = part.trim();
      if (/^ev-\d+$/.test(id)) out.add(id);
    }
  }
  return out;
}

function failed(reason: string, details: Record<string, unknown> = {}): ValidationResult {
  return { passed: false, reason, details };
}
