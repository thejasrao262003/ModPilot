// Dedup + correlation-id generation for report triggers.
// Spec: docs/Specs.md §6.1, docs/03-Devvit.md, Implementation Tracker S-1.1.
//
// Reddit fires onCommentReport/onPostReport every time anyone reports a target.
// We don't want to start a fresh investigation per reporter — they pile on.
// The dedup window is 10 minutes per docs/Specs.md §6.3. Re-fires within that
// window return the existing correlation_id so the engine call stays idempotent.

import { redis } from '@devvit/web/server';

const DEDUP_TTL_SECONDS = 60 * 10; // 10 minutes
const CONTEXT_TTL_SECONDS = 60 * 60 * 24; // 24h — for menu actions that need authoritative numReports

export type DedupResult =
  | { status: 'new'; correlationId: string }
  | { status: 'duplicate'; correlationId: string };

/**
 * Returns a stable correlation_id for the given target. If this is the first
 * call within the dedup window, persists a new id and reports `status: 'new'`.
 * Subsequent calls within 10 minutes return the same id with `status: 'duplicate'`.
 *
 * Uses Redis SET with NX (only-if-not-exists). The non-NX `set` call would race
 * with a parallel report; the conditional path is atomic.
 */
export async function dedupForTarget(targetId: string): Promise<DedupResult> {
  const key = `pending_investigation:${targetId}`;
  const newCorrelationId = `inv-${Date.now()}-${targetId.slice(3, 10)}-${crypto
    .randomUUID()
    .slice(0, 8)}`;

  // Devvit Redis's set() supports an `nx` flag; if the key already exists we
  // read its value and return that as the existing correlation_id.
  const stored = (await (
    redis as unknown as {
      set: (k: string, v: string, opts?: { nx?: boolean; expiration?: number }) => Promise<string | undefined>;
    }
  ).set(key, newCorrelationId, { nx: true, expiration: DEDUP_TTL_SECONDS })) as
    | string
    | undefined;

  if (stored === newCorrelationId || stored === 'OK') {
    return { status: 'new', correlationId: newCorrelationId };
  }

  // NX rejected — read the existing id.
  const existing = await redis.get(key);
  return { status: 'duplicate', correlationId: existing ?? newCorrelationId };
}

/**
 * Cache the trigger-payload context for a target so menu actions can read it
 * later. Specifically captures `numReports` (the menu-action API returns -1
 * because it lacks elevated mod scope) and a few other handy fields.
 */
export async function cacheTriggerContext(
  targetId: string,
  ctx: {
    correlationId: string;
    subredditId: string;
    subredditName: string;
    authorId: string;
    numReports: number;
    reason: string;
    receivedAt: string;
  },
): Promise<void> {
  const key = `trigger_ctx:${targetId}`;
  await redis.hSet(key, {
    correlation_id: ctx.correlationId,
    subreddit_id: ctx.subredditId,
    subreddit_name: ctx.subredditName,
    author_id: ctx.authorId,
    num_reports: String(ctx.numReports),
    reason: ctx.reason,
    received_at: ctx.receivedAt,
  });
  await redis.expire(key, CONTEXT_TTL_SECONDS);
}
