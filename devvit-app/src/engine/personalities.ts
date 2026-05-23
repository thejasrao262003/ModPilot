// Personality presets — mirrors engine/personalities/presets.py.

import type { Personality } from './types';

export type PersonalityPreset = {
  name: Personality;
  promptPhrasing: string;
};

const STRICT: PersonalityPreset = {
  name: 'strict',
  promptPhrasing:
    'If the evidence suggests a possible violation, lean toward recommending action. ' +
    'This subreddit has chosen a strict moderation posture.',
};

const BALANCED: PersonalityPreset = {
  name: 'balanced',
  promptPhrasing:
    'Recommend action when evidence supports it; recommend no action when evidence is mixed. ' +
    'Balance protective and lenient considerations.',
};

const LENIENT: PersonalityPreset = {
  name: 'lenient',
  promptPhrasing:
    'Only recommend action when evidence clearly supports it. ' +
    'Default to no action when evidence is ambiguous. ' +
    'This subreddit values openness and tolerates more discussion.',
};

const PRESETS: Record<Personality, PersonalityPreset> = {
  strict: STRICT,
  balanced: BALANCED,
  lenient: LENIENT,
};

export function getPreset(name: string): PersonalityPreset {
  if (name === 'strict' || name === 'balanced' || name === 'lenient') {
    return PRESETS[name];
  }
  return BALANCED;
}
