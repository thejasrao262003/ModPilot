// Resolve the Gemini API key for a given subreddit.
//
// Order of precedence:
//   1. Per-subreddit key set by the mod team via "Configure policy"
//      (stored in `sub:{sub_id}:profile.gemini_api_key`).
//   2. The build-time default in geminiConfig.local.ts (developer's key).
//
// This lets each installing subreddit point at their own Google billing
// account, while keeping the demo path working when a sub hasn't configured
// a key yet.

import { ensureSubredditProfile } from '../store/subreddit';
import { GEMINI_API_KEY as DEFAULT_KEY } from '../../config/geminiConfig.local';

export type KeyResolution = {
  key: string;
  source: 'subreddit' | 'app_default' | 'missing';
};

export async function resolveGeminiKey(subId: string): Promise<KeyResolution> {
  if (!subId) {
    return { key: DEFAULT_KEY, source: DEFAULT_KEY ? 'app_default' : 'missing' };
  }
  try {
    const profile = await ensureSubredditProfile(subId);
    if (profile.geminiApiKey && profile.geminiApiKey.startsWith('AIza')) {
      return { key: profile.geminiApiKey, source: 'subreddit' };
    }
  } catch {
    // fall through to default
  }
  return { key: DEFAULT_KEY, source: DEFAULT_KEY ? 'app_default' : 'missing' };
}
