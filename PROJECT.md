# ContextBridge MVP

ContextBridge is a local-first TypeScript/Node.js CLI that carries an active
coding task from a repository to a web AI chat, keeps that chat synchronized
with later repository changes, and safely applies structured changes back to
the repository.

## MVP commands

- `cb init`
- `cb handoff "<task>"`
- `cb sync`
- `cb apply`
- `cb status`
- `cb undo`

## Architecture

1. **Project/state layer** resolves the initialized project root and stores all
   local state under `.contextbridge/`.
2. **Scanner/security layer** combines built-in exclusions, `.gitignore`,
   `.contextbridgeignore`, and config rules. Secret filenames and detected
   credential values are hard exclusions and cannot be negated.
3. **Code intelligence layer** uses Tree-sitter for JavaScript and TypeScript,
   with conservative fallbacks for other text source files. It emits symbols,
   imports, exports, and a resolved local dependency graph.
4. **Selection layer** ranks files locally from task/path/symbol/content terms,
   dependency edges, important project files, and Git working/recent history.
   No embedding service or LLM API is used.
5. **Handoff layer** emits a compact, token-budgeted package, copies it to the
   clipboard, saves an output copy, and records a content-hash snapshot.
6. **Sync layer** compares the active snapshot with the current safe scan,
   emits only created/modified/deleted files, then advances the snapshot.
7. **Apply layer** accepts one strict `<contextbridge-changes>` block, validates
   every path, previews unified diffs, asks for confirmation, backs up originals,
   and applies operations atomically where practical.
8. **Undo layer** restores the most recent apply backup. It detects repository
   drift after apply and requires an explicit force option before overwriting it.

## Security invariants

- Core commands perform no network requests and include no telemetry.
- Secret files and files containing high-confidence credential values never
  enter a handoff, sync payload, or snapshot.
- Absolute paths, `..` traversal, NUL bytes, `.contextbridge` writes, and paths
  escaping through symlinks are rejected.
- Destructive apply/undo operations are never performed without an interactive
  confirmation or an explicit `--yes` flag.
- A successful apply advances the active snapshot because the originating web
  AI already knows those changes; the next sync therefore contains only later
  local changes.

## Change format

The clipboard must contain exactly one change envelope. File content must be
wrapped in CDATA.

```xml
<contextbridge-changes version="1">
  <modify path="src/example.ts"><![CDATA[
export const value = 2;
]]></modify>
  <create path="src/new.ts"><![CDATA[
export const created = true;
]]></create>
  <delete path="src/old.ts" />
</contextbridge-changes>
```

`modify` requires an existing regular file, `create` requires a missing path,
and `delete` requires an existing regular file.

## Incremental implementation plan

1. Establish the typed project/config/state contracts.
2. Implement scanning, hard secret exclusions, token counting, Tree-sitter
   extraction, Git metadata, and local dependency resolution.
3. Implement relevance scoring, budgeted handoff generation, outputs, and
   snapshots.
4. Implement snapshot comparison and incremental sync generation.
5. Implement strict change parsing, secure path resolution, diff preview,
   confirmation, backup/apply, and drift-aware undo.
6. Wire the six CLI commands and verify security/state behavior with automated
   unit and integration tests.
