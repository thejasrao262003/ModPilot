#!/usr/bin/env bash
# Enforces docs/Glossary.md §1 — banned terminology in user-facing surfaces.
# Runs in CI; also runnable locally: ./scripts/check-banned-terms.sh
#
# Exits non-zero if a banned term appears in:
#   - devvit-app/src/**/*.{ts,tsx}     (UI + copy)
#   - engine/llm/prompts/**/*.py       (LLM prompts seen by Reasoner)
#
# Bypass with a `// glossary-ok: <reason>` end-of-line comment if a banned
# word genuinely cannot be avoided (rare; surface in code review).

set -euo pipefail

# Word-boundary patterns. Single regex with alternations for grep -E.
# Order matters only for matching — egrep returns first match per line.
BANNED='\b(reinforcement learning|action space|observation space|value function|trajectory|RL|policy|reward|training|episode|agent)\b'

# Paths to scan (relative to repo root).
PATHS=(
  "devvit-app/src"
  "engine/llm/prompts"
)

# Files to ignore entirely (lookup tables that intentionally reference the words).
IGNORE_FILES=(
  "devvit-app/src/ui/glossary-table.ts"   # if/when this exists
)

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

hits=0
for path in "${PATHS[@]}"; do
  [ -d "$path" ] || continue
  # `-I` skips binaries; `-r` recursive; `-n` line numbers; `-E` extended regex.
  while IFS= read -r line; do
    file="$(printf '%s' "$line" | cut -d: -f1)"
    # Skip explicitly ignored files.
    skip=0
    for ig in "${IGNORE_FILES[@]}"; do
      [ "$file" = "$ig" ] && skip=1 && break
    done
    [ "$skip" -eq 1 ] && continue
    # Skip lines with the glossary-ok escape hatch.
    if printf '%s' "$line" | grep -q "glossary-ok:"; then continue; fi
    # Skip comments referencing docs/Glossary.md itself.
    if printf '%s' "$line" | grep -qE "(docs/Glossary\.md|see Glossary)"; then continue; fi
    echo "✗ Banned term: $line"
    hits=$((hits + 1))
  done < <(grep -rIniE \
              --include='*.ts' --include='*.tsx' --include='*.py' \
              --include='*.js' --include='*.html' --include='*.css' \
              "$BANNED" "$path" || true)
done

if [ "$hits" -gt 0 ]; then
  echo ""
  echo "✗ Found $hits banned-term occurrence(s). See docs/Glossary.md."
  exit 1
fi

echo "✓ No banned terms in user-facing surfaces."
