// ModPilot trigger handlers. Spec: docs/03-Devvit.md, docs/Specs.md §6.1.
// S-1.1: report triggers dedupe to a stable correlation_id within 10 min and
// cache the trigger payload context (authoritative numReports etc.) into Redis
// so menu actions can read it. The engine `/investigate` call lands in S-1.2
// once the tunnel is in place — until then we log the would-be request.

import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { redis } from '@devvit/web/server';
import { cacheTriggerContext, dedupForTarget } from '../services/dedup';

export const triggers = new Hono();

// True when a postId belongs to a ModPilot-created custom post (i.e.
// menu.ts:submitVerdictPost wrote `post_correlation:{postId}` for it).
// Used by /on-mod-action to skip self-reference bumps.
async function checkIsModpilotPost(targetId: string): Promise<boolean> {
  if (!targetId.startsWith('t3_')) return false;
  try {
    const v = await redis.get(`post_correlation:${targetId}`);
    return !!v;
  } catch {
    return false;
  }
}

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('modpilot.install', { subreddit: input.subreddit?.name, id: input.subreddit?.id });
  await runOnboarding({
    subredditId: input.subreddit?.id,
    subredditName: input.subreddit?.name,
    isFreshInstall: true,
  });
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

async function runOnboarding(args: {
  subredditId: string | undefined;
  subredditName: string | undefined;
  isFreshInstall: boolean;
}): Promise<void> {
  // Only seed default profile on a TRUE fresh install — never on upgrade.
  // Upgrade calls used to call ensureSubredditProfile() too, which writes
  // empty defaults if the hash reads empty, silently clobbering the mod's
  // configured rules whenever Redis returned empty for any reason.
  if (args.isFreshInstall && args.subredditId) {
    try {
      const { ensureSubredditProfile } = await import('../engine/store/subreddit');
      await ensureSubredditProfile(args.subredditId);
    } catch (err) {
      console.warn('modpilot.install.profile_seed_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!args.subredditId || !args.subredditName) return;

  const { redis, reddit } = await import('@devvit/web/server');
  const welcomeKey = `sub:${args.subredditId}:welcome_sent`;
  const already = await redis.get(welcomeKey).catch(() => null);
  if (already) {
    console.log('modpilot.install.welcome_skip', { subreddit: args.subredditName });
    return;
  }

  try {
    await reddit.modMail.createConversation({
      subredditName: args.subredditName,
      subject: '👋 ModPilot is installed — finish setup in 2 minutes',
      body: ONBOARDING_MODMAIL,
      isAuthorHidden: true,
    });
    await redis.set(welcomeKey, new Date().toISOString());
    console.log('modpilot.install.modmail_sent', { subreddit: args.subredditName });
  } catch (err) {
    console.warn('modpilot.install.modmail_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

const ONBOARDING_MODMAIL = [
  "Welcome to ModPilot — context-aware moderation for Reddit.",
  "",
  "ModPilot investigates reports by running 4 lookups (rule match, report velocity, user history, prior actions) and asks Gemini 2.5 Pro to produce a recommendation with cited evidence. Every action requires your click — we never act on our own.",
  "",
  "▶ Two minutes of setup:",
  "1. Open this subreddit's mod tools → menu (kebab/⋯ icon) → choose \"ModPilot: Configure policy\".",
  "2. Pick a moderation posture: Strict, Balanced, or Lenient.",
  "3. Paste your subreddit's rules into the rules field — ModPilot uses them as context on every investigation, and the Reasoner will cite them by name in its recommendations.",
  "4. (Optional) Set a region/cultural context and an investigation-depth override.",
  "",
  "▶ Using it:",
  "On any reported post or comment, the menu shows \"Investigate with ModPilot\". One click opens a verdict view with the recommendation, confidence, and evidence trail. You decide whether to Remove/Approve/Lock/Escalate from there.",
  "",
  "▶ Watch your stats:",
  "Subreddit-level menu → \"ModPilot: Stats\" gives a running tally of investigations, alignment rate, and cost.",
  "",
  "Honest defaults until you configure: Balanced posture, no custom rules, auto-tier. The investigation still works — it'll just have less subreddit-specific context to weigh.",
].join('\n');

triggers.post('/on-app-upgrade', async (c) => {
  // Devvit fires onAppUpgrade — not onAppInstall — on a fresh subreddit if
  // the same account has installed this app on any other sub before. Route
  // upgrade through the same onboarding helper; the per-subreddit
  // `welcome_sent` flag prevents spam on real version upgrades.
  let subredditName: string | undefined;
  let subredditId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      subreddit?: { name?: string; id?: string };
    };
    subredditName = body.subreddit?.name;
    subredditId = body.subreddit?.id;
  } catch {
    // payload not JSON; skip silently
  }
  console.log('modpilot.upgrade', { subreddit: subredditName, id: subredditId });
  // isFreshInstall: false — do NOT touch the profile on upgrade.
  await runOnboarding({ subredditId, subredditName, isFreshInstall: false });
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
    subreddit?: { id?: string; name?: string };
    targetPost?: { id?: string; authorId?: string };
    targetComment?: { id?: string; authorId?: string };
  };
  console.log('modpilot.mod_action', JSON.stringify(body, null, 2));

  // Feed mod actions back into user_memory so the next investigation's
  // user_history tool sees accumulating history. Without this, even live
  // removals don't update the per-author hash and the engine keeps treating
  // every author as 'new'.
  const mapped = REDDIT_ACTION_MAP[body.action ?? ''];
  const targetId = body.targetPost?.id || body.targetComment?.id;
  const authorId = body.targetPost?.authorId || body.targetComment?.authorId;
  const subId = body.subreddit?.id;

  if (mapped && authorId && subId && targetId) {
    // Skip self-references: if this targetId is one of our own custom
    // posts (created by submitVerdictPost), the author is the ModPilot app
    // account, not the original Reddit author. Bumping here would pollute
    // memory with violations against ourselves.
    const isModpilotPost = await checkIsModpilotPost(targetId);
    if (isModpilotPost) {
      console.log('modpilot.user_memory.skip_self', {
        sub_id: subId,
        target_id: targetId,
        action: mapped,
      });
    } else {
      try {
        const { bumpViolation, bumpApproval } = await import('../engine/store/userMemory');
        if (mapped === 'REMOVE') {
          await bumpViolation(subId, authorId);
        } else if (mapped === 'APPROVE') {
          await bumpApproval(subId, authorId);
        }
        console.log('modpilot.user_memory.bumped', {
          sub_id: subId,
          author_id: authorId,
          action: mapped,
        });
      } catch (err) {
        console.error('modpilot.user_memory.bump_failed', err);
      }
    }
  }

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
