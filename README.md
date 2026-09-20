# atomic-opencode

[Atomic VCS](https://atomic.dev) integration for [OpenCode](https://opencode.ai).

Automatic turn recording with AI provenance, intent tracking, and knowledge graph skills.

> **Definitive source:** this repository lives on Atomic storage at `https://atomic.atomic.storage/workspaces/oss/projects/atomic-opencode/code`. The GitHub repo is a mirror.

## What it does

- **1 session = 1 view** — a draft view is created automatically when you start OpenCode
- **Every turn records with provenance** — model, vendor, session, turn number, timing
- **Tool executions tracked** — reads, edits, bash calls captured in a causal decision graph
- **Intent workflow** — agent prompt guides problem-first development with vault intents
- **Skills on demand** — `@atomic-vault`, `@decision-record`, `@atomic-vcs`, and `@code-intelligence` loaded when needed

## Install

### Quick start

Requires the [Atomic VCS](https://atomic.dev) CLI on your PATH. Then:

```bash
atomic agent enable --agent opencode
```

The enable command syncs the package from Atomic storage and links the plugin, agent prompt, and skills into `~/.config/opencode/`. The plugin is plain TypeScript — no build step needed. Restart OpenCode after enabling.

### Updating from the file-ownership version

After installing this rollback, restart OpenCode and **start a new conversation**.
Existing conversations may have `explicit_record_files` saved in their Atomic
session. Resuming them still requires a file manifest that this rollback no
longer sends; restarting OpenCode alone does not clear that requirement.
Keep your working files and `.atomic` data. Do not delete session data or reset
unrecorded changes to work around this.

The rollback restores automatic recording of the working directory, including
existing edits and files changed by shell commands. It removes the ownership
checks that could block later commands and recording after an edit. New sessions
no longer adopt the first session's view automatically. Session event routing
and turn-start fixes remain in place.

Use one writing session at a time in a working directory. Recording can include
other pending work in that directory; this rollback does not provide safe
concurrent file attribution or repair previously lost changes.

### Development install

From a local checkout:

```bash
git clone https://github.com/atomicdotdev/atomic-opencode
cd atomic-opencode
atomic agent enable --agent opencode --from .
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

1. Reuses the assigned intent, or creates one per prompt (`atomic intent new`)
2. Reframes your request as a problem — a mandatory `:::why`, acceptance criteria, and tasks
3. Fills the intent's directives before coding
4. Executes the tasks, then validates and attests the intent (`atomic intent validate` → `atomic intent attest`)
5. Records durable memories of the right kind (`atomic memory new --kind …`), attested and linked
6. Hooks automatically record the code changes with provenance when the turn ends

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
| `agents/atomic.md.frontmatter` | Agent frontmatter — the body is rendered from the atomic-skills `AGENTS.md` shared source at install time |
| `skills/atomic-vault/SKILL.md` | Vault reference (goals, intents, memory) |
| `skills/decision-record/SKILL.md` | Durable memory classification and source-linking workflow |
| `skills/atomic-vcs/SKILL.md` | Read-only VCS inspection (status, log, change, diff) |
| `skills/code-intelligence/SKILL.md` | Knowledge graph query patterns |
| `opencode.json` | Default permissions |

## Uninstall

```bash
atomic agent disable --agent opencode
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
