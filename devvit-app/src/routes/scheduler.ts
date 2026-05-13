// ModPilot scheduled tasks. Spec: docs/Specs.md §6.3, docs/03-Devvit.md.
// Stubs only; real implementations land in U-4.2 (priority rollup) and
// I-3.5 / X-2 (nightly feedback batch).

import { Hono } from 'hono';

export const scheduler = new Hono();

// U-4.2: every 5 min, re-sort pending queue by priority score.
scheduler.post('/priority-rollup', async (c) => {
  console.log('modpilot.scheduler.priority_rollup', { at: new Date().toISOString() });
  // TODO(U-4.2): recompute priority score for every pending report
  return c.json({ status: 'success' }, 200);
});

// Nightly: aggregate ModAction feedback into personality / calibration weights.
scheduler.post('/feedback-batch', async (c) => {
  console.log('modpilot.scheduler.feedback_batch', { at: new Date().toISOString() });
  // TODO(I-3.6 + Calibrator): re-train subreddit personality weights
  return c.json({ status: 'success' }, 200);
});
