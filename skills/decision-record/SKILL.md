---
name: decision-record
description: At the end of a turn, review the session ledger and your own reasoning and capture each durable insight as an attestable Atomic memory of the RIGHT kind — decision, lesson, constraint, preference, or context — creating multiple memories when a turn produced several. Use this whenever you made a non-trivial choice, learned a corrective lesson, discovered a rule or constraint, established a durable preference, or uncovered background worth keeping. The memories are attestable, linked to the work that produced them, searchable via `atomic query`, and resurfaced as context in future turns via `atomic vault context`.
---

# Recording Durable Memories

At the end of a turn, look back over what happened — the ledger (`atomic change -p`,
or your own record of the turn) and your reasoning — and capture the **durable**
insights as memories. Do **not** force everything into one kind: read each
insight and classify it into the best-fit kind. A single turn may yield a
`decision` *and* a `lesson` *and* a `constraint` — create one memory per
insight. A turn may also yield nothing worth keeping — then record nothing.

You do this yourself, from your own context, because you are the only one who
knows why things happened and which kind each insight is. The commands below are
just the sink.

## 1. Choose the kind

Classify each insight into exactly one kind. The authoritative list is
`atomic memory kinds` (the CLI rejects anything outside it):

| Kind | Use when |
|------|----------|
| `decision` | You made a deliberate choice between real options — what you chose, why, over which alternatives, and the outcome. |
| `lesson` | Something went wrong or surprised you — the failure and the corrective takeaway. |
| `constraint` | You discovered a hard rule or limit the work must respect — an invariant, boundary, or requirement. |
| `preference` | You established a soft or stylistic default the team leans toward — a convention, not a hard rule. |
| `context` | You uncovered durable background or domain knowledge that explains how or why something is — not a rule, not a decision. |

One insight → one kind → one memory. If an insight genuinely spans two kinds
(e.g. a decision that also taught a lesson), record both, and link them with
`--derived-from urn:atomic:memory:<other-id>`.

## 2. Keep it high-signal

Record only durable, consequential insights:

- **Do** record: a choice between real options; a rejected approach and why; a
  non-obvious constraint discovered; a corrective lesson; durable domain context.
- **Don't** record: routine steps ("ran the tests", "edited the file"); a
  restatement of the task/intent; transient chain-of-thought with no lasting
  consequence; anything already captured verbatim in the intent.

One memory per genuine insight — do not split one insight across several, or pad.

## 3. Record each — `new → validate → attest`

For every insight, pick the kind and run the canonical lifecycle (the same one
intents use), signed every time. Drive `new` non-interactively with `--text` so
nothing blocks, and link it to the most specific source it came from:

```bash
ID=$(atomic memory new --kind <chosen-kind> \
  --text "<the insight, self-contained>" \
  --derived-from urn:atomic:ac:<UID>-ac-1,urn:atomic:intent:<UID> \
  --json | jq -r .id)
atomic memory attest "$ID"      # signs it — this is what fills attributedTo + proof
atomic memory validate "$ID"    # confirm it conforms once signed
```

**Attest first, then validate.** `attest` runs the full gate itself before
signing, so nothing unchecked gets signed. Running `validate` on a *fresh*
memory always exits 2 on `attributedTo` + `proof` — the two properties only
`attest` can write — so `validate && attest` never reaches `attest`.

Repeat for each insight (e.g. one `decision`, then one `lesson`).

- **`--kind`** — the kind you chose in step 1, so `atomic query` can filter by it.
- **`--text`** — one tight, self-contained paragraph. For a `decision`:
  *decision · rationale · rejected alternative · outcome*. For a `lesson`:
  *what failed · the takeaway*.
- **`--about`** *(optional)* — module/domain urns the memory concerns.
- **Always `attest`, then `validate`.** An unattested memory is unsigned and
  untrusted — finish the lifecycle the same way you do for an intent. `attest`
  gates before it signs; `validate` on an unsigned memory only ever reports the
  two properties signing fills.

## 4. Link it to where it came from (`--derived-from`)

This is the payoff: a memory should point at the **most specific** thing it came
from, not just the intent. `--derived-from` takes one or more canonical urns
(comma-separated); each becomes a `wasDerivedFrom` edge, so `atomic query` can
walk *criterion → memory* or *todo → memory*.

> **Reading those edges back takes the bare KG id, not the urn.**
> `--derived-from` is written in urn form (`urn:atomic:intent:<UID>`), but
> `atomic query neighbors` resolves only `intent:<UID>` / `memory:<id>` — handed
> a urn it prints `No neighbors found` and still exits 0, which reads as "the
> link failed" when the link is fine. Never construct these ids: copy them from
> `atomic query search "<term>"`, which prints the resolvable form.

Copy the id **verbatim** from the intent file / your todo list (the `#…` on the
directive), wrapped in the matching urn. For intents, acceptance criteria, and
tasks the id is the intent's ULID (UPPERCASE) and the graph canonicalizes case,
so verbatim is simplest. **Memory ids are the exception** — they are lowercase
ULIDs and are *not* case-folded, so `urn:atomic:memory:<id>` must match the id
exactly as `atomic memory list` prints it, or the edge silently points at a node
that does not exist:

| The insight came from… | Pass |
|---|---|
| an acceptance criterion (`:::acceptance-criterion{#<UID>-ac-1}`) | `urn:atomic:ac:<UID>-ac-1` |
| a task (`:::task{#<UID>-1}`) | `urn:atomic:task:<UID>-1` |
| a todo item (id `t2` in your todo tool) | `urn:atomic:todo:t2` |
| a prior memory | `urn:atomic:memory:<id>` |
| nothing more specific | the intent: `urn:atomic:intent:<UID>` |

Always include the intent as a fallback link, and add the criterion / task /
todo when the insight maps to one. (`todo` ids are your own, not ULID-derived,
so their case is preserved as you wrote them.)

## Rules

- **Record at turn end**, after the work is done and the outcome is known — the
  outcome is part of the memory.
- **Classify, don't default.** Pick the right kind per insight from
  `atomic memory kinds`; emit multiple memories when a turn produced several.
- **Do NOT run `atomic add` or `atomic record`.** `atomic memory new` writes into
  the vault and the OpenCode plugin records it automatically at turn end (same as
  your intent edits). You do **not** need `atomic vault sync` for `atomic memory
  new` — it writes to the vault database directly.
- **Reuse, don't duplicate.** If an insight merely reaffirms an existing memory,
  skip it. Check with `atomic vault context "<topic>"` when unsure.
- **Always attest.** Run `atomic memory validate` then `atomic memory attest`
  after each `new`.
- **Link the most specific source.** Always pass the intent urn, and add the
  acceptance-criterion, task, or todo urn when the insight maps to one. The more
  precise the link, the more useful the graph.
