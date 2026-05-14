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
const RESOLUTION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7d — resolved state shown until the verdict cache expires

export type DedupResult =
  | { status: 'new'; correlationId: string; reportCount: number; firstReportedAt: string }
  | {
      status: 'duplicate';
      correlationId: string;
      reportCount: number;
      firstReportedAt: string;
    };

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
  const countKey = `pending_count:${targetId}`;
  const firstAtKey = `pending_first_at:${targetId}`;

  const newCorrelationId = `inv-${Date.now()}-${targetId.slice(3, 10)}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const nowIso = new Date().toISOString();

  // Devvit Redis's SetOptions.expiration is a Date, not a TTL-in-seconds.
  // The platform internally converts it to seconds-from-now.
  const expiration = new Date(Date.now() + DEDUP_TTL_SECONDS * 1000);
  const stored = await redis.set(key, newCorrelationId, { nx: true, expiration });

  // Increment the dedup-window report counter atomically (I-3.8) so the
  // verdict modal can annotate "Re-reported N times in M min".
  const reportCount = await redis.incrBy(countKey, 1);
  await redis.expire(countKey, DEDUP_TTL_SECONDS);

  // With nx=true: if the key was set, the return matches what we wrote.
  // If nx rejected (key exists), the platform returns undefined/empty.
  if (stored === newCorrelationId || stored === 'OK') {
    // First report in the window — record when it happened (for the "in M min" math).
    await redis.set(firstAtKey, nowIso, {
      expiration: new Date(Date.now() + DEDUP_TTL_SECONDS * 1000),
    });
    return {
      status: 'new',
      correlationId: newCorrelationId,
      reportCount,
      firstReportedAt: nowIso,
    };
  }

  // NX rejected — read the existing id + firstReportedAt.
  const existing = await redis.get(key);
  const firstAt = (await redis.get(firstAtKey)) ?? nowIso;
  return {
    status: 'duplicate',
    correlationId: existing ?? newCorrelationId,
    reportCount,
    firstReportedAt: firstAt,
  };
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

// === I-3.8: re-report counter + resolution state =========================

/**
 * Read the current in-window report stats for a target. Returns `null` when
 * no investigation is active (counter expired with the 10-min window).
 */
export async function readReportStats(
  targetId: string,
): Promise<{ reportCount: number; firstReportedAt: string } | null> {
  const countRaw = await redis.get(`pending_count:${targetId}`);
  if (!countRaw) return null;
  const reportCount = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(reportCount)) return null;
  const firstAt = (await redis.get(`pending_first_at:${targetId}`)) ?? new Date().toISOString();
  return { reportCount, firstReportedAt: firstAt };
}

/**
 * Record that a moderator took action on a target with a known investigation.
 * Used by the form modal + "Explain ModPilot's last call" to render the
 * resolved-state header per docs/09-UX.md §4.6.
 */
export async function recordResolution(
  targetId: string,
  resolution: {
    correlationId: string;
    modAction: 'REMOVE' | 'APPROVE' | 'ESCALATE' | 'LOCK';
    moderatorName: string;
    rawAction: string;
    source: 'verdict_card' | 'reddit_native';
  },
): Promise<void> {
  const key = `resolution:${targetId}`;
  await redis.hSet(key, {
    correlation_id: resolution.correlationId,
    mod_action: resolution.modAction,
    moderator_name: resolution.moderatorName,
    raw_action: resolution.rawAction,
    source: resolution.source,
    resolved_at: new Date().toISOString(),
  });
  await redis.expire(key, RESOLUTION_TTL_SECONDS);
}

export type ResolvedState = {
  correlationId: string;
  modAction: string;
  moderatorName: string;
  source: string;
  resolvedAt: string;
};

export async function readResolution(targetId: string): Promise<ResolvedState | null> {
  const row = await redis.hGetAll(`resolution:${targetId}`);
  if (!row || Object.keys(row).length === 0) return null;
  return {
    correlationId: row.correlation_id ?? '',
    modAction: row.mod_action ?? '',
    moderatorName: row.moderator_name ?? '',
    source: row.source ?? '',
    resolvedAt: row.resolved_at ?? '',
  };
}

/** Render "N min ago" / "just now" / "1 hr ago" from an ISO timestamp. */
export function relativeAgo(isoTimestamp: string, now: Date = new Date()): string {
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 30) return 'just now';
  if (seconds < 90) return '1 min ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
