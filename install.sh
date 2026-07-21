#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.config/opencode"

mkdir -p "$TARGET/agents" "$TARGET/plugins"

ln -sf "$SCRIPT_DIR/agents/atomic.md" "$TARGET/agents/atomic.md"
ln -sf "$SCRIPT_DIR/plugins/atomic-hooks.ts" "$TARGET/plugins/atomic-hooks.ts"
ln -sf "$SCRIPT_DIR/opencode.json" "$TARGET/opencode.json"
ln -sf "$SCRIPT_DIR/package.json" "$TARGET/package.json"
# install.js must sit next to package.json: bun install below runs the
# package's `postinstall` ("node install.js --silent") from $TARGET. Without
# this link a fresh install fails with MODULE_NOT_FOUND (node resolves the
# symlink to this checkout, so __dirname stays correct and the re-run is
# idempotent — install.js only replaces its own symlinks).
ln -sf "$SCRIPT_DIR/install.js" "$TARGET/install.js"

# Skills — explicit, no globs
for name in atomic-vault atomic-vcs code-intelligence; do
  mkdir -p "$TARGET/skills/$name"
  ln -sf "$SCRIPT_DIR/skills/$name/SKILL.md" "$TARGET/skills/$name/SKILL.md"
done

cd "$TARGET" && bun install --no-progress 2>/dev/null

cat <<EOF

────────────────────────────────────────────────────────────
✓ Installed atomic-opencode
────────────────────────────────────────────────────────────

What was installed:
  • Agent      atomic.md
               → ${TARGET}/agents/atomic.md
  • Plugin     atomic-hooks.ts (session lifecycle, turn recording)
               → ${TARGET}/plugins/atomic-hooks.ts
  • Config     opencode.json, package.json
               → ${TARGET}/
  • Skills     atomic-vault, atomic-vcs, code-intelligence
               → ${TARGET}/skills/  (@atomic-vault, @atomic-vcs, @code-intelligence)

Symlinks point back into this checkout:
  ${SCRIPT_DIR}
Keep this directory in place; moving or deleting it breaks the links.

Manual steps to finish:
  1. Restart OpenCode if it is currently running, so it picks up the
     plugin, agent, and skills.
  2. Ensure the project is an Atomic repo (one-time):
       cd /path/to/your/project && atomic init
  3. Start OpenCode in that project — press Tab to switch to the Atomic
     agent. The plugin records each turn automatically.

Verify:
  • Skills: ls ${TARGET}/skills/
  • Agent:  ls ${TARGET}/agents/atomic.md
  • Plugin: ls ${TARGET}/plugins/atomic-hooks.ts
────────────────────────────────────────────────────────────
EOF
