// Report velocity store — sorted set of report-event timestamps per target.
// Score = epoch ms, member = unique event id. Window queries via zRange(byScore).
// Mirrors engine/store/redis.py:velocity_count + velocity_zscore.

import { redis } from '@devvit/web/server';

import { TTL_VELOCITY, velocityKey } from './keys';

export async function recordReportEvent(subId: string, targetId: string): Promise<void> {
  const key = velocityKey(subId, targetId);
  const now = Date.now();
  await redis.zAdd(key, { score: now, member: `${now}-${Math.random().toString(36).slice(2, 8)}` });
  await redis.expire(key, TTL_VELOCITY);
}

export async function countReportsInWindow(
  subId: string,
  targetId: string,
  windowSeconds: number,
): Promise<number> {
  const key = velocityKey(subId, targetId);
  const now = Date.now();
  const min = now - windowSeconds * 1000;
  // Prune scores below `min` so the sorted set stays bounded.
  await redis.zRemRangeByScore(key, 0, min - 1);
  const members = await redis.zRange(key, min, now, { by: 'score' });
  return members.length;
}

// Simple z-score against a static baseline (matches Python defaults).
const DEFAULT_BASELINE_MEAN = 1.0;
const DEFAULT_BASELINE_STDDEV = 1.0;

export function velocityZscore(count: number): number {
  return (count - DEFAULT_BASELINE_MEAN) / DEFAULT_BASELINE_STDDEV;
}
