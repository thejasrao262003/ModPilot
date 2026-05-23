// Standalone Vitest config — the project's vite.config uses the Devvit
// plugin which refuses to run outside of `vite build`. Tests don't need
// any of that, so we provide a minimal Vite-less config.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
