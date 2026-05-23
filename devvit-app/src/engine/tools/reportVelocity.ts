// report_velocity tool — sliding-window count + z-score over Devvit Redis sorted set.
// Mirrors engine/orchestrator/report_velocity.py.

import {
  countReportsInWindow,
  recordReportEvent,
  velocityZscore,
} from '../store/velocity';
import type { Tool, ToolContext, ToolResult } from '../types';

export class ReportVelocityTool implements Tool {
  readonly name = 'report_velocity' as const;

  async run(ctx: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    try {
      // Record this report event so subsequent calls see the bump.
      await recordReportEvent(ctx.subredditId, ctx.targetId);
      const [c1, c5, c15] = await Promise.all([
        countReportsInWindow(ctx.subredditId, ctx.targetId, 60),
        countReportsInWindow(ctx.subredditId, ctx.targetId, 300),
        countReportsInWindow(ctx.subredditId, ctx.targetId, 900),
      ]);
      const z = velocityZscore(c5);
      const summary = `${c5} reports in 5 min (z=${z.toFixed(1)})`.slice(0, 200);
      return {
        tool: this.name,
        status: 'success',
        summary,
        latencyMs: Date.now() - t0,
        detail: {
          reports_1m: c1,
          reports_5m: c5,
          reports_15m: c15,
          z_score: z,
        },
      };
    } catch (e) {
      return {
        tool: this.name,
        status: 'failure',
        summary: 'velocity lookup failed',
        latencyMs: Date.now() - t0,
        detail: {},
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
