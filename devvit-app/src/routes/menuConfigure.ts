// "ModPilot: Configure policy" — subreddit-level mod menu item.
// Lets a moderator set the rules/personality/region/tier_override that the
// Reasoner uses as context on every investigation. Persists to the same
// `sub:{sub_id}:profile` hash that engine/store/subreddit.ts reads.

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, redis } from '@devvit/web/server';

import { subProfileKey } from '../engine/store/keys';
import { ensureSubredditProfile } from '../engine/store/subreddit';

export const menuConfigure = new Hono();

const PERSONALITIES = ['strict', 'balanced', 'lenient'] as const;
const TIER_OVERRIDES = ['auto', 'fast', 'standard', 'deep'] as const;

menuConfigure.post('/open', async (c) => {
  const subId = context.subredditId;
  if (!subId) {
    return c.json<UiResponse>(
      { showToast: { text: 'No subreddit context available.' } },
      200,
    );
  }

  const profile = await ensureSubredditProfile(subId);

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'configurePolicy',
        form: {
          title: '⚙ Configure ModPilot for this subreddit',
          acceptLabel: 'Save',
          cancelLabel: 'Cancel',
          fields: [
            {
              name: 'personality',
              label: 'Moderation posture',
              type: 'select',
              required: true,
              options: [
                { label: 'Strict — lean toward removal', value: 'strict' },
                { label: 'Balanced — weigh evidence fairly (default)', value: 'balanced' },
                { label: 'Lenient — give benefit of the doubt', value: 'lenient' },
              ],
              defaultValue: [profile.personality],
              helpText:
                'Shifts the Reasoner\'s threshold + the Strategy Selector\'s DEEP triggers.',
            },
            {
              name: 'rules',
              label: 'Subreddit rules',
              type: 'paragraph',
              defaultValue: profile.rules ?? '',
              helpText:
                'Full rule text the Reasoner can cite. e.g. "Rule 1: No personal attacks. Rule 2: ..."',
            },
            {
              name: 'region',
              label: 'Region / cultural context',
              type: 'string',
              defaultValue: profile.region ?? 'Global',
              helpText:
                'Surface region-specific norms (e.g. "India", "Brazil") so the Reasoner can weigh culturally-specific language. Use "Global" if no preference.',
            },
            {
              name: 'tier_override',
              label: 'Investigation depth override',
              type: 'select',
              required: true,
              options: [
                { label: 'Auto — let the Strategy Selector decide (default)', value: 'auto' },
                { label: 'Always FAST — 2 tools, ~1s', value: 'fast' },
                { label: 'Always STANDARD — 4 tools, ~3s', value: 'standard' },
                { label: 'Always DEEP — 5+ tools, ~6s', value: 'deep' },
              ],
              defaultValue: [profile.tierOverride],
              helpText:
                'Force a tier for every investigation. Cold-start ignores FAST overrides.',
            },
          ],
        },
      },
    },
    200,
  );
});

// Form submit handler — wired in devvit.json under `forms.configurePolicy`.
menuConfigure.post('/submit', async (c) => {
  const subId = context.subredditId;
  if (!subId) {
    return c.json<UiResponse>(
      { showToast: { text: 'No subreddit context available.' } },
      200,
    );
  }

  const values = (await c.req.json()) as {
    personality?: string | string[];
    rules?: string;
    region?: string;
    tier_override?: string | string[];
  };

  const personality = pickFirst(values.personality, PERSONALITIES, 'balanced');
  const tierOverride = pickFirst(values.tier_override, TIER_OVERRIDES, 'auto');
  const rules = (values.rules ?? '').trim().slice(0, 4000);
  const region = (values.region ?? 'Global').trim().slice(0, 80) || 'Global';

  await redis.hSet(subProfileKey(subId), {
    personality,
    region,
    rules,
    tier_override: tierOverride,
  });

  console.log('modpilot.policy.updated', {
    sub_id: subId,
    personality,
    region,
    tier_override: tierOverride,
    rules_chars: rules.length,
  });

  return c.json<UiResponse>(
    {
      showToast: {
        text: `Saved · ${personality} · tier=${tierOverride} · ${rules.length} chars of rules`,
      },
    },
    200,
  );
});

function pickFirst<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return allowed.includes(v as T) ? (v as T) : fallback;
}
