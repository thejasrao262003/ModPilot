// thread_context tool — calls Gemini 2.5 Flash to summarize thread excerpts.
// Cache-aside via Devvit Redis. Mirrors engine/orchestrator/thread_context.py.

import {
  getCachedSummary,
  setCachedSummary,
  type CachedThreadSummary,
} from '../store/threadSummaryCache';
import { Summarizer } from '../llm/summarizer';
import type { GeminiClient } from '../llm/gemini';
import type { Tool, ToolContext, ToolResult } from '../types';

const MIN_COMMENTS = 10;
const SUMMARY_PREVIEW_CHARS = 180;

export class ThreadContextTool implements Tool {
  readonly name = 'thread_context' as const;
  private readonly summarizer: Summarizer;

  constructor(llm: GeminiClient) {
    this.summarizer = new Summarizer(llm);
  }

  async run(ctx: ToolContext): Promise<ToolResult> {
    const t0 = Date.now();
    const comments = ctx.threadExcerpts;
    if (comments.length < MIN_COMMENTS) {
      return {
        tool: this.name,
        status: 'skipped',
        summary: `thread too short for summary (${comments.length} < ${MIN_COMMENTS} comments)`,
        latencyMs: Date.now() - t0,
        detail: {
          reason: 'below_min_comments',
          comment_count: comments.length,
          threshold: MIN_COMMENTS,
        },
      };
    }

    let summary: CachedThreadSummary | null = null;
    let fromCache = false;
    if (ctx.threadId) {
      try {
        summary = await getCachedSummary(ctx.threadId);
        if (summary) fromCache = true;
      } catch {
        summary = null;
      }
    }

    if (summary === null) {
      try {
        const result = await this.summarizer.summarize({
          postBody: ctx.targetBody,
          comments,
          correlationId: ctx.correlationId,
        });
        summary = {
          arc: result.summary.arc,
          escalationTurn: result.summary.escalation_turn ?? null,
          instigatorCandidates: result.summary.instigator_candidates,
          offTopic: result.summary.off_topic,
          totalTurns: result.summary.total_turns,
        };
        if (ctx.threadId) {
          try {
            await setCachedSummary(ctx.threadId, summary);
          } catch {
            // Cache write failure is non-fatal.
          }
        }
      } catch (e) {
        return {
          tool: this.name,
          status: 'failure',
          summary: `summarizer call failed: ${e instanceof Error ? e.constructor.name : 'Error'}`,
          latencyMs: Date.now() - t0,
          detail: {},
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const signalHigh = summary.escalationTurn !== null;
    return {
      tool: this.name,
      status: 'success',
      summary: formatSummary(summary, fromCache),
      latencyMs: Date.now() - t0,
      detail: {
        arc: summary.arc,
        escalation_turn: summary.escalationTurn,
        instigator_candidates: summary.instigatorCandidates,
        off_topic: summary.offTopic,
        total_turns: summary.totalTurns,
        from_cache: fromCache,
        signal: signalHigh ? 'high' : 'neutral',
      },
    };
  }
}

function formatSummary(s: CachedThreadSummary, fromCache: boolean): string {
  const parts: string[] = [];
  if (s.escalationTurn !== null) parts.push(`escalation at turn ${s.escalationTurn}`);
  if (s.offTopic) parts.push('off-topic drift');
  if (parts.length === 0) parts.push('arc captured');
  const arc = s.arc.slice(0, SUMMARY_PREVIEW_CHARS);
  const label = fromCache ? 'cached' : 'fresh';
  let text = `thread: ${parts.join(', ')} — ${arc} (${label})`;
  if (text.length > 200) text = text.slice(0, 197) + '...';
  return text;
}
