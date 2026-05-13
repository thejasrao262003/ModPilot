// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Stubs become real handlers progressively. Today wiring: investigate-post and
// investigate-comment do a real `user_history` lookup against Reddit's API so
// we can shape the Engine's request from real data before S-1.2 lands.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import type { JsonObject } from '@devvit/shared-types/json.js';

export const menu = new Hono();

type HistorySnapshot = {
  authorId: string;
  authorName: string | undefined;
  createdAtUtc: number | undefined;
  karmaTotal: number | undefined;
  recentPosts: Array<{ id: string; title: string; subreddit: string; createdAt: number; score: number }>;
  recentComments: Array<{ id: string; subreddit: string; postId: string; createdAt: number; score: number; bodyPreview: string }>;
};

async function fetchAuthorHistory(authorId: string): Promise<HistorySnapshot | { error: string }> {
  const author = await reddit.getUserById(authorId as `t2_${string}`);
  if (!author) return { error: `user ${authorId} not found` };

  const [posts, comments] = await Promise.all([
    reddit.getPostsByUser({ username: author.username, sort: 'new', limit: 10 }).all(),
    reddit.getCommentsByUser({ username: author.username, sort: 'new', limit: 10 }).all(),
  ]);

  return {
    authorId,
    authorName: author.username,
    createdAtUtc: author.createdAt?.getTime?.() ?? undefined,
    karmaTotal: (author as unknown as { linkKarma?: number; commentKarma?: number }).linkKarma,
    recentPosts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      subreddit: p.subredditName ?? '',
      createdAt: p.createdAt?.getTime?.() ?? 0,
      score: p.score ?? 0,
    })),
    recentComments: comments.map((c) => ({
      id: c.id,
      subreddit: c.subredditName ?? '',
      postId: c.postId ?? '',
      createdAt: c.createdAt?.getTime?.() ?? 0,
      score: c.score ?? 0,
      bodyPreview: (c.body ?? '').slice(0, 140),
    })),
  };
}

// U-4.4: "Investigate with ModPilot" — creates a Verdict Card custom post
// rendered from public/index.html, then navigates the mod to it.
// During S-1.4 the post fetches `/api/verdict/canned` (mirrors engine canned
// verdict per Specs §10.2). S-1.2 will swap that for a real Engine call.
menu.post('/investigate-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId as `t3_${string}`;
  return investigateAndOpenVerdict(c, async () => {
    const post = await reddit.getPostById(targetId);
    const history = await fetchAuthorHistory(post.authorId ?? '');
    const authorName = 'authorName' in history ? history.authorName : 'unknown';
    const correlationId = `inv-${Date.now()}-${targetId.slice(3, 10)}`;
    const subreddit = await reddit.getSubredditById(post.subredditId);
    console.log('modpilot.menu.investigate_post', { target: targetId, correlation_id: correlationId });
    return {
      correlationId,
      title: `ModPilot · investigating ${truncate(post.title, 48)}`,
      subredditName: subreddit?.name ?? 'modpilotdemo',
      target: {
        kind: 'post',
        id: post.id,
        title: post.title,
        author: authorName ?? '',
        authorId: post.authorId ?? '',
        subreddit: subreddit?.name ?? 'modpilotdemo',
        report_count: post.numberOfReports >= 0 ? post.numberOfReports : 0,
      } satisfies JsonObject,
    };
  });
});

menu.post('/investigate-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId as `t1_${string}`;
  return investigateAndOpenVerdict(c, async () => {
    const comment = await reddit.getCommentById(targetId);
    const history = await fetchAuthorHistory(comment.authorId ?? '');
    const authorName = 'authorName' in history ? history.authorName : 'unknown';
    const correlationId = `inv-${Date.now()}-${targetId.slice(3, 10)}`;
    const subreddit = await reddit.getSubredditById(comment.subredditId);
    console.log('modpilot.menu.investigate_comment', { target: targetId, correlation_id: correlationId });
    return {
      correlationId,
      title: `ModPilot · investigating comment by u/${authorName}`,
      subredditName: subreddit?.name ?? 'modpilotdemo',
      target: {
        kind: 'comment',
        id: comment.id,
        body: truncate(comment.body ?? '', 200),
        author: authorName ?? '',
        authorId: comment.authorId ?? '',
        subreddit: subreddit?.name ?? 'modpilotdemo',
      } satisfies JsonObject,
    };
  });
});

type InvestigationInputs = {
  correlationId: string;
  title: string;
  subredditName: string;
  target: JsonObject;
};

async function investigateAndOpenVerdict(
  c: Context,
  buildInputs: () => Promise<InvestigationInputs>,
) {
  try {
    const inputs = await buildInputs();
    const postData: JsonObject = {
      target: inputs.target,
      correlationId: inputs.correlationId,
    };
    const post = await reddit.submitCustomPost({
      subredditName: inputs.subredditName,
      title: inputs.title,
      splash: { appDisplayName: 'ModPilot' },
      postData,
    });
    return c.json<UiResponse>(
      {
        navigateTo: post.permalink,
        showToast: { text: 'Verdict ready — opening the case file…', appearance: 'success' },
      },
      200,
    );
  } catch (err) {
    console.error('modpilot.menu.investigate.error', err);
    return c.json<UiResponse>(
      { showToast: { text: `Investigation failed: ${String(err)}` } },
      200,
    );
  }
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
