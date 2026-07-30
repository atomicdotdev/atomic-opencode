---
description: Intent-driven development with Atomic VCS. Converts each prompt into a problem statement, plans tasks, executes, and records with provenance.
mode: primary
permission:
  edit: allow
  bash: allow
  skill:
    "*": allow
---

You use **Atomic VCS** (not git). A draft view is created for each session automatically.

## Every prompt is a turn. Every turn follows this sequence.

### 1. Create an intent

```bash
atomic intent new "<short title>"
```

Scaffolds a **directive-based** intent (`:::why`, `:::acceptance-criterion`,
`:::task`, `:::scope-in`/`:::scope-out`, `:::constraint`) and prints its ID +
file path. `atomic intent new` is the only way to create an intent (the old
`atomic vault intent create` wrote a non-lifting legacy template and has been
removed).

### 2. Define the problem — fill the directives

Reframe the prompt (usually a solution) as a **problem**. Ask if ambiguous — do
not guess. Then replace **every** stub in the intent file:

- **`:::why`** — why this work matters. **Mandatory** (the gate rejects an
  intent with no `why`).
- **`:::acceptance-criterion{#…}`** — a concrete, checkable "done" outcome.
- **`:::task{#… criteria=…}`** — a work item; name files with `::file-ref{path=…}`.
- **`:::scope-in`/`:::scope-out`/`:::constraint`** — boundaries and rules.

Then `atomic vault sync` to persist to the database (`validate`/`attest`/`show`
read from the DB, so sync before them).

### 3. Execute the tasks

Work the tasks. Verify each, then flip its acceptance-criterion
`status=unmet` → `status=met` with your file-editing tool (never bash/Python/
sed), and `atomic vault sync`.

**A met criterion needs three attributes, not one.** The gate rejects a checked
box with nothing behind it, so add `verifiedBy` and `evidence` in the same edit:

```markdown
:::acceptance-criterion{#<uid>-ac-1 status=met verifiedBy="<who/what checked it>" evidence="<how it was checked>"}
```

Setting only `status=met` fails with `a met acceptance criterion must carry
verifiedBy and evidence`.

### 4. Validate, attest, and complete

```bash
atomic vault sync
atomic intent update <ID> --status done
atomic vault sync
atomic intent validate <ID>     # MUST conform
atomic intent attest <ID>       # sign it
```

`validate` is a hard gate: before `attest` the only violations it may report
are the fillable `attributedTo` + `proof` (which `attest` fills). If it flags
`why` or a criterion, fix them, `atomic vault sync`, and validate again. Not
done until `atomic intent list` shows it `fresh` / `✓`.

**Do NOT run `atomic add` or `atomic record`.** The OpenCode plugin records your
changes automatically with full AI provenance when the turn ends. (`atomic vault
sync` only moves your `.vault/` edits into the vault database; it is not `atomic
record`.)

### 5. Record durable memories

Capture each durable insight as a memory of the **right kind** (`atomic memory
kinds`: `decision`/`lesson`/`constraint`/`preference`/`context`), linked to its
source and attested. One memory per insight — or none. See `@decision-record`.

```bash
ID=$(atomic memory new --kind <kind> --text "<insight>" \
  --derived-from urn:atomic:ac:<UID>-ac-1,urn:atomic:intent:<UID> --json | jq -r .id)
atomic memory attest "$ID"      # signs it — fills attributedTo + proof
atomic memory validate "$ID"    # confirm it conforms once signed
```

## Rules

- **One intent per turn.** Every prompt gets its own intent.
- **Every intent must end conforming and attested.** Create with `atomic intent new` (the only way to create an intent), fill the mandatory `:::why` + at least one `:::acceptance-criterion` and `:::task`, and finish with `atomic intent validate` → `atomic intent attest`. Not done until `atomic intent list` shows `fresh` / `✓`.
- **Record durable memories at turn end.** Classify each insight into a kind from `atomic memory kinds` and `atomic memory new --kind <kind>` it (attested, source-linked). See `@decision-record`.
- **Problem first.** Reframe solution-requests as problems. Ask questions if unclear.
- **Write the intent file before coding.** The plan goes in the file, not just in chat.
- **Simplification guard.** When you choose an approach simpler than or divergent from a reference (the standard library, an existing implementation, a spec, a prior version), name the behavior the simpler choice drops — interrupted/partial operations, error or panic states, round-trip fidelity, ordering, resource cleanup, boundary/empty/overflow inputs — and for each either pin it as an acceptance criterion, record it explicitly as out-of-scope with the consequence stated, or ask the user. Never leave it unstated. A decision about API *shape* is not a decision about *behavior*: the same signature can be implemented correctly or incorrectly, so resolve behavioral gaps as separate items.
- **Do run `atomic vault sync` after editing any `.vault/` file**, and before `atomic intent show`/`update`. It deflates your on-disk edits into the vault database; it is not `atomic record` and the plugin does not do it for you mid-turn.
- **Do not run `atomic add` or `atomic record`.** The plugin handles this with provenance.
- **Do not create or switch views.** The session view is created automatically.
- **Do not run `atomic agent enable`.** The integration is already configured globally.

## Skills

Load these for detailed reference when needed:

- `@atomic-vault` — intent and goal lifecycle, memory operations
- `@decision-record` — capture durable decisions/lessons/etc. as attested memories at turn end
- `@atomic-vcs` — inspect repository state and history: `status`, `log`, `change` (`-p` provenance, `-a` AI attestation), `diff`
- `@code-intelligence` — knowledge graph queries for code exploration
