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
triggers.post('/on-comment-report', async (c) => {
  const body = (await c.req.json()) as { comment?: { id?: string }; subreddit?: { name?: string } };
  console.log('modpilot.comment_report', {
    comment_id: body.comment?.id,
    subreddit: body.subreddit?.name,
  });
  // TODO(S-1.1): dedup via Devvit KV `pending_investigation:{comment_id}`
  // TODO(S-1.2): call Engine /investigate with HMAC-signed request
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-post-report', async (c) => {
  const body = (await c.req.json()) as { post?: { id?: string }; subreddit?: { name?: string } };
  console.log('modpilot.post_report', { post_id: body.post?.id, subreddit: body.subreddit?.name });
  // TODO(S-1.1): same pipeline as comment report
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-mod-action', async (c) => {
  const body = (await c.req.json()) as { action?: string; moderator?: { name?: string } };
  console.log('modpilot.mod_action', { action: body.action, moderator: body.moderator?.name });
  // TODO(S-1.6): record feedback to Engine /feedback for ModPilot alignment
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
