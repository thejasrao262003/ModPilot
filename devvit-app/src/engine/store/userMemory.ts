// User memory store — hash at `sub:{sub_id}:user:{user_id}`.
// Mirrors engine/store/postgres.py:get_user_memory.

import { redis } from '@devvit/web/server';

import type { UserRiskTier } from '../types';
import { userMemoryKey } from './keys';

export type UserMemory = {
  riskTier: UserRiskTier;
  priorViolations: number;
  priorApprovals: number;
  lastSeenAt: string | null;
};

export async function getUserMemory(
  subId: string,
  userId: string,
): Promise<UserMemory | null> {
  if (!userId) return null;
  const row = await redis.hGetAll(userMemoryKey(subId, userId));
  if (!row || Object.keys(row).length === 0) return null;
  return {
    riskTier: (row.risk_tier as UserRiskTier) || 'new',
    priorViolations: Number.parseInt(row.prior_violations ?? '0', 10) || 0,
    priorApprovals: Number.parseInt(row.prior_approvals ?? '0', 10) || 0,
    lastSeenAt: row.last_seen_at || null,
  };
}

export async function bumpViolation(subId: string, userId: string): Promise<void> {
  if (!userId) return;
  const key = userMemoryKey(subId, userId);
  await redis.hIncrBy(key, 'prior_violations', 1);
  await redis.hSet(key, { last_seen_at: new Date().toISOString() });
}

export async function bumpApproval(subId: string, userId: string): Promise<void> {
  if (!userId) return;
  const key = userMemoryKey(subId, userId);
  await redis.hIncrBy(key, 'prior_approvals', 1);
  await redis.hSet(key, { last_seen_at: new Date().toISOString() });
}
