// "ModPilot: Stats" — opens a custom-post webview (polished UI).
//
// Per official Devvit docs (capabilities/client/forms.mdx), showForm has no
// CSS / theme / HTML escape hatch. The only path to a real-looking dashboard
// is a custom post with our own webview.
//
// Flow:
//   1. submitCustomPost with postData.kind = 'stats'
//   2. Auto-remove → lands in mod queue, not public feed (same as verdict posts)
//   3. Write post_kind:{post_id} = 'stats' + post_stats_sub:{post_id} = subId
//   4. navigateTo the post
//
// The webview's /api/verdict request dispatches based on post_kind.

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, redis, reddit } from '@devvit/web/server';

export const menuStats = new Hono();

menuStats.post('/open', async (c) => {
  const subId = context.subredditId;
  if (!subId) {
    return c.json<UiResponse>(
      { showToast: { text: 'No subreddit context available.' } },
      200,
    );
  }

  try {
    const subreddit = await reddit.getCurrentSubreddit();
    if (!subreddit?.name) {
      return c.json<UiResponse>(
        { showToast: { text: 'Could not resolve subreddit name.' } },
        200,
      );
    }

    const post = await reddit.submitCustomPost({
      subredditName: subreddit.name,
      title: `📊 ModPilot Stats · r/${subreddit.name}`,
      postData: { kind: 'stats', sub_id: subId },
      textFallback: {
        text: `ModPilot stats dashboard for r/${subreddit.name}.`,
      },
    });

    try {
      await post.remove();
    } catch (err) {
      console.warn('modpilot.stats.auto_remove_failed', {
        post_id: post.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    await redis.set(`post_kind:${post.id}`, 'stats', {
      expiration: new Date(Date.now() + 60 * 60 * 24 * 7 * 1000),
    });
    await redis.set(`post_stats_sub:${post.id}`, subId, {
      expiration: new Date(Date.now() + 60 * 60 * 24 * 7 * 1000),
    });

    console.log('modpilot.stats.custom_post.created', {
      post_id: post.id,
      sub_id: subId,
      permalink: post.permalink,
    });

    return c.json<UiResponse>(
      { navigateTo: `https://reddit.com${post.permalink}` },
      200,
    );
  } catch (err) {
    console.error('modpilot.stats.open_failed', err instanceof Error ? err.stack : err);
    return c.json<UiResponse>(
      { showToast: { text: `Failed to open stats: ${String(err)}` } },
      200,
    );
  }
});
