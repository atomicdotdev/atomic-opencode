---
name: atomic-vault
description: Teaches the Atomic vault workflow — directive-based intents (a mandatory :::why plus acceptance-criteria and tasks) that must validate and attest, goals, and durable memories. Use it to author one conforming, signed intent per unit of work, track it through completion, and capture durable knowledge.
---

# Atomic Vault Workflow

The vault is Atomic's built-in project-management and context system. It tracks
**intents** (units of work), **goals** (work sessions), and **memories**
(durable knowledge). Every unit of work is a **directive-based intent** that
must end **conforming and attested** — an intent with no `:::why` cannot be
validated or signed, so it is dead on arrival.

## Core Concepts

- **Intent** — a unit of work, authored as directives (`:::why`,
  `:::acceptance-criterion`, `:::task`, `:::scope-in`/`:::scope-out`,
  `:::constraint`). It has an ID (e.g. `PROJ::you::1`), a status, and lifts to a
  canonical node you `validate` and `attest`.
- **Goal** — a focused work session tying one or more intents together.
- **Memory** — a durable, attestable knowledge record of a chosen kind
  (`decision`, `lesson`, `constraint`, `preference`, `context`). See the
  `/decision-record` skill.

## Intent Commands

```bash
atomic intent list                                 # List intents + attested/verifies (CHECK FIRST)
atomic intent new "<title>"                        # Create a directive-based intent
atomic intent show <id>                            # Render the lifted intent
atomic intent validate <id>                        # Gate it against the canonical shapes
atomic intent attest <id>                          # Sign the conforming intent
atomic intent verify <id>                          # Verify a signed intent
atomic intent update <id> --status <status>        # Set status / fields
atomic intent delete <id>                          # Delete an unstarted backlog intent
atomic intent link <id> --goal <goal>              # Link the intent to a goal
```

Always create with `atomic intent new`. (The old `atomic vault intent create`
wrote a legacy template that did not lift — no `:::why`, so it could never
validate or attest — and has been removed.)

### Intent statuses

`backlog` → `planned` → `in-progress` → `review` → `done`

### CRITICAL: check before creating

Run `atomic intent list` first. Duplicate intents waste effort — only create a
new one if none covers the work.

## The intent file is directive-based

`atomic intent new` scaffolds `.vault/intents/<id>/intent.md` with stubs you
fill. Replace **every** stub. `:::why` is **mandatory** — the gate rejects an
intent with no `why` (its content isn't graded, but it must be present):

```markdown
:::why
Why this work matters — the reason it exists.
:::

:::acceptance-criterion{#<uid>-ac-1 status=unmet}
A single concrete, checkable outcome that means "done".
:::

:::task{#<uid>-1 status=unmet criteria=<uid>-ac-1}
An ordered work item toward the criterion above.
::file-ref{path=path/to/file}
:::

:::scope-in
What this intent will change.
:::

:::scope-out
What it will deliberately NOT change.
:::

:::constraint
A rule the implementation must respect.
:::
```

After editing the file, run `atomic vault sync` to persist to the vault
database. The CLI reads `show`/`validate`/`attest`/`update` from the database,
not the file — so sync **before** them, or `show` renders the stale scaffold and
`update` re-materializes the database copy over your edits, clobbering them.
(`atomic vault sync` is not `atomic record` — hooks handle recording; you still
run `sync`.)

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

Memories are durable knowledge, authored and signed like intents:

```bash
atomic memory kinds                                        # Allowed kinds + when to use each
atomic memory new --kind <kind> --text "..." --derived-from <urn>   # Create (canonical)
atomic memory validate <id>                                # Gate
atomic memory attest <id>                                  # Sign
atomic memory list [-n <N>]                                # List — recent first, full ULID, kind/status/attested
atomic memory show <id>                                    # Show a memory's content
atomic memory write <name> [--type <t>]                    # Freeform write from stdin (raw escape hatch)
```

Capture durable memories at turn end and classify each into the right kind —
see the `/decision-record` skill for the rubric and source-linking.

## Full Workflow (End to End)

Follow this sequence for every piece of work:

### 1. Check existing intents

```bash
atomic intent list
```

Look for an existing intent that matches the task. Do NOT create duplicates.

### 2. Create ONE intent (if needed)

```bash
atomic intent new "Implement user authentication"
```

One intent per unit of work. It prints the ID and the file path.

### 3. Fill the directives

Replace every stub in `.vault/intents/<id>/intent.md`: the mandatory `:::why`,
at least one `:::acceptance-criterion` and `:::task`, plus scope/constraints.
Then persist:

```bash
atomic vault sync
```

### 4. (Optional) Start a goal

```bash
atomic vault goal start "auth-implementation"
atomic intent link <id> --goal auth-implementation
```

### 5. Do the work

Write code and iterate. As each criterion's outcome holds, **verify** it (run
the actual checks), then flip its `status=unmet` → `status=met` in the intent
file with your **file-editing tool** (never bash, Python, or sed — that bypasses
the vault), and `atomic vault sync`. Do not mark a criterion met speculatively.

**Marking a criterion met takes three attributes, not one.** The gate rejects a
checked box with nothing behind it, so set `verifiedBy` and `evidence` in the
same edit:

```markdown
:::acceptance-criterion{#<uid>-ac-1 status=met verifiedBy=<who/what checked it> evidence="<how it was checked>"}
```

`verifiedBy` names what did the checking (a DID, a test name, a person);
`evidence` records how (a command that passed, a change urn, an observation).
Flipping only `status=met` makes `atomic intent validate` fail with
`a met acceptance criterion must carry verifiedBy and evidence`.

You do **not** create or switch views, and you do **not** run `atomic add` or
`atomic record` — the integration's hooks own all of that:

- **Session start** forks a draft view from your current view and switches into
  it automatically. Your whole session runs inside it.
- **Turn end** records automatically — `status` → `add` → `record --all` with
  full AI provenance (model, tokens, cost, session, decision graph).
- **Session end** switches back to your original view.

To review what the hooks recorded, use the `/atomic-vcs` skill.

### 6. Validate, attest, and complete

An intent is not done until it **conforms and is signed**:

```bash
atomic vault sync                          # persist your edits first
atomic intent update <id> --status done    # mark it done
atomic vault sync
atomic intent validate <id>                # MUST conform
atomic intent attest <id>                  # sign the completed intent
```

`validate` is a hard gate: before `attest` the only violations it may report are
the fillable `attributedTo` + `proof` (which `attest` fills). If it flags `why`
or a criterion, your directives are incomplete — fix them, `atomic vault sync`,
and validate again. Confirm with `atomic intent list`: the intent must show
`fresh` / `✓`.

### 7. Stop the goal when done

```bash
atomic vault goal stop
atomic vault sync
```

## Resuming Work

If you stopped a goal and need to come back:

```bash
atomic vault goal list                  # Find the suspended goal
atomic vault goal resume "auth-implementation"
# Continue working — the hooks manage the session view for you
```

## Tips

- One intent per unit of work; run `atomic intent list` first.
- **`:::why` is mandatory** — no `why`, no attest. Create with `atomic intent
  new` (the legacy `atomic vault intent create` has been removed).
- Fill the directives before coding; `atomic vault sync` after every file edit
  and before every `show`/`validate`/`attest`/`update`.
- Finish with `validate` → `attest`; the intent isn't done until `atomic intent
  list` shows it `fresh` / `✓`.
- You don't manage views or recording — hooks fork a draft view at session
  start, record at turn end, and restore your view at session end. Inspect the
  results with the `/atomic-vcs` skill.
