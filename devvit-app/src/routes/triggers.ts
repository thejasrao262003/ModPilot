// ModPilot trigger handlers. Spec: docs/03-Devvit.md, docs/Specs.md §6.1.
// Real wiring (engine client, dedup, KV) lands in S-1.1+. Stubs only.

import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';

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

// === S-1.1: real implementation lands here ===
// During F-0.4 we log the full payload so we can shape the Engine request
// from real data instead of guesses.
triggers.post('/on-comment-report', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  console.log('modpilot.comment_report', JSON.stringify(body, null, 2));
  // TODO(S-1.1): dedup via Devvit KV `pending_investigation:{comment_id}`
  // TODO(S-1.2): call Engine /investigate with HMAC-signed request
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-report', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  console.log('modpilot.post_report', JSON.stringify(body, null, 2));
  // TODO(S-1.1): same pipeline as comment report
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
      // We won't have a correlation_id from a Reddit-native action; key by
      // target instead so the engine can join them at aggregation time.
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
      console.log('modpilot.feedback.reddit_native', {
        target_id: targetId,
        mod_action: mapped,
      });
    } catch (err) {
      console.error('modpilot.feedback.reddit_native.failed', err);
    }
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
