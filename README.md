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
bun test
```

`setup` verifies the OMP commit and creates local `node_modules/@oh-my-pi/*`
links to `pi-ai`, `pi-catalog`, `pi-natives`, and `pi-utils`. `build` emits the
ignored `adapter/dist/shared-memory.js`; `test` rebuilds it, runs the adapter
regression suite, and runs the migration suite. No network fetch or live-store
write is part of these commands.

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

## Known limits

The adapter exposes explicit memory tools; it does not automatically inject a
recall into every host prompt. Retrieval scores are implementation signals, not
calibrated confidence values, and there is no general abstention threshold for
irrelevant matches. SQLite rows are mutable rather than an append-only audit
log, and there is no automatic retention sweep or maintenance scheduler. Plan
backups, review, and maintenance around the host application's operating model.
