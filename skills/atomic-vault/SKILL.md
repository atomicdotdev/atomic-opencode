---
name: atomic-vault
description: "Teaches the full Atomic vault workflow: goals, intents, memory, views integration, and the end-to-end development cycle using atomic vault commands."
---

# Atomic Vault Workflow

The vault is Atomic's built-in project management and context system. It tracks **goals** (work sessions), **intents** (units of work), and **memory** (persistent knowledge). Always use vault commands to stay organized.

## Core Concepts

- **Intent**: A unit of work (like a ticket). Has an ID, title, status, and a deliverable markdown file.
- **Goal**: A focused work session tied to one or more intents. Tracks what you're actively doing.
- **Memory**: Persistent knowledge entries the vault retains across sessions.

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

After editing intent markdown files, run `atomic vault sync` to persist changes back to the vault database.

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

### 4. Create a draft view and switch to it

```bash
atomic view create auth-feature --draft
atomic view switch auth-feature
```

Draft views are isolated workspaces. Always create a draft view for new work.

### 5. Do the work

Write code, add files, iterate.

```bash
atomic add src/auth.rs
atomic add src/auth_test.rs
```

### 6. Record changes

```bash
atomic record -m "feat: add user authentication module"
```

Record frequently — small, focused changes are better than large ones.

### 7. Update intent status

```bash
atomic vault intent update <id> --status review
```

### 8. Stop the goal when done

```bash
atomic vault goal stop
atomic vault intent update <id> --status done
```

### 9. Sync vault state

```bash
atomic vault sync
```

## Resuming Work

If you stopped a goal and need to come back:

```bash
atomic vault goal list                  # Find the suspended goal
atomic vault goal resume "auth-implementation"
atomic view switch auth-feature         # Switch back to the draft view
# Continue working...
```

## Tips

- One intent per unit of work — keep them focused
- Start every session by checking `atomic vault intent list` and `atomic vault goal list`
- Fill in the intent markdown completely before starting implementation
- Use `atomic vault sync` after editing any vault markdown files
- Draft views keep your work isolated until it's ready to insert into a shared view