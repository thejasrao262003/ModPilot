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
  "ModPilot investigates reports by running the lookups an experienced moderator does manually (rule match, thread context, author history, prior actions) and produces a recommendation with cited evidence. Every action requires your click — we never act on our own.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "STEP 1 — Open the policy form (where to click)",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "1. Go to your subreddit's home page (the main r/yoursubreddit page, not Mod Tools).",
  "2. Look for the three-dot menu (⋯) in the subreddit's top-right header bar — same row as the community icon and the Joined / Created button.",
  "3. Click it. A dropdown will appear.",
  "4. Choose \"ModPilot: Configure policy\".",
  "",
  "(If you don't see the dropdown item, hard-refresh the page — Reddit caches the community menu for a few minutes after install.)",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "STEP 2 — Fill in the form",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "The form has five fields. Here's what each one does:",
  "",
  "1. MODERATION POSTURE  (required)",
  "   Pick one of: Strict / Balanced / Lenient.",
  "   This shifts how ModPilot weighs borderline content. Strict subs see ModPilot lean toward removal once a violation is detected; lenient subs see it give the benefit of the doubt. It never changes whether ModPilot *finds* a violation — only how it responds to one. Balanced is the default.",
  "",
  "2. SUBREDDIT RULES  (recommended — leave blank if you have none)",
  "   Paste your subreddit's rule list as plain text. Example:",
  "     Rule 1: No personal attacks.",
  "     Rule 2: No off-topic posts.",
  "     Rule 3: Respect for players is required.",
  "   ModPilot's Reasoner reads these on every investigation and cites them by number in the recommendation. Without rules, the engine still works but has less subreddit-specific context — it falls back to general civility judgment.",
  "",
  "3. REGION / CULTURAL CONTEXT  (optional)",
  "   Short string (e.g. \"India\", \"Australia, England\", \"Global\"). Surfaces region-specific norms so the Reasoner can weigh culturally-specific language. Use \"Global\" if you have no preference.",
  "",
  "4. INVESTIGATION DEPTH OVERRIDE  (optional)",
  "   Pick one of:",
  "     - Auto (default) — Strategy Selector picks Fast / Standard / Deep per report",
  "     - Always FAST — 2 tools, ~1 second per investigation, $0.003",
  "     - Always STANDARD — 4 tools, ~3 seconds per investigation, $0.012",
  "     - Always DEEP — 5+ tools, ~6 seconds per investigation, $0.030",
  "   Most subreddits should leave this on Auto.",
  "",
  "5. GEMINI API KEY  (optional but recommended for production use)",
  "   Paste your own Google AI Studio API key (starts with \"AIza\"). Get one free at https://aistudio.google.com/app/apikey. When set, all investigations bill to your Google account. When blank, ModPilot uses the app default — fine for trying it out, but please set your own key for sustained use.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "STEP 3 — Run your first investigation",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "On any reported post or comment, click the three-dot menu (⋯) on the post itself — you'll see \"Investigate with ModPilot\". One click opens a verdict view in your mod queue with:",
  "  • the recommendation (Remove / Approve / Lock / Escalate / Review)",
  "  • a confidence score with honest uncertainty if the evidence is weak",
  "  • the evidence trail (every tool that ran + what it found)",
  "  • a draft moderator reply (optional, generated on demand)",
  "You decide whether to take action.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "Tracking your stats",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "Same three-dot menu on the subreddit home page → \"ModPilot: Stats\" gives a running dashboard of: investigations run, alignment rate between ModPilot's recommendations and your team's actual decisions, total cost, and a carousel of recent actioned cases with their reasoning.",
  "",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "Honest defaults",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "",
  "Until you configure the form, ModPilot uses: Balanced posture, no custom rules, Global region, Auto tier, app-default Gemini key. The investigation still works — it'll just have less subreddit-specific context to weigh.",
  "",
  "Questions or issues? thejasrao262003@gmail.com",
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
// Automated moderator accounts. Removals by these actors are NOT human
// judgments and should not count toward a user's violation history:
//   • AutoModerator — subreddit-configured regex rules; high false-positive
//     rate. A mod can review and approve afterwards if it was wrong.
//   • reddit — site-wide spam filter / safety classifier. Also rules-based,
//     not a human judgment.
//   • anti-evil-operations — Reddit admin team's automated tooling.
// Mods can still approve content these flagged; if a real mod confirms the
// removal, THAT click fires its own onModAction with the mod's name and
// counts normally.
const AUTOMATED_MODERATORS: ReadonlySet<string> = new Set([
  'AutoModerator',
  'reddit',
  'anti-evil-operations',
]);

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
    // Skip automated actors: AutoModerator / Reddit spam filter / anti-evil-ops
    // are rules-based, not human judgments. Counting their removals as
    // "violations" pollutes user_memory and makes future investigations
    // anchor on automated false-positives.
    const actorName = body.moderator?.name ?? '';
    const isAutomatedActor = AUTOMATED_MODERATORS.has(actorName);

    if (isModpilotPost) {
      console.log('modpilot.user_memory.skip_self', {
        sub_id: subId,
        target_id: targetId,
        action: mapped,
      });
    } else if (isAutomatedActor) {
      console.log('modpilot.user_memory.skip_automated', {
        sub_id: subId,
        target_id: targetId,
        action: mapped,
        actor: actorName,
        reason: 'automated removal — not a human judgment',
      });
      // We still record the resolution row so the verdict UI can show
      // "✓ Resolved · auto-removed by AutoModerator" if the mod investigates
      // this target later. We just don't count it toward violations.
      try {
        const { recordResolution } = await import('../services/dedup');
        await recordResolution(targetId, {
          correlationId: '',
          modAction: mapped,
          moderatorName: actorName,
          rawAction: body.action ?? '',
          source: 'reddit_native',
        });
      } catch {
        // best-effort
      }
    } else {
      // Dedup: /api/feedback bumps inline when a mod uses ModPilot's UI.
      // If we see a resolution row for this target, the bump already
      // happened — don't double-count. Native Reddit-UI removals have no
      // resolution row, so they still bump here.
      const alreadyResolved = await redis
        .hGetAll(`resolution:${targetId}`)
        .then((row) => !!row?.correlationId || !!row?.correlation_id)
        .catch(() => false);
      if (alreadyResolved) {
        console.log('modpilot.user_memory.skip_dedup', {
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
            source: 'native_trigger',
          });
        } catch (err) {
          console.error('modpilot.user_memory.bump_failed', err);
        }
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
