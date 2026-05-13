import { defineConfig } from 'eslint/config';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig([
  tseslint.configs.recommended,
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx,mjs,cjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['off'],
      'no-unused-vars': ['off'],
      // === Layer purity — invariant I-8 ===
      // devvit-app/ must never import from engine/ or eval/.
      // See docs/Specs.md §4.2 and docs/adr/0001-devvit-plus-external-backend.md.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/engine/**', '../engine/**', '../../engine/**'],
              message:
                'Layer violation: devvit-app cannot import from engine/. See docs/Specs.md §4.2.',
            },
            {
              group: ['**/eval/**', '../eval/**', '../../eval/**'],
              message:
                'Layer violation: devvit-app cannot import from eval/. See docs/Specs.md §4.2.',
            },
          ],
        },
      ],
    },
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'eslint.config.js',
      '**/vite.config.ts',
      'devvit.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { js },
    extends: ['js/recommended'],
  },
]);
