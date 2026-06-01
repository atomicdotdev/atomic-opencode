# atomic-opencode

[Atomic VCS](https://atomic.dev) integration for [OpenCode](https://opencode.ai).

Automatic turn recording with AI provenance, intent tracking, and knowledge graph skills.

## What it does

- **1 session = 1 view** — a draft view is created automatically when you start OpenCode
- **Every turn records with provenance** — model, vendor, session, turn number, timing
- **Tool executions tracked** — reads, edits, bash calls captured in a causal decision graph
- **Intent workflow** — agent prompt guides problem-first development with vault intents
- **Skills on demand** — `@atomic-vault`, `@atomic-vcs`, and `@code-intelligence` loaded when needed

## Install

### From npm

Add to your global OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["atomic-opencode"]
}
```

OpenCode installs it automatically on next startup.

Then run the setup to link the agent prompt and skills:

```bash
npx atomic-opencode
```

### From source (development)

```bash
git clone https://github.com/atomicdotdev/atomic-opencode
cd atomic-opencode
./install.sh
```

This symlinks everything into `~/.config/opencode/`. Edit files in the repo — changes apply immediately (restart OpenCode for plugin changes).

## Prerequisites

- [Atomic VCS](https://atomic.dev) installed and on your PATH (`atomic --version`)
- A project with an `.atomic/` repository (`atomic init`)
- [OpenCode](https://opencode.ai) installed

## Usage

```bash
cd my-project
atomic init              # if not already an atomic repo
opencode                 # start OpenCode — press Tab to switch to Atomic agent
```

The Atomic agent:

1. Creates an intent for each prompt (`atomic vault intent create`)
2. Reframes your request as a problem statement with success criteria
3. Writes the plan into the intent file before coding
4. Executes the tasks
5. Hooks automatically record with provenance when the turn ends

You never need to run `atomic add` or `atomic record` — the hooks handle it.

## Viewing provenance

```bash
# Show the causal decision graph (goals → tool calls → patch)
atomic change -p <hash>

# Show inline AI attestation (model, tokens, cost)
atomic change -a <hash>

# Show session-level attestations
atomic agent attest
```

## What's in the package

| File | Purpose |
|------|---------|
| `plugins/atomic-hooks.ts` | OpenCode plugin — session lifecycle, turn recording, tool tracking |
| `agents/atomic.md` | Agent prompt — intent-per-turn workflow |
| `skills/atomic-vault/SKILL.md` | Vault reference (goals, intents, memory) |
| `skills/atomic-vcs/SKILL.md` | Read-only VCS inspection (status, log, change, diff) |
| `skills/code-intelligence/SKILL.md` | Knowledge graph query patterns |
| `opencode.json` | Default permissions |
| `install.js` | Links agent + skills into `~/.config/opencode/` |
| `install.sh` | Development install (symlinks from local checkout) |

## Uninstall

```bash
npx atomic-opencode --uninstall
```

Removes symlinks from `~/.config/opencode/`. Your OpenCode config and other plugins are not affected.

## Architecture

```
OpenCode session start
  │
  ├── Plugin fires session-start → Rust creates haikunator-named draft view
  │
  ├── User sends prompt
  │   ├── Plugin fires user-prompt → Rust saves prompt + model on session
  │   ├── Agent works (edits, bash, reads)
  │   │   ├── Plugin fires before-tool → Rust tracks timing
  │   │   └── Plugin fires after-tool → Rust appends to provenance graph
  │   └── Turn ends
  │       └── Plugin fires stop → Rust adds files, records change with provenance
  │
  ├── User sends another prompt → repeat
  │
  └── Session ends
      └── Plugin fires session-end → Rust creates attestation
```

## License

Apache-2.0 — same as [Atomic VCS](https://github.com/atomicdotdev/atomic).