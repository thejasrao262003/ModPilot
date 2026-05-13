// ModPilot menu actions. Spec: docs/09-UX.md §9, docs/Specs.md §6.4.
// Stubs only; real handlers land in U-4.4 / U-4.5 / U-4.7 + S-1.4 for verdict rendering.

import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';

export const menu = new Hono();

// U-4.4: "Investigate with ModPilot" — forces investigation on the selected target.
menu.post('/investigate-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.investigate_comment', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Investigation queued — TODO(U-4.4)' } }, 200);
});

menu.post('/investigate-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log('modpilot.menu.investigate_post', { target: request.targetId });
  return c.json<UiResponse>({ showToast: { text: 'Investigation queued — TODO(U-4.4)' } }, 200);
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
