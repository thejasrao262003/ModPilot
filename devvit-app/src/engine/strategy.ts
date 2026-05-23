// Strategy Selector — pure function, picks investigation tier from cheap signals.
// Mirrors engine/orchestrator/strategy.py.

import type {
  Personality,
  StrategyTier,
  TierOverride,
  UserRiskTier,
} from './types';

export type StrategyInputs = {
  reporterCount: number;
  velocityZscore: number;
  userRiskTier: UserRiskTier;
  ruleMatchScore: number;
  personality: Personality;
  tierOverride: TierOverride;
  coldStart: boolean;
  threadEscalated: boolean;
};

export type StrategyDecision = {
  tier: StrategyTier;
  toolBudget: number;
  timeBudgetMs: number;
  costBudgetUsd: number;
  reasonerRequired: boolean;
  rationale: string;
};

type Budget = Pick<
  StrategyDecision,
  'toolBudget' | 'timeBudgetMs' | 'costBudgetUsd' | 'reasonerRequired'
>;

const BUDGETS: Record<StrategyTier, Budget> = {
  FAST: { toolBudget: 2, timeBudgetMs: 800, costBudgetUsd: 0.003, reasonerRequired: false },
  STANDARD: { toolBudget: 4, timeBudgetMs: 3000, costBudgetUsd: 0.012, reasonerRequired: true },
  DEEP: { toolBudget: 6, timeBudgetMs: 6000, costBudgetUsd: 0.030, reasonerRequired: true },
};

const DEEP_REPORTER_COUNT_DEFAULT = 4;
const DEEP_VELOCITY_Z_DEFAULT = 3.0;
const FAST_RULE_MATCH = 0.9;
const FAST_VELOCITY_Z = 0.5;

export function selectStrategy(inputs: StrategyInputs): StrategyDecision {
  if (inputs.tierOverride !== 'auto') {
    const forced = overrideTier(inputs.tierOverride);
    if (inputs.coldStart && forced === 'FAST') {
      return decision('STANDARD', 'cold-start floors FAST override -> standard');
    }
    return decision(forced, `override -> ${forced.toLowerCase()}`);
  }

  const deep = deepSignals(inputs);
  if (deep.length > 0) {
    return decision('DEEP', deep.join('; '));
  }

  if (fastEligible(inputs)) {
    return decision('FAST', 'single report + strong rule match + trusted/new user + no escalation');
  }

  return decision('STANDARD', 'no escalation signals, no fast-shortcut conditions met');
}

function overrideTier(o: TierOverride): StrategyTier {
  if (o === 'fast') return 'FAST';
  if (o === 'standard') return 'STANDARD';
  if (o === 'deep') return 'DEEP';
  throw new Error(`unsupported override ${o}`);
}

function deepSignals(inp: StrategyInputs): string[] {
  let thReporters = DEEP_REPORTER_COUNT_DEFAULT;
  let thVelocity = DEEP_VELOCITY_Z_DEFAULT;
  if (inp.personality === 'strict') {
    thReporters -= 1;
    thVelocity -= 1.0;
  } else if (inp.personality === 'lenient') {
    thReporters += 1;
    thVelocity += 1.0;
  }
  if (inp.threadEscalated) {
    thReporters -= 1;
    thVelocity -= 1.0;
  }
  const signals: string[] = [];
  if (inp.reporterCount >= thReporters) {
    signals.push(`reporter_count=${inp.reporterCount}>=${thReporters}`);
  }
  if (inp.velocityZscore >= thVelocity) {
    signals.push(`velocity_z=${inp.velocityZscore.toFixed(1)}>=${thVelocity.toFixed(1)}`);
  }
  if (inp.userRiskTier === 'watched') {
    signals.push('user_risk_tier=watched');
  }
  if (
    inp.threadEscalated &&
    (inp.userRiskTier === 'neutral' || inp.userRiskTier === 'watched')
  ) {
    signals.push('thread_escalated+user_risk');
  }
  return signals;
}

function fastEligible(inp: StrategyInputs): boolean {
  if (inp.coldStart) return false;
  if (inp.threadEscalated) return false;
  return (
    inp.reporterCount === 1 &&
    inp.velocityZscore < FAST_VELOCITY_Z &&
    inp.ruleMatchScore >= FAST_RULE_MATCH &&
    (inp.userRiskTier === 'new' || inp.userRiskTier === 'trusted')
  );
}

function decision(tier: StrategyTier, rationale: string): StrategyDecision {
  const b = BUDGETS[tier];
  return { tier, ...b, rationale };
}
