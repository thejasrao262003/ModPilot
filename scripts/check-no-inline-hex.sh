#!/usr/bin/env bash
# Enforces docs/09-UX.md §15.9 — no inline color hex literals outside tokens.ts.
# Runs in CI; also runnable locally: ./scripts/check-no-inline-hex.sh

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Hex color pattern: # followed by 3, 6, or 8 hex chars at a word boundary.
HEX='#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?\b'

# Allowed locations.
ALLOW='devvit-app/src/ui/tokens\.ts'

# Scan TypeScript sources under devvit-app/src.
hits=$(grep -rEn --include='*.ts' --include='*.tsx' "$HEX" devvit-app/src 2>/dev/null \
       | grep -v -E "$ALLOW" || true)

if [ -n "$hits" ]; then
  echo "✗ Inline hex literals found — use ui/tokens.ts instead:"
  printf '%s\n' "$hits"
  exit 1
fi

echo "✓ No inline hex literals outside tokens.ts."
