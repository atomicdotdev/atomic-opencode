# Atomic VCS Agent

You use **Atomic VCS** (not git). A draft view is created for each session automatically.

## Version control rules

- **Never use `git` for repository operations.** Do not run `git status`, `git diff`, `git log`, `git add`, `git commit`, `git checkout`, `git branch`, `git merge`, `git pull`, `git push`, or any other `git` command.
- Use the **Atomic CLI** for version-control context:
  - `atomic status` instead of `git status`
  - `atomic diff` instead of `git diff`
  - `atomic log` instead of `git log`
  - `atomic change <hash>` instead of `git show <hash>`
  - `atomic view list` instead of `git branch`
  - `atomic view switch <name>` instead of `git checkout <name>` when the user explicitly asks to switch views
  - `atomic pull` / `atomic push` instead of `git pull` / `git push`
- **Recording must be done manually.** The hooks track provenance (tool calls, decisions, session metadata in `.atomic/sessions/`) but do NOT auto-record at turn boundaries in this CLI context. After making changes, you must run:
  ```bash
  atomic add -A
  atomic record \
    --ai-assisted \
    --ai-provider opencode \
    --ai-model "big-pickle" \
    --ai-tool cli \
    --ai-suggestion-type complete \
    --ai-session-id "<session_id>"
  ```
  To find the session ID: `cat .atomic/sessions/*.json | python3 -c "import json,sys; print(json.load(sys.stdin)['session_id'])"`

## Every prompt is a turn. Every turn follows this sequence.

### 1. Create an intent

```bash
atomic vault intent create --title "<short title>"
```

This gives you an intent ID (e.g., HELL-4) and a file path.

### 2. Define the problem

The user's prompt is usually a **solution** ("build me X"). Reframe it as a **problem statement**.

Ask clarifying questions if the problem is ambiguous. Do not guess — ask.

Once the problem is clear, define:

- **Problem statement** — what problem are we solving and why
- **Success criteria** — concrete, testable conditions that mean "done"
- **Tasks** — ordered list of work items

Write all of this into the intent file. Replace every REPLACE placeholder.

Then run `atomic vault sync` to persist the file into the vault database. The intent file lives on disk, but `atomic vault intent show`/`update` read from the database — without `sync` they see the original placeholder template, and `update` will overwrite your file edits with it.

### 3. Execute the tasks

Work through the TODOs in order. After completing each one:

1. **Verify** it meets its criteria — run the commands or checks specified in the TODO.
2. **Edit the intent file** using your file editing tool to mark it done:
   ```
   - [ ] `PROJ-1/1` ...   →   - [x] `PROJ-1/1` ...
   ```
   Also check off any acceptance criteria that are now satisfied.
3. **Sync** so the database stays current:
   ```bash
   atomic vault sync
   ```

**Use your file editing tool to check off tasks — not bash, not Python, not sed.** Raw file manipulation bypasses the vault.

### 4. Update the intent

```bash
atomic vault sync                          # persist file edits to the database first
atomic vault intent update <ID> --status done
```

Always `atomic vault sync` before `intent show`/`update` — the CLI reads from the database, not the file, so an unsynced `show` renders the stale placeholder template and `update` re-materializes the database copy over the file, clobbering your edits.

**Recording must be done explicitly after making changes.** The `atomic vault sync` is not `atomic record` — it only moves your `.vault/` edits into the vault database, and you must run it even though you'll also need to record source code changes.

**How hooks track provenance:**
- Every tool call (read, write, edit, bash, etc.) is captured as a **node** in the provenance DAG at `.atomic/sessions/<session_id>/graph.json`. Nodes have types: `goal`, `explore`, `execute`, `commitment`, `patch_proposal`.
- Edges (`led_to`) connect causally related nodes, forming a decision tree.
- The session metadata is stored in `.atomic/sessions/<session_id>.json` (agent name, model, turn count, files touched).
- To inspect: `atomic change -a <hash>` shows attestation; `atomic change -p <hash>` shows provenance DAG (when recorded through hooks).
- The provenance graph is viewable directly: `.atomic/sessions/<session_id>/graph.json`

## Rules

- **One intent per turn.** Every prompt gets its own intent.
- **Problem first.** Reframe solution-requests as problems. Ask questions if unclear.
- **Write the intent file before coding.** The plan goes in the file, not just in chat.
- **Simplification guard.** When you pick an approach simpler than or divergent from a reference (the standard library, an existing implementation, a spec, a prior version), the simpler choice almost always drops a behavior the reference guaranteed. Name what it drops — interrupted/partial operations, error or panic states, round-trip fidelity, ordering, resource cleanup, concurrency, overflow/empty/boundary inputs — and for each, either pin it as an acceptance criterion, record it explicitly as out-of-scope with the consequence stated, or ask the user. Never leave it unstated. A decision about API *shape* is not a decision about *behavior*: the same signature can be implemented correctly or incorrectly, so resolve behavioral gaps as separate items.
- **Do run `atomic vault sync` after editing any `.vault/` file**, and before `atomic vault intent show`/`update`. It deflates your on-disk edits into the vault database; it is not `atomic record` and hooks do not do it for you mid-turn.
- **Do not create or switch views.** The session view is created automatically.
- **Do not run `atomic agent enable`.** The integration is already configured globally.

## Skills

Use these for detailed reference when needed:

- `/atomic-vault` — intent and goal lifecycle, memory operations
- `/atomic-vcs` — inspect repository state and history: `status`, `log`, `change` (`-p` provenance, `-a` AI attestation), `diff`
- `/code-intelligence` — knowledge graph queries for code exploration
