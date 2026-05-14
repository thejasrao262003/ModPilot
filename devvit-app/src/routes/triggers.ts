// ModPilot trigger handlers. Spec: docs/03-Devvit.md, docs/Specs.md §6.1.
// S-1.1: report triggers dedupe to a stable correlation_id within 10 min and
// cache the trigger payload context (authoritative numReports etc.) into Redis
// so menu actions can read it. The engine `/investigate` call lands in S-1.2
// once the tunnel is in place — until then we log the would-be request.

import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { cacheTriggerContext, dedupForTarget } from '../services/dedup';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('modpilot.install', { subreddit: input.subreddit?.name });
  // TODO(I-3.5): seed subreddit_profile + cold_start=true
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-app-upgrade', async (c) => {
  console.log('modpilot.upgrade');
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

// S-1.1: report-trigger pipeline.
// 1. Pull the target id + author + numReports from the payload.
// 2. Dedup via Redis NX on `pending_investigation:{target_id}` (10-min window).
//    Duplicates within the window log + early-return with the same correlation_id.
// 3. New investigations cache the trigger context to `trigger_ctx:{target_id}`
//    so menu actions can read the authoritative numReports (the menu-action
//    API returns -1; only the trigger payload has the real count).
// 4. Log the would-be engine request. S-1.2 replaces the log with the call.

type CommentReportPayload = {
  comment?: { id?: string; authorId?: string; subredditId?: string };
  subreddit?: { id?: string; name?: string };
  reason?: string;
};

type PostReportPayload = {
  post?: { id?: string; authorId?: string; subredditId?: string; numReports?: number };
  subreddit?: { id?: string; name?: string };
  reason?: string;
};

triggers.post('/on-comment-report', async (c) => {
  const body = (await c.req.json()) as CommentReportPayload;
  const commentId = body.comment?.id;
  const subredditId = body.subreddit?.id ?? body.comment?.subredditId ?? '';
  const subredditName = body.subreddit?.name ?? '';

  if (!commentId) {
    console.warn('modpilot.comment_report.missing_id', body);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const dedup = await dedupForTarget(commentId);
  if (dedup.status === 'duplicate') {
    console.log('modpilot.comment_report.deduped', {
      correlation_id: dedup.correlationId,
      target_id: commentId,
      reason: body.reason,
    });
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  await cacheTriggerContext(commentId, {
    correlationId: dedup.correlationId,
    subredditId,
    subredditName,
    authorId: body.comment?.authorId ?? '',
    numReports: 1, // comment trigger payload doesn't include count; investigations re-derive
    reason: body.reason ?? '',
    receivedAt: new Date().toISOString(),
  });

  console.log('modpilot.comment_report.accepted', {
    correlation_id: dedup.correlationId,
    target_id: commentId,
    subreddit: subredditName,
    author: body.comment?.authorId,
    reason: body.reason,
  });
  // TODO(S-1.2): call Engine /investigate with HMAC-signed request
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-report', async (c) => {
  const body = (await c.req.json()) as PostReportPayload;
  const postId = body.post?.id;
  const subredditId = body.subreddit?.id ?? body.post?.subredditId ?? '';
  const subredditName = body.subreddit?.name ?? '';

  if (!postId) {
    console.warn('modpilot.post_report.missing_id', body);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const dedup = await dedupForTarget(postId);
  if (dedup.status === 'duplicate') {
    console.log('modpilot.post_report.deduped', {
      correlation_id: dedup.correlationId,
      target_id: postId,
      reason: body.reason,
    });
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  await cacheTriggerContext(postId, {
    correlationId: dedup.correlationId,
    subredditId,
    subredditName,
    authorId: body.post?.authorId ?? '',
    numReports: body.post?.numReports ?? 1,
    reason: body.reason ?? '',
    receivedAt: new Date().toISOString(),
  });

  console.log('modpilot.post_report.accepted', {
    correlation_id: dedup.correlationId,
    target_id: postId,
    subreddit: subredditName,
    author: body.post?.authorId,
    num_reports: body.post?.numReports,
    reason: body.reason,
  });
  // TODO(S-1.2): call Engine /investigate with HMAC-signed request
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

// Map Reddit's mod action strings to our 4-action enum. Anything else is
// observation-only (we still log the payload), not feedback.
const REDDIT_ACTION_MAP: Record<string, 'REMOVE' | 'APPROVE' | 'LOCK'> = {
  removelink: 'REMOVE',
  removecomment: 'REMOVE',
  spamlink: 'REMOVE',
  spamcomment: 'REMOVE',
  approvelink: 'APPROVE',
  approvecomment: 'APPROVE',
  lock: 'LOCK',
};

triggers.post('/on-mod-action', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown> & {
    action?: string;
    moderator?: { name?: string };
    targetPost?: { id?: string };
    targetComment?: { id?: string };
  };
  console.log('modpilot.mod_action', JSON.stringify(body, null, 2));

  // S-1.6: when a tracked mod action happens, record feedback against the
  // most recent investigation for that target (lookup in Redis by targetId).
  const mapped = REDDIT_ACTION_MAP[body.action ?? ''];
  const targetId = body.targetPost?.id || body.targetComment?.id;
  if (mapped && targetId) {
    try {
      const { redis } = await import('@devvit/web/server');
      await redis.hSet(`feedback:reddit-native:${targetId}`, {
        target_id: targetId,
        mod_action: mapped,
        raw_action: body.action ?? '',
        moderator: body.moderator?.name ?? 'unknown',
        source: 'reddit_native',
        at: new Date().toISOString(),
      });
      await redis.expire(`feedback:reddit-native:${targetId}`, 60 * 60 * 24 * 7);

      // I-3.8: record the resolution so the next "Investigate" modal renders
      // the collapsed "✓ Removed by u/X N min ago" header. Looks up the
      // active investigation's correlation_id (if any) to keep audit joins clean.
      const correlationId = (await redis.get(`pending_investigation:${targetId}`)) ?? '';
      const { recordResolution } = await import('../services/dedup');
      await recordResolution(targetId, {
        correlationId,
        modAction: mapped,
        moderatorName: body.moderator?.name ?? 'unknown',
        rawAction: body.action ?? '',
        source: 'reddit_native',
      });

      console.log('modpilot.feedback.reddit_native', {
        target_id: targetId,
        mod_action: mapped,
        correlation_id: correlationId,
      });
    } catch (err) {
      console.error('modpilot.feedback.reddit_native.failed', err);
    }
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
