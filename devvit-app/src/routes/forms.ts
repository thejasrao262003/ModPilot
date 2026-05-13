// ModPilot form submission handlers. Spec: docs/09-UX.md §9.3.
// Stubs only; real implementations land in U-4.6 (wipe memory).

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';

export const forms = new Hono();

// U-4.6: "Wipe this user's memory" soft-delete confirmation.
forms.post('/wipe-memory-submit', async (c) => {
  const values = (await c.req.json()) as { userId?: string };
  console.log('modpilot.form.wipe_memory', { user: values.userId });
  // TODO(U-4.6): soft-delete user_memory row, audit-log the wipe
  return c.json<UiResponse>(
    { showToast: { text: "User memory wiped — TODO(U-4.6)" } },
    200,
  );
});
