// prior_actions tool — fetches the most recent N investigations on this author.
// Mirrors engine/orchestrator/prior_actions.py.

import { listPriorActionsOnUser } from '../store/investigation';
import type { Tool, ToolContext, ToolResult } from '../types';

const LIMIT = 3;

export class PriorActionsTool implements Tool {
  readonly name = 'prior_actions' as const;

  async run(ctx: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    if (!ctx.targetAuthorId) {
      return {
        tool: this.name,
        status: 'skipped',
        summary: 'no author id available',
        latencyMs: Date.now() - t0,
        detail: {},
      };
    }
    try {
      const actions = await listPriorActionsOnUser(ctx.subredditId, ctx.targetAuthorId, LIMIT);
      if (actions.length === 0) {
        return {
          tool: this.name,
          status: 'success',
          summary: 'no prior mod actions on this user',
          latencyMs: Date.now() - t0,
          detail: { prior_actions: [], count: 0 },
        };
      }
      const removes = actions.filter((a) => a.recommendation === 'REMOVE').length;
      const signal = removes >= 2 ? 'high' : 'normal';
      const summary = `${actions.length} prior action(s); ${removes} removal(s)`.slice(0, 200);
      return {
        tool: this.name,
        status: 'success',
        summary,
        latencyMs: Date.now() - t0,
        detail: {
          prior_actions: actions.map((a) => ({
            recommendation: a.recommendation,
            risk_tier: a.riskTier,
            confidence: a.confidence,
            target_kind: a.targetKind,
            target_id: a.targetId,
            completed_at: a.completedAt,
          })),
          count: actions.length,
          removals: removes,
          signal,
        },
      };
    } catch (e) {
      return {
        tool: this.name,
        status: 'failure',
        summary: 'prior actions lookup failed',
        latencyMs: Date.now() - t0,
        detail: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
