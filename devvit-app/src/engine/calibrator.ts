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
  let base =
    W_LLM * llmSignal +
    W_EVIDENCE * inp.evidenceConvergence +
    W_ACCURACY * inp.subredditAccuracy +
    W_RULE_MATCH * inp.ruleMatchStrength;

  if (!inp.validationPassed) base *= DEMOTION_VALIDATION_FAILED;
  if (inp.isPartial) base *= DEMOTION_PARTIAL;
  if (inp.coldStart) base *= DEMOTION_COLD_START;

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
