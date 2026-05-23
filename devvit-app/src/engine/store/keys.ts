// Devvit Redis key namespacing. Subreddit-scoped on every persisted key,
// per docs/CLAUDE.md hard rule 7 (Subreddit isolation).
//
// Mirrors the Python engine's logical tables (engine/store/models.py) but
// flattened to Redis primitives. ADR-0007 §Data model.

export const subProfileKey = (subId: string): string => `sub:${subId}:profile`;
export const userMemoryKey = (subId: string, userId: string): string =>
  `sub:${subId}:user:${userId}`;
export const threadMemoryKey = (subId: string, threadId: string): string =>
  `sub:${subId}:thread:${threadId}`;
export const authorInvIndexKey = (subId: string, authorId: string): string =>
  `sub:${subId}:author:${authorId}:invs`;
export const investigationKey = (correlationId: string): string =>
  `inv:${correlationId}`;
export const velocityKey = (subId: string, targetId: string): string =>
  `vel:${subId}:${targetId}`;
export const threadSummaryCacheKey = (threadId: string): string =>
  `thread_sum:${threadId}`;
export const verdictKey = (correlationId: string): string =>
  `verdict:${correlationId}`;

// TTLs (seconds)
export const TTL_THREAD_SUMMARY = 60 * 60 * 24; // 24h
export const TTL_VELOCITY = 60 * 60; // 1h sliding window pruning safety
export const TTL_VERDICT = 60 * 60 * 24 * 7; // 7d
