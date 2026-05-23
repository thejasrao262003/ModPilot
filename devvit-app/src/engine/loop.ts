// Orchestrator loop — runs tools per tier plan, enforces budgets, early-stops.
// Mirrors engine/orchestrator/loop.py.

import { EvidenceAccumulator, ToolRegistry } from './accumulator';
import type { StrategyDecision } from './strategy';
import type { StrategyTier, ToolContext, ToolName } from './types';

export type StopReason = 'plan_complete' | 'converged' | 'budget_tool' | 'budget_time';

export type OrchestratorResult = {
  accumulator: EvidenceAccumulator;
  tier: StrategyTier;
  totalLatencyMs: number;
  toolsRun: number;
  earlyStopped: boolean;
  stopReason: StopReason;
  plan: ToolName[];
};

// policy_match isn't implemented in the TS port (needs embeddings). Including
// it in the plan adds a `skipped` ev-1 row that the model frequently
// hallucinates citations against. Drop it until we wire the embedding-based
// match; the Reasoner already gets rule text in the prompt context.
const DEFAULT_PLANS: Record<StrategyTier, ToolName[]> = {
  FAST: ['report_velocity', 'user_history'],
  STANDARD: ['report_velocity', 'user_history', 'prior_actions'],
  DEEP: ['report_velocity', 'user_history', 'prior_actions', 'thread_context'],
};

export class Orchestrator {
  constructor(private readonly registry: ToolRegistry) {}

  defaultPlan(tier: StrategyTier): ToolName[] {
    return [...DEFAULT_PLANS[tier]];
  }

  async run(args: {
    decision: StrategyDecision;
    context: ToolContext;
    plan?: ToolName[];
  }): Promise<OrchestratorResult> {
    const plan = args.plan ?? this.defaultPlan(args.decision.tier);
    const acc = new EvidenceAccumulator();
    const started = Date.now();
    let toolsRun = 0;
    let stopReason: StopReason = 'plan_complete';
    let earlyStopped = false;

    for (const toolName of plan) {
      const elapsed = Date.now() - started;
      if (elapsed >= args.decision.timeBudgetMs) {
        stopReason = 'budget_time';
        earlyStopped = true;
        break;
      }
      if (toolsRun >= args.decision.toolBudget) {
        stopReason = 'budget_tool';
        earlyStopped = true;
        break;
      }

      if (!this.registry.has(toolName)) {
        acc.append({
          tool: toolName,
          status: 'skipped',
          summary: `tool ${toolName} not registered`,
          latencyMs: 0,
          detail: {},
        });
        toolsRun += 1;
        continue;
      }

      const tool = this.registry.get(toolName);
      const t0 = Date.now();
      try {
        const result = await tool.run(args.context);
        acc.append(result);
      } catch (e) {
        acc.append({
          tool: toolName,
          status: 'failure',
          summary: `tool raised: ${e instanceof Error ? e.constructor.name : 'Error'}`,
          latencyMs: Date.now() - t0,
          detail: {},
          error: e instanceof Error ? e.message : String(e),
        });
      }
      toolsRun += 1;

      if (converged(acc, args.decision.tier)) {
        stopReason = 'converged';
        earlyStopped = true;
        break;
      }
    }

    return {
      accumulator: acc,
      tier: args.decision.tier,
      totalLatencyMs: Date.now() - started,
      toolsRun,
      earlyStopped,
      stopReason,
      plan,
    };
  }
}

function converged(acc: EvidenceAccumulator, tier: StrategyTier): boolean {
  const threshold = tier === 'FAST' ? 1 : 2;
  const strong = acc
    .successfulEntries()
    .filter((e) => e.detail.signal === 'high').length;
  return strong >= threshold;
}
