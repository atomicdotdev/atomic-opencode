#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.config/opencode"

mkdir -p "$TARGET/agents" "$TARGET/plugins"

ln -sf "$SCRIPT_DIR/agents/atomic.md" "$TARGET/agents/atomic.md"
ln -sf "$SCRIPT_DIR/plugins/atomic-hooks.ts" "$TARGET/plugins/atomic-hooks.ts"
ln -sf "$SCRIPT_DIR/opencode.json" "$TARGET/opencode.json"
ln -sf "$SCRIPT_DIR/package.json" "$TARGET/package.json"

# Skills — explicit, no globs
for name in atomic-vault code-intelligence; do
  mkdir -p "$TARGET/skills/$name"
  ln -sf "$SCRIPT_DIR/skills/$name/SKILL.md" "$TARGET/skills/$name/SKILL.md"
done

cd "$TARGET" && bun install --no-progress 2>/dev/null

echo "✓ Installed to $TARGET"
