// Design tokens — single source of truth for every color, spacing value, and
// type face in the ModPilot UI. Per docs/09-UX.md §2 and ADR-0005:
//
//   • Risk colors are the *canonical* hex values from docs/09-UX.md §2.
//   • Surface / ink / accent palette is ported from mockups/moderator-ui.html
//     (Forensic Dossier aesthetic — paper-cream, not white).
//   • UI components NEVER inline hex values. CI grep enforces this (see
//     scripts/check-no-inline-hex.sh).

export const color = {
  // === Risk tiers — canonical, per docs/09-UX.md §2 ===
  riskHigh: '#D93025',
  riskMedium: '#F9AB00',
  riskLow: '#1E8E3E',

  // === Muted risk variants (mockup aesthetic — for badges/pills on paper surface) ===
  riskHighMuted: '#C0392B',
  riskHighSoft: '#FBEAE7',
  riskMediumMuted: '#C8851C',
  riskMediumSoft: '#FAF1E0',
  riskLowMuted: '#2F7A3C',
  riskLowSoft: '#E7F2E8',

  // === Surfaces ===
  paper: '#F5F1E8',        // primary background — paper-cream
  paperDeep: '#EDE7D8',    // tiles, sticky verdict block
  surface: '#FBF8F0',      // cards
  surfaceAlt: '#F1ECDE',   // evidence chips, hover

  // === Ink (text) ===
  ink: '#1B1812',
  inkMid: '#4A4338',
  inkSoft: '#7A7060',
  inkFade: '#A89D86',

  // === Rules (borders) ===
  rule: '#2A241A',
  ruleSoft: '#C9BFA8',
  ruleHair: 'rgba(42, 36, 26, 0.15)',

  // === Accents ===
  accent: '#1B1812',
  accentWarm: '#8B5A2B',
  leaf: '#4A7A4F',          // the "I'm unsure" / cold-start indicator
} as const;

export const spacing = {
  xs: '4px',
  s: '8px',
  m: '16px',
  l: '24px',
  xl: '32px',
  xxl: '48px',
} as const;

export const radius = {
  s: '2px',
  m: '4px',
  l: '8px',
} as const;

export const font = {
  display: '"Fraunces", "Times New Roman", serif',
  body: '"Geist", -apple-system, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", monospace',
} as const;

export const fontSize = {
  xs: '10px',
  s: '12px',
  base: '14px',
  m: '16px',
  l: '20px',
  xl: '28px',
  xxl: '44px',
  display: '68px',
} as const;

export const letterSpacing = {
  tight: '-0.02em',
  body: '0',
  caps: '0.14em',
  capsWide: '0.20em',
} as const;

// Strongly-typed token namespaces — import from this file, never inline values.
export type Color = keyof typeof color;
export type Spacing = keyof typeof spacing;
export type Radius = keyof typeof radius;
export type Font = keyof typeof font;
