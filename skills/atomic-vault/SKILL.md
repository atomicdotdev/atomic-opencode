---
name: atomic-vault
description: Teaches the Atomic vault workflow for goals, intents, memory, and the development cycle.
---

# Atomic Vault Workflow

The vault is Atomic's built-in project management and context system. It tracks **goals** (work sessions), **intents** (units of work), and **memory** (persistent knowledge). Always use vault commands to stay organized.

## Core Concepts

- **Intent**: A unit of work (like a ticket). Has an ID, title, status, and a deliverable markdown file.
- **Goal**: A focused work session tied to one or more intents. Tracks what you're actively doing.
- **Memory**: Persistent knowledge entries the vault retains across sessions.

> **Sync before you read or update.** Intent files live on disk under `.vault/`, but
> `intent show`/`update` read from the vault **database**. Run `atomic vault sync` after
> every edit and before every `show`/`update`, or you will read a stale placeholder and
> `update` will overwrite your edits with it.

## Intent Commands

```bash
atomic vault intent list                # List all intents (CHECK THIS FIRST)
atomic vault intent create "title"      # Create a new intent
atomic vault intent show <id>           # Show intent details
atomic vault intent update <id> --status <status>  # Update intent status
atomic vault intent link <id> --goal <goal>         # Link intent to a goal
```

### Intent Statuses

`backlog` → `planned` → `in-progress` → `review` → `done`

### CRITICAL RULE: Always Check Before Creating

Before creating any intent, run `atomic vault intent list` first. Duplicate intents cause confusion and waste effort. Only create a new intent if no existing one covers the work.

## Goal Commands

```bash
atomic vault goal start "goal name"     # Start a new work session
atomic vault goal stop                  # Stop the current goal
atomic vault goal resume <name>         # Resume a suspended goal
atomic vault goal list                  # List all goals
```

### Goal Statuses

- **active** — Currently being worked on
- **suspended** — Paused (via `goal stop`), can be resumed
- **completed** — Finished

## Memory Commands

```bash
atomic vault memory list                # List all memory entries
atomic vault memory show <key>          # Show a specific memory entry
atomic vault memory write <key> "val"   # Write a memory entry
```

## The Intent File Is the Deliverable

Each intent has a markdown file at `.vault/intents/<id>/intent.md`. This file IS the deliverable — fill it in completely:

```markdown
## Description
What this intent accomplishes and why.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Files to Modify
- `path/to/file.rs` — what changes and why

## Approach
Step-by-step plan for implementation.

## Test Strategy
How to verify the work is correct.

## Notes
Any additional context, decisions, or open questions.
```

After editing intent markdown files, run `atomic vault sync` to persist changes back to the vault database. **Always `atomic vault sync` before `atomic vault intent show`/`update`** — the CLI reads from the database, not the file, so an unsynced `show` renders the stale placeholder template and `update` re-materializes the database copy over the file, clobbering your edits. `atomic vault sync` is not `atomic record`; it only moves your `.vault/` edits into the vault database, and you must run it even though the plugin handles recording.

## Full Workflow (End to End)

Follow this sequence for every piece of work:

### 1. Check existing intents

```bash
atomic vault intent list
```

Look for an existing intent that matches your task. Do NOT create duplicates.

### 2. Create ONE intent (if needed)

```bash
atomic vault intent create "Implement user authentication"
```

Create exactly one intent per unit of work. Fill in the intent file at `.vault/intents/<id>/intent.md`.

### 3. Start a goal

```bash
atomic vault goal start "auth-implementation"
atomic vault intent link <intent-id> --goal auth-implementation
```

### 4. Do the work

Write code and iterate. You do **not** create or switch views, and you do **not** run `atomic add` or `atomic record` — the OpenCode plugin owns all of that:

- **Session start** forks a draft view from your current view and switches into it automatically (a haikunator-named view, e.g. `early-ridge-ffd9`). Your whole session runs inside it.
- **Turn end** records automatically — the plugin runs `status` → `add` (tracks new files) → `record --all` with full AI provenance (model, tokens, cost, session, decision graph).
- **Session end** switches back to your original view.

To review what the plugin recorded (diff, provenance, AI attestation), use the `@atomic-vcs` skill: `atomic log -f oneline`, then `atomic change -p -a`.

### 5. Update intent status

```bash
atomic vault sync                                  # persist file edits first
atomic vault intent update <id> --status review
```

Always `atomic vault sync` before `intent update` — `update` re-materializes the database copy over the file, so an unsynced update discards your edits.

### 6. Stop the goal when done

```bash
atomic vault goal stop
atomic vault sync
atomic vault intent update <id> --status done
```

### 7. Sync vault state

```bash
atomic vault sync
```

A final sync ensures every vault edit is in the database before the turn's automatic record captures it.

## Resuming Work

If you stopped a goal and need to come back:

```bash
atomic vault goal list                  # Find the suspended goal
atomic vault goal resume "auth-implementation"
# Continue working — the plugin manages the session view for you
```

## Tips

- One intent per unit of work — keep them focused
- Start every session by checking `atomic vault intent list` and `atomic vault goal list`
- Fill in the intent markdown completely before starting implementation
- Run `atomic vault sync` after editing any vault markdown file, and before every `show`/`update`
- You don't manage views or recording — the plugin forks a draft view at session start, records at turn end, and restores your view at session end. Inspect the results with the `@atomic-vcs` skill.