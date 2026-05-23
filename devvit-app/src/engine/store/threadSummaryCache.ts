// Thread summary cache — JSON string at `thread_sum:{thread_id}`, 24h TTL.
// Decoupled from threadMemory: the cache is the summarizer's last raw output;
// thread_memory is the post-decision record (incl. mod actions). Mirrors
// engine/store/redis.py:get_thread_summary / set_thread_summary.

import { redis } from '@devvit/web/server';

import { TTL_THREAD_SUMMARY, threadSummaryCacheKey } from './keys';

export type CachedThreadSummary = {
  arc: string;
  escalationTurn: number | null;
  instigatorCandidates: string[];
  offTopic: boolean;
  totalTurns: number;
};

export async function getCachedSummary(threadId: string): Promise<CachedThreadSummary | null> {
  if (!threadId) return null;
  const raw = await redis.get(threadSummaryCacheKey(threadId));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<CachedThreadSummary>;
    if (typeof obj.arc !== 'string') return null;
    return {
      arc: obj.arc,
      escalationTurn: obj.escalationTurn ?? null,
      instigatorCandidates: Array.isArray(obj.instigatorCandidates)
        ? obj.instigatorCandidates.filter((x): x is string => typeof x === 'string')
        : [],
      offTopic: !!obj.offTopic,
      totalTurns: Number(obj.totalTurns ?? 0),
    };
  } catch {
    return null;
  }
}

export async function setCachedSummary(
  threadId: string,
  s: CachedThreadSummary,
): Promise<void> {
  if (!threadId) return;
  await redis.set(threadSummaryCacheKey(threadId), JSON.stringify(s), {
    expiration: new Date(Date.now() + TTL_THREAD_SUMMARY * 1000),
  });
}
