// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Stubs become real handlers progressively. Today wiring: investigate-post and
// investigate-comment do a real `user_history` lookup against Reddit's API so
// we can shape the Engine's request from real data before S-1.2 lands.

import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';

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

// U-4.4 (partial): "Investigate with ModPilot" — fetch real user history
// for the target's author so we can validate the user_history tool shape.
menu.post('/investigate-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId as `t3_${string}`;
  console.log('modpilot.menu.investigate_post', { target: targetId });

  try {
    const post = await reddit.getPostById(targetId);
    // NOTE: `post.numberOfReports` is -1 here even when the post is reported,
    // because the menu-action API call runs without elevated mod context. The
    // authoritative report count comes from the onPostReport trigger payload
    // (`post.numReports`), which we'll cache in Redis keyed by post id under
    // S-1.1 so the investigation can read it without an API roundtrip.
    const history = await fetchAuthorHistory(post.authorId ?? '');
    console.log(
      'modpilot.user_history',
      JSON.stringify(
        {
          target: { id: post.id, title: post.title, authorId: post.authorId, numReports: post.numberOfReports },
          history,
        },
        null,
        2,
      ),
    );
    const authorName = 'authorName' in history ? history.authorName : 'unknown';
    return c.json<UiResponse>(
      {
        showToast: {
          text: `Investigation queued — pulled history for u/${authorName} (see playtest logs)`,
        },
      },
      200,
    );
  } catch (err) {
    console.error('modpilot.menu.investigate_post.error', err);
    return c.json<UiResponse>({ showToast: { text: `Investigation failed: ${String(err)}` } }, 200);
  }
});

menu.post('/investigate-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetId = request.targetId as `t1_${string}`;
  console.log('modpilot.menu.investigate_comment', { target: targetId });

  try {
    const comment = await reddit.getCommentById(targetId);
    const history = await fetchAuthorHistory(comment.authorId ?? '');
    console.log(
      'modpilot.user_history',
      JSON.stringify(
        {
          target: { id: comment.id, body: comment.body, authorId: comment.authorId },
          history,
        },
        null,
        2,
      ),
    );
    const authorName = 'authorName' in history ? history.authorName : 'unknown';
    return c.json<UiResponse>(
      {
        showToast: {
          text: `Investigation queued — pulled history for u/${authorName} (see playtest logs)`,
        },
      },
      200,
    );
  } catch (err) {
    console.error('modpilot.menu.investigate_comment.error', err);
    return c.json<UiResponse>({ showToast: { text: `Investigation failed: ${String(err)}` } }, 200);
  }
});

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
