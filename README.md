# agent-mnemopi

Pinned source package for the shared Mnemopi adapter and the exact-content
Claude/Codex Markdown migration. The adapter uses the OMP Mnemopi SQLite
engine as the canonical durable store; native OMP session histories remain
separate and no live databases, reports, or private memory inventories belong
in this repository.

## Build and test

Requirements: Bun `>=1.3.14`, Git, and an OMP checkout at the pinned source
commit. Set `OMP_SOURCE=/absolute/path/to/omp` to that checkout before running
the setup or build commands.

```sh
bun run setup
bun run build
bun run test
bun run hook-smoke                 # dry run
bun run hook-smoke -- --run        # clean fixture only
```

`setup` verifies the OMP commit and creates local `node_modules/@oh-my-pi/*`
links to `pi-ai`, `pi-catalog`, `pi-natives`, and `pi-utils`. `build` emits the
ignored `adapter/dist/shared-memory.js`; `test` rebuilds it, runs the adapter
regression suite, and runs the migration suite. No network fetch or live-store
write is part of these commands.

## Host hooks

The adapter emits a SessionStart payload for Claude or Codex. It reads hook JSON
from stdin, uses its `cwd` (or an explicit absolute `--cwd`), and writes only the
JSON hook response to stdout:

```sh
adapter/dist/shared-memory.js session-start --cwd /absolute/project
printf '%s\n' '{"cwd":"/absolute/project","source":"startup"}' \
  | adapter/dist/shared-memory.js startup --host codex
adapter/dist/shared-memory.js review --cwd /absolute/project --due-days 7
```

`startup` is an alias for `session-start` for installed host commands. Recall
content is marked as untrusted data and is never a host instruction. Startup
reports missing or unreadable stores instead of silently opening a replacement
database. It bounds injected context and reports omitted or stale notes. A due
review runs automatically at startup on its weekly schedule by default. It is
read-only, does not prune or repair memories, and publishes a private full-text
snapshot only after successful completion; the explicit `review` command is also
available. Startup filters curated rows in SQLite before loading them, keeps a
one-year timestamp window for project-scoped rows (while retaining durable
global preferences, corrections, and identities plus null or malformed
timestamps for safe classification), and backs off failed review sweeps from
one minute up to one hour instead of retrying every session. If a bounded
project sweep omits rows, startup reports the omission in its untrusted
context diagnostics. Admission inputs are computed once, in SQLite, so
if the filtered query fails, the capped fallback that reruns it without its
filter admits the same rows and reports that degraded path visibly; callback
recall is selected against the concrete project path rather than synthetic
startup wording.

The installer is opt-in and never grants blanket hook trust:

```sh
bun run install-hooks -- --command /absolute/path/shared-memory
bun run install-hooks -- --command /absolute/path/shared-memory --apply
```

Review the dry run first. `--apply` preserves existing hook groups, appends one
command to each selected host, and leaves a private backup beside any existing
settings file. Then use the host's normal hook review flow and trust only the exact
command. Do not use a permanent bypass. Hook timeouts are seconds (Claude 10,
Codex 15); startup has a shorter internal bound.

## Runtime

```sh
adapter/dist/shared-memory.js context --cwd /absolute/project
adapter/dist/shared-memory.js mcp --cwd /absolute/project
adapter/dist/shared-memory.js call mnemopi_recall '{"query":"...","bank":"..."}' --cwd /absolute/project
```

The adapter reads OMP global/project settings and requires explicit banks for
tool calls. Adapter writes use `session_id == channel_id == bank`,
`trust_tier=IMPORTED`, and `workingMemoryLimit=0`, so they do not prune native
working memories. The six exposed tools are `mnemopi_remember`,
`mnemopi_recall`, `mnemopi_get`, `mnemopi_update`, `mnemopi_invalidate`, and
`mnemopi_stats`.

## Markdown migration

`migration/claude-memory.ts inventory` performs a read-only inventory with
canonical paths, byte counts, SHA-256, mtime, classification, bank, and
deterministic IDs. Import requires both `--apply` and an explicit destination:

```sh
bun migration/claude-memory.ts inventory --output PLAN.json
bun migration/claude-memory.ts import --apply --manifest PLAN.json \
  --data-dir /absolute/new/mnemopi-data --report REPORT.json
```

Source bytes are re-read and verified before writes. Archives, unresolved
projects, and secret-like files are isolated or reported; changed sources are
never silently overwritten. Set `CLAUDE_PROJECT_DIR_NAME` only if the optional
read-only Claude project-name helper is installed; otherwise the importer uses
authoritative metadata and safe resolution rules.

## Provenance and architecture

The vendored Mnemopi source is from OMP commit
`d9aa759dc54ae138c4b05639bf41c75f6c51e014`, package version `18.0.11`, under
the upstream MIT license. `patches/mnemopi-mcp-tools.patch` records the
adapter-specific MCP changes: explicit bank scoping, canonical DB selection,
durable imported writes, native-row preservation, narrow tool exposure, and
structured not-found/error responses. `LICENSES/OMP-MIT.txt` carries the
upstream notice.

The migration writes through the vendored `BeamMemory.importFromDict` source;
it does not depend on a transient generated `engine.js` bundle. The generated
adapter bundle is a reproducible build artifact and is intentionally ignored.

## Reliability limits

The adapter exposes explicit memory tools; it does not automatically inject a
recall into every host prompt. Raw MCP recall preserves stock candidates and order,
but labels evidence and warns that scores are not confidence. Task-scoped recall
selection may abstain when results have no query-specific evidence; SessionStart's
curated bootstrap is deterministic and does not apply that query-abstention policy.
The private adapter journal covers adapter mutations only; native OMP and other
writers are not journaled. Weekly review is non-destructive and does not
automatically delete, invalidate, or rewrite rows.
