#!/bin/bash
# Install atomic-opencode config into ~/.config/opencode/
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.config/opencode"

mkdir -p "$TARGET/agents" "$TARGET/plugins" "$TARGET/skills"

# Symlink each file
ln -sf "$SCRIPT_DIR/agents/atomic.md" "$TARGET/agents/atomic.md"
ln -sf "$SCRIPT_DIR/plugins/atomic-hooks.ts" "$TARGET/plugins/atomic-hooks.ts"
ln -sf "$SCRIPT_DIR/opencode.json" "$TARGET/opencode.json"
ln -sf "$SCRIPT_DIR/package.json" "$TARGET/package.json"

# Skills need the directory structure
for skill in skills/*/; do
  name=$(basename "$skill")
  mkdir -p "$TARGET/skills/$name"
  ln -sf "$SCRIPT_DIR/$skill/SKILL.md" "$TARGET/skills/$name/SKILL.md"
done

# Install dependencies
cd "$TARGET" && bun install --no-progress 2>/dev/null

echo "✓ Installed to $TARGET"
echo "  Edit files in $SCRIPT_DIR — changes apply immediately via symlinks."
