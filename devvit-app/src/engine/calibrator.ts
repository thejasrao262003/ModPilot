// Confidence Calibrator — pure function. Mirrors engine/orchestrator/calibrator.py.

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';

const W_LLM = 0.25;
const W_EVIDENCE = 0.30;
const W_ACCURACY = 0.20;
const W_RULE_MATCH = 0.25;

const LLM_DISCOUNT_FACTOR = 0.4;

const DEMOTION_VALIDATION_FAILED = 0.6;
const DEMOTION_PARTIAL = 0.8;
const DEMOTION_COLD_START = 0.85;

const TIER_HIGH = 0.85;
const TIER_MEDIUM = 0.60;

export type CalibrationInputs = {
  llmSelfReport: number;
  evidenceConvergence: number;
  subredditAccuracy: number;
  ruleMatchStrength: number;
  validationPassed: boolean;
  coldStart: boolean;
  isPartial: boolean;
  // Recommendation context: rule_match means different things for REMOVE
  // (supports removal) vs APPROVE (the rule's keywords matched but the
  // content doesn't actually violate it — so a *weak* match means the rule
  // clearly doesn't apply, which strengthens the APPROVE call). Cold-start
  // demotion also makes less sense for APPROVE — approving correctly has
  // no destructive cost. Provide this so the calibrator can adapt.
  recommendation?:
    | 'REMOVE'
    | 'APPROVE'
    | 'ESCALATE'
    | 'LOCK'
    | 'NO_RECOMMENDATION';
};

export type CalibrationResult = {
  calibratedConfidence: number;
  tier: ConfidenceTier;
  llmSelfReport: number;
  evidenceConvergence: number;
  subredditAccuracy: number;
  ruleMatchStrength: number;
};

export function calibrate(inp: CalibrationInputs): CalibrationResult {
  const llmSignal = 0.5 + (inp.llmSelfReport - 0.5) * LLM_DISCOUNT_FACTOR;

  // Effective rule-match contribution.
  // For removal-leaning recommendations (REMOVE / LOCK), high rule_match
  // *supports* the recommendation → use raw value.
  // For APPROVE / NO_RECOMMENDATION / ESCALATE, the rule's keywords matched
  // but the Reasoner judged no violation. A *weak* match strongly supports
  // the approve call ("rule doesn't apply at all"). Invert.
  const isRemoveCall =
    inp.recommendation === 'REMOVE' || inp.recommendation === 'LOCK';
  const effectiveRuleMatch = isRemoveCall
    ? inp.ruleMatchStrength
    : 1 - inp.ruleMatchStrength;

  let base =
    W_LLM * llmSignal +
    W_EVIDENCE * inp.evidenceConvergence +
    W_ACCURACY * inp.subredditAccuracy +
    W_RULE_MATCH * effectiveRuleMatch;

  if (!inp.validationPassed) base *= DEMOTION_VALIDATION_FAILED;
  if (inp.isPartial) base *= DEMOTION_PARTIAL;
  // Skip cold-start demotion for APPROVE — approving correctly has no
  // destructive cost, so being conservative about confidence on approvals
  // is actively harmful (low conf → mod might second-guess a clearly
  // benign post). Honest-uncertainty rule still kicks in via the LOW tier
  // boundary; we just don't deflate the number 15% on top of that.
  if (inp.coldStart && inp.recommendation !== 'APPROVE') {
    base *= DEMOTION_COLD_START;
  }

  base = Math.max(0.0, Math.min(1.0, base));
  return {
    calibratedConfidence: round4(base),
    tier: tierFor(base),
    llmSelfReport: inp.llmSelfReport,
    evidenceConvergence: inp.evidenceConvergence,
    subredditAccuracy: inp.subredditAccuracy,
    ruleMatchStrength: inp.ruleMatchStrength,
  };
}

function tierFor(c: number): ConfidenceTier {
  if (c >= TIER_HIGH) return 'HIGH';
  if (c >= TIER_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeEvidenceConvergence(signals: number[]): number {
  if (signals.length === 0) return 0.0;
  return signals.reduce((a, b) => a + b, 0) / signals.length;
}
