// Thread memory store — hash at `sub:{sub_id}:thread:{thread_id}`.
// Caches the Summarizer's last result + tracks whether a moderator has acted
// on this thread (used by Strategy Selector's thread_escalated input).
// Mirrors engine/store/postgres.py:get_thread_memory.

import { redis } from '@devvit/web/server';

import { threadMemoryKey } from './keys';

export type ThreadMemory = {
  arc: string;
  escalationTurn: number | null;
  instigatorCandidates: string[];
  offTopic: boolean;
  totalTurns: number;
  modActionsTaken: number;
};

export async function getThreadMemory(
  subId: string,
  threadId: string,
): Promise<ThreadMemory | null> {
  if (!threadId) return null;
  const row = await redis.hGetAll(threadMemoryKey(subId, threadId));
  if (!row || Object.keys(row).length === 0) return null;
  return {
    arc: row.arc || '',
    escalationTurn: row.escalation_turn ? Number.parseInt(row.escalation_turn, 10) : null,
    instigatorCandidates: row.instigator_candidates
      ? safeJsonArray(row.instigator_candidates)
      : [],
    offTopic: row.off_topic === 'true',
    totalTurns: Number.parseInt(row.total_turns ?? '0', 10) || 0,
    modActionsTaken: Number.parseInt(row.mod_actions_taken ?? '0', 10) || 0,
  };
}

export async function setThreadMemory(
  subId: string,
  threadId: string,
  mem: Omit<ThreadMemory, 'modActionsTaken'>,
): Promise<void> {
  if (!threadId) return;
  await redis.hSet(threadMemoryKey(subId, threadId), {
    arc: mem.arc,
    escalation_turn: mem.escalationTurn == null ? '' : String(mem.escalationTurn),
    instigator_candidates: JSON.stringify(mem.instigatorCandidates),
    off_topic: String(mem.offTopic),
    total_turns: String(mem.totalTurns),
  });
}

export async function bumpModAction(subId: string, threadId: string): Promise<void> {
  if (!threadId) return;
  await redis.hIncrBy(threadMemoryKey(subId, threadId), 'mod_actions_taken', 1);
}

function safeJsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
