---
name: code-intelligence
description: Use the Atomic vault knowledge graph to search for code entities, explore connections between files/functions/changes, and navigate the codebase intelligently before reading files.
---

# Code Intelligence — Knowledge Graph Navigation

## The Pattern: KG Search → Neighbors → Targeted Read

Always follow this workflow when exploring unfamiliar code:

1. **Search** for what you need with `atomic vault query search`
2. **Explore connections** with `atomic vault query neighbors`
3. **Read the actual file** only after you know exactly where to look

This avoids reading entire files blindly and gives you structural understanding first.

## Commands

### Search the Knowledge Graph

```
atomic vault query search "keyword"
```

- Use **simple, specific terms** — one or two words work best
- Do NOT use long phrases or natural language queries
- Max **10 results** per search — be precise
- Results return node IDs and descriptions

**Good searches:**
```
atomic vault query search "record"
atomic vault query search "view filter"
atomic vault query search "GraphNode"
atomic vault query search "materialize"
```

**Bad searches:**
```
atomic vault query search "how does the record workflow create changes"
atomic vault query search "the function that handles view creation and switching"
```

### Explore Neighbors

```
atomic vault query neighbors <node_id>
```

- Shows all nodes directly connected to the given node
- Reveals relationships: which functions call what, which files contain which entities, which changes touched which files
- **CRITICAL: never construct node IDs yourself — always copy them verbatim from search results**

### Node ID Format

Node IDs follow a typed prefix pattern:

| Prefix | Format | Example |
|--------|--------|---------|
| `entity:` | `entity:file:name:line` | `entity:src/apply/mod.rs:write_change_to_graph:42` |
| `file:` | `file:path` | `file:atomic-core/src/pristine/traits.rs` |
| `change:` | `change:HASH` | `change:ABC123DEF456...` |
| `view:` | `view:name` | `view:main` |
| `intent:` | `intent:ID` | `intent:feat-view-filters` |
| `goal:` | `goal:name` | `goal:ambient-graph-phase-9` |

### File Neighbors — See Everything in a File

To understand what a file contains without reading it:

```
atomic vault query neighbors file:atomic-core/src/apply/mod.rs
```

This returns all entities (functions, structs, traits, constants) defined in that file and their connections to other parts of the codebase.

## When to Use What

| Goal | Tool | Why |
|------|------|-----|
| Find where something is defined | `atomic vault query search` | KG indexes all definitions |
| Understand what a function connects to | `atomic vault query neighbors` | Shows callers, callees, related types |
| Find text in file contents | `grep` / project search | KG indexes structure, not raw text |
| Read implementation details | `read_file` | After KG tells you where to look |
| Find files by name pattern | `find_path` | KG indexes content, not filename globs |
| Understand a change's impact | `neighbors` on a `change:` node | Shows all files/entities affected |

## Chaining Searches

Build understanding iteratively:

1. **Search** for a starting concept:
   ```
   atomic vault query search "ViewScope"
   ```
2. **Get the node ID** from results (e.g., `entity:atomic-core/src/pristine/traits.rs:ViewScope:15`)
3. **Explore neighbors** to find connected code:
   ```
   atomic vault query neighbors entity:atomic-core/src/pristine/traits.rs:ViewScope:15
   ```
4. **Follow a connection** — pick an interesting neighbor and explore it:
   ```
   atomic vault query neighbors entity:atomic-core/src/pristine/txn/write/view.rs:create_view:28
   ```
5. **Now read** the specific lines you care about with full context of how they connect to the rest of the system.

## Tips

- Start broad, then narrow: search a concept, then neighbors to find the specific entity
- If search returns nothing, try synonyms or shorter terms
- Node IDs are **exact strings** — a single wrong character means "not found"
- Use `file:` neighbors as a table of contents for any source file
- The KG is populated from recorded changes — unrecorded work won't appear until after `atomic record`
