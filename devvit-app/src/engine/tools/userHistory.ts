// user_history tool — fetches UserMemory from Devvit Redis.
// Mirrors engine/orchestrator/user_history.py.

import { getUserMemory } from '../store/userMemory';
import type { Tool, ToolContext, ToolResult } from '../types';

export class UserHistoryTool implements Tool {
  readonly name = 'user_history' as const;

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
      const mem = await getUserMemory(ctx.subredditId, ctx.targetAuthorId);
      if (mem === null) {
        return {
          tool: this.name,
          status: 'success',
          summary: 'no prior history — first-time user',
          latencyMs: Date.now() - t0,
          detail: {
            risk_tier: 'new',
            prior_violations: 0,
            prior_approvals: 0,
            has_history: false,
          },
        };
      }
      const signal = signalStrength(mem.riskTier, mem.priorViolations);
      const summary =
        `user tier=${mem.riskTier}, ${mem.priorViolations} violation(s), ${mem.priorApprovals} approval(s)`
          .slice(0, 200);
      return {
        tool: this.name,
        status: 'success',
        summary,
        latencyMs: Date.now() - t0,
        detail: {
          risk_tier: mem.riskTier,
          prior_violations: mem.priorViolations,
          prior_approvals: mem.priorApprovals,
          has_history: true,
          last_seen_at: mem.lastSeenAt,
          signal,
        },
      };
    } catch (e) {
      return {
        tool: this.name,
        status: 'failure',
        summary: 'user history lookup failed',
        latencyMs: Date.now() - t0,
        detail: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function signalStrength(riskTier: string, violations: number): string {
  if (riskTier === 'watched' || violations >= 3) return 'high';
  if (riskTier === 'trusted') return 'high';
  return 'normal';
}
