// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Today's investigate-comment / investigate-post handlers create a custom
// post via reddit.submitCustomPost and navigate the mod to it. Author-history
// enrichment (validated earlier against u/trendy_guy2003) will move to the
// engine side under I-3.1 — pulling it from the menu request keeps the
// platform's OnAction RPC well under its time budget.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import type { JsonObject } from '@devvit/shared-types/json.js';

export const menu = new Hono();

// U-4.4: "Investigate with ModPilot" — creates a Verdict Card custom post
// rendered from src/client/index.html, then navigates the mod to it.
// Logs entry/exit at every step so we can isolate which call fails when the
// platform reports "OnAction INTERNAL: status 36".
menu.post('/investigate-post', async (c) => {
  console.log('modpilot.menu.investigate_post.entered');
  try {
    const request = await c.req.json<MenuItemRequest>();
    const targetId = request.targetId as `t3_${string}`;
    console.log('modpilot.menu.investigate_post.target', targetId);

    const post = await reddit.getPostById(targetId);
    console.log('modpilot.menu.investigate_post.got_post', { id: post.id, author: post.authorId });

    const subreddit = await reddit.getSubredditById(post.subredditId);
    const subredditName = subreddit?.name ?? 'ModPilotDev';
    const correlationId = `inv-${Date.now()}-${targetId.slice(3, 10)}`;

    const target: JsonObject = {
      kind: 'post',
      id: post.id,
      title: post.title ?? '',
      author: post.authorName ?? '',
      authorId: post.authorId ?? '',
      subreddit: subredditName,
      report_count: post.numberOfReports >= 0 ? post.numberOfReports : 0,
    };

    return await submitVerdictPost(c, {
      correlationId,
      title: `ModPilot · ${truncate(post.title ?? 'post', 48)}`,
      subredditName,
      target,
    });
  } catch (err) {
    console.error('modpilot.menu.investigate_post.error', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
});

menu.post('/investigate-comment', async (c) => {
  console.log('modpilot.menu.investigate_comment.entered');
  try {
    const request = await c.req.json<MenuItemRequest>();
    const targetId = request.targetId as `t1_${string}`;
    console.log('modpilot.menu.investigate_comment.target', targetId);

    const comment = await reddit.getCommentById(targetId);
    console.log('modpilot.menu.investigate_comment.got_comment', { id: comment.id });

    const subreddit = await reddit.getSubredditById(comment.subredditId);
    const subredditName = subreddit?.name ?? 'ModPilotDev';
    const correlationId = `inv-${Date.now()}-${targetId.slice(3, 10)}`;

    const target: JsonObject = {
      kind: 'comment',
      id: comment.id,
      body: truncate(comment.body ?? '', 200),
      author: comment.authorName ?? '',
      authorId: comment.authorId ?? '',
      subreddit: subredditName,
    };

    return await submitVerdictPost(c, {
      correlationId,
      title: `ModPilot · comment by u/${comment.authorName ?? 'unknown'}`,
      subredditName,
      target,
    });
  } catch (err) {
    console.error('modpilot.menu.investigate_comment.error', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
});

type InvestigationInputs = {
  correlationId: string;
  title: string;
  subredditName: string;
  target: JsonObject;
};

async function submitVerdictPost(c: Context, inputs: InvestigationInputs) {
  const postData: JsonObject = { target: inputs.target, correlationId: inputs.correlationId };
  console.log('modpilot.menu.submit_custom_post.calling', {
    subreddit: inputs.subredditName,
    correlation_id: inputs.correlationId,
    title: inputs.title,
  });
  const post = await reddit.submitCustomPost({
    subredditName: inputs.subredditName,
    title: inputs.title,
    postData,
    textFallback: { text: `ModPilot verdict ${inputs.correlationId}.` },
  });
  console.log('modpilot.menu.submit_custom_post.created', {
    post_id: post.id,
    permalink: post.permalink,
  });
  return c.json<UiResponse>(
    {
      navigateTo: post.permalink,
      showToast: { text: 'Verdict ready — opening the case file…', appearance: 'success' },
    },
    200,
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// U-4.5: "Summarize this thread" — modal with arc/escalation/instigator/off-topic.
menu.post('/summarize-thread', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.summarize_thread', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Thread summarization — TODO(U-4.5)' } }, 200);
});

// U-4.7: "Explain ModPilot's last call" — re-renders cached verdict from Redis.
menu.post('/explain-last', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.explain_last', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Last verdict lookup — TODO(U-4.7)' } }, 200);
});
