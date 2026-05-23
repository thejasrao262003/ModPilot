// Template. Copy to `geminiConfig.local.ts` and fill in the real key.
// `geminiConfig.local.ts` is gitignored.
//
// Devvit Web 0.12.x does NOT bind the AppSettings.ValidateAppForm gRPC handler
// when settings are declared in devvit.json, and the Developer Portal has no
// settings tab — so `npx devvit settings set` fails and the dashboard can't
// set values either. This file is the workaround. See ADR-0007 + the deploy
// notes in CLAUDE.md.

export const GEMINI_API_KEY = '';
