# ContextBridge

ContextBridge is a local-first CLI for moving an active coding task between a
local repository and a web AI chat. It creates a focused handoff, sends later
repository changes as incremental sync packages, and safely applies a strict AI
change document back to disk.

It is not a SaaS service and it is not another whole-repository prompt packer.
Its six MVP commands perform no uploads, make no API calls, require no account,
and include no telemetry.

## Requirements

- Node.js 20 or newer
- A clipboard provider available to Node.js (when unavailable, ContextBridge
  still saves the generated package under `.contextbridge/outputs/`)

## Install

Install the published CLI globally:

```bash
npm install --global contextbridge-cli
cb --help
```

Or run it without a global install:

```bash
npx contextbridge-cli --help
```

For local development from a cloned repository:

```bash
npm install
npm run build
npm link

cd /path/to/your/project
cb init
cb handoff "continue implementing Google OAuth"
```

Paste the copied package into ChatGPT, Claude, Gemini, or another web AI. Copy
the AI's strict ContextBridge response and run:

```bash
cb apply
```

After additional local edits, update the same chat with:

```bash
cb sync
```

Other commands:

```bash
cb status
cb undo
```

Use `cb <command> --help` for options. `handoff` and `sync` support `--no-copy`,
`--stdout`, and `--budget <tokens>`. Sync refuses to advance its snapshot when
an incremental package exceeds the configured token budget; pass a reviewed
larger budget to retry. `apply --file changes.xml` is a clipboard fallback.
`--yes` skips the confirmation only after the diff is printed.

## What handoff does

1. Reads `.gitignore`, `.contextbridgeignore`, and local configuration.
2. Hard-excludes `.env*`, private keys, credential files, common generated
   directories, binary files, oversized files, and high-confidence embedded
   secret values.
3. Builds the repository tree, Tree-sitter symbols/imports for JavaScript and
   TypeScript, fallback symbols for other common languages, and a local import
   graph.
4. Scores task relevance from lexical terms, paths, symbols, imports,
   dependencies, important manifests, uncommitted files, and recent Git history.
5. Fits the most useful complete files into a locally estimated token budget.
6. Saves and copies the package, then records a repository hash snapshot.

No repository contents are sent anywhere by ContextBridge. Clipboard contents
leave the machine only when you choose to paste them into another product.

## Strict AI change format

`cb apply` accepts exactly one envelope (an optional single Markdown XML fence
is allowed). `create` and `modify` contain complete replacement file contents,
not patches or abbreviated snippets.

```xml
<contextbridge-changes version="1">
  <modify path="src/auth/session.ts"><![CDATA[
export function getSession() {
  return { authenticated: true };
}
]]></modify>
  <create path="src/auth/google.ts"><![CDATA[
export const provider = "google";
]]></create>
  <delete path="src/auth/legacy.ts" />
</contextbridge-changes>
```

ContextBridge rejects malformed operations, duplicate targets, absolute paths,
`..` traversal, paths through symlinks, state-directory writes, wrong create vs.
modify semantics, and detected secrets. It previews unified diffs and warns
about a dirty Git worktree before asking for confirmation.

## Snapshots, sync, and undo

State lives only in `.contextbridge/`, which `cb init` adds to `.gitignore`.
Every handoff and sync advances the active hash snapshot. A successful apply
also advances it because the web AI already knows the edits it produced; the
next `cb sync` therefore reports only later local changes.

Before apply, existing files are copied into a timestamped local backup. `cb
undo` restores the most recent apply and removes files it created. If a target
changed again after apply, undo refuses to overwrite it unless `--force` is
explicitly supplied after review.

## Configuration

`cb init` writes `.contextbridge/config.json`:

```json
{
  "version": 1,
  "context": {
    "tokenBudget": 60000,
    "maxFileBytes": 512000,
    "includeTests": false,
    "includeGitInfo": true
  },
  "security": {
    "detectSecrets": true
  },
  "ignore": ["node_modules/", "dist/", "build/", ".next/", "coverage/"]
}
```

Add repository-specific patterns to `.contextbridgeignore`. Built-in secret
exclusions are security boundaries and cannot be negated by ignore rules.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The implementation plan and invariants are documented in [PROJECT.md](PROJECT.md).

A comprehensive Turkish explanation of token budgeting, relevance scoring,
repository scanning, snapshots, security boundaries, and the research behind
the design is available in [docs/TEKNIK-REHBER.md](docs/TEKNIK-REHBER.md).
