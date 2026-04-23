# atomic-opencode

OpenCode global config for Atomic VCS integration.

## Install

```bash
./install.sh
```

Symlinks everything into `~/.config/opencode/`. Edit files here — changes apply immediately.

## What's in here

| File | Purpose |
|------|---------|
| `agents/atomic.md` | Agent prompt — intent-per-turn workflow |
| `plugins/atomic-hooks.ts` | Session hooks — view creation, turn recording with provenance |
| `skills/atomic-vault/SKILL.md` | Vault reference (on-demand) |
| `skills/code-intelligence/SKILL.md` | KG reference (on-demand) |
| `opencode.json` | Global permissions |
| `package.json` | Plugin dependencies (haikunator) |

## Architecture

- **1 session = 1 view** — created by Rust hook handler on `session-start`
- **Each turn records automatically** — `session.idle` fires `stop` hook → Rust records with provenance
- **No custom tools** — agent uses `bash` with `atomic` CLI
- **No project-level `.opencode/`** — everything is global
