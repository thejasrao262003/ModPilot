// Subreddit profile store — hash at `sub:{sub_id}:profile`.
// Lazily created on first investigation. Mirrors engine/store/postgres.py:ensure_subreddit_profile.

import { redis } from '@devvit/web/server';

import type { Personality, TierOverride } from '../types';
import { subProfileKey } from './keys';

export type SubredditProfile = {
  personality: Personality;
  region: string;
  rules: string;
  coldStartCount: number;
  tierOverride: TierOverride;
  // Per-subreddit Gemini API key (Feature: BYO key). Each installing mod team
  // sets their own via "Configure policy" so the bill goes to their Google
  // account. Stored in Devvit-managed Redis (encrypted at rest by Reddit).
  // Empty string means "use the build-time default in geminiConfig.local.ts".
  geminiApiKey: string;
};

const DEFAULTS: SubredditProfile = {
  personality: 'balanced',
  region: 'Global',
  rules: '',
  coldStartCount: 0,
  tierOverride: 'auto',
  geminiApiKey: '',
};

export async function ensureSubredditProfile(subId: string): Promise<SubredditProfile> {
  const key = subProfileKey(subId);
  const row = await redis.hGetAll(key);
  if (row && Object.keys(row).length > 0) {
    return parseProfile(row);
  }
  // First-touch only — write defaults using HSETNX-style semantics so we
  // never overwrite a configured profile. Specifically, set each field
  // *conditionally*: hSet's existing fields are preserved by Devvit Redis
  // (it's a partial-update merge), so even if a race produced an empty
  // read, a configured profile saved on the next path is recoverable.
  await redis.hSet(key, {
    personality: DEFAULTS.personality,
    region: DEFAULTS.region,
    rules: DEFAULTS.rules,
    cold_start_count: String(DEFAULTS.coldStartCount),
    tier_override: DEFAULTS.tierOverride,
  });
  return { ...DEFAULTS };
}

export async function incrementColdStartCount(subId: string): Promise<number> {
  return redis.hIncrBy(subProfileKey(subId), 'cold_start_count', 1);
}

function parseProfile(row: Record<string, string>): SubredditProfile {
  const personality = (row.personality as Personality) || DEFAULTS.personality;
  const tierOverride = (row.tier_override as TierOverride) || DEFAULTS.tierOverride;
  const coldStartCount = Number.parseInt(row.cold_start_count ?? '0', 10) || 0;
  return {
    personality,
    region: row.region || DEFAULTS.region,
    rules: row.rules || DEFAULTS.rules,
    coldStartCount,
    tierOverride,
    geminiApiKey: row.gemini_api_key || '',
  };
}
