/* eslint-disable */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  settings: {
    'import/resolver': {
      typescript: { project: './tsconfig.json' },
    },
  },
  rules: {
    // === Layer purity — invariant I-8 ===
    // devvit-app/ must never import from engine/ or eval/
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['**/engine/**', '../engine/**', '../../engine/**'], message: 'Layer violation: devvit-app cannot import from engine/. See docs/Specs.md §4.2.' },
        { group: ['**/eval/**', '../eval/**', '../../eval/**'], message: 'Layer violation: devvit-app cannot import from eval/. See docs/Specs.md §4.2.' },
      ],
    }],

    // === No deep imports across internal layers ===
    // Triggers must go through services/, not domain/types.ts directly
    'import/no-cycle': ['error', { maxDepth: 10 }],

    // === Code quality ===
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }],

    // === Terminology hygiene (warn; full enforcement via CI grep) ===
    // Banned terms in user-facing strings checked by a separate CI step.
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.config.cjs', '*.config.js'],
};
