// "ModPilot: Stats" — subreddit-level dashboard. Reads counters maintained
// by pipeline.ts (per-investigation) and /api/feedback (per-mod-action) and
// renders them in a read-only form.

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';

import { readStats } from '../engine/store/stats';

export const menuStats = new Hono();

menuStats.post('/open', async (c) => {
  const subId = context.subredditId;
  if (!subId) {
    return c.json<UiResponse>(
      { showToast: { text: 'No subreddit context available.' } },
      200,
    );
  }

  const s = await readStats(subId);

  if (s.investigationsTotal === 0) {
    return c.json<UiResponse>(
      {
        showForm: {
          name: 'wipeMemory',
          form: {
            title: '📊 ModPilot stats',
            acceptLabel: 'Close',
            cancelLabel: 'Close',
            fields: [
              {
                name: 'empty',
                label: 'Status',
                type: 'string',
                defaultValue: 'No investigations yet. Try "Investigate with ModPilot" on a post.',
                disabled: true,
              },
            ],
          },
        },
      },
      200,
    );
  }

  const fields = [
    field('investigations_total', 'Investigations', String(s.investigationsTotal)),
    field(
      'avg_confidence',
      'Average calibrated confidence',
      `${(s.avgConfidence * 100).toFixed(1)}%`,
    ),
    field(
      'avg_latency',
      'Average latency',
      `${(s.avgLatencyMs / 1000).toFixed(2)}s`,
    ),
    field('total_cost', 'Total LLM cost', `$${s.totalCostUsd.toFixed(4)}`),
    field('degraded', 'Degraded verdicts', `${s.degradedTotal} (Reasoner failed twice)`),
    field('recommendation_mix', 'Recommendation mix', formatBreakdown(s.byRecommendation)),
    field('tier_mix', 'Strategy tier mix', formatBreakdown(s.byTier)),
    field(
      'alignment',
      'Alignment rate',
      s.feedbackTotal > 0
        ? `${Math.round(s.alignmentRate * 100)}% (${s.feedbackAligned}/${s.feedbackTotal})`
        : 'no feedback yet',
    ),
    field('mod_action_mix', 'Mod actions taken', formatBreakdown(s.byModAction)),
  ];

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'wipeMemory', // reusing the registered form name; we only show fields
        form: {
          title: '📊 ModPilot stats',
          acceptLabel: 'Close',
          cancelLabel: 'Close',
          fields,
        },
      },
    },
    200,
  );
});

function field(name: string, label: string, value: string): {
  name: string;
  label: string;
  type: 'string';
  defaultValue: string;
  disabled: true;
} {
  return { name, label, type: 'string', defaultValue: value, disabled: true };
}

function formatBreakdown(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
