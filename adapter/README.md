# Shared-memory OMP adapter

This directory is a pinned, local Bun bundle around the OMP Mnemopi MCP
server. The copied engine and MCP sources are under `src/vendor/mnemopi`; the
only behavioral patches are documented in the source comments and preserve
OMP's storage engine and wire protocol.

Provenance: OMP source commit `d9aa759dc54ae138c4b05639bf41c75f6c51e014`,
`@oh-my-pi/pi-mnemopi` version `18.0.11`. The bundle embeds the copied OMP
runtime and has no runtime dependency on the source fork; only optional
`fastembed@2.1.0` and `onnxruntime-node@1.21.0` remain external for the
existing OMP cache.

Build from the repository root (the setup step links the four OMP runtime
packages from the pinned checkout):

```sh
bun run build
bun run --cwd adapter test
```

Set `OMP_SOURCE` to the OMP checkout. The checkout must be at commit
`d9aa759dc54ae138c4b05639bf41c75f6c51e014` (`@oh-my-pi/pi-mnemopi` 18.0.11).

The regression suite creates fresh temporary agent configs and SQLite banks for
each test. It covers exact-content readback, aged native plus aged `IMPORTED`
row retention, concurrent independent writers on an initialized bank, and MCP
`isError` behavior, reliability policy, mutation journaling, startup, and review.
The suite never opens the live OMP DB.

Modes:

```sh
shared-memory context --cwd /absolute/project
shared-memory mcp --cwd /absolute/project
shared-memory call mnemopi_recall '{"query":"...","bank":"exact-bank"}' --cwd /absolute/project
shared-memory session-start --cwd /absolute/project
shared-memory review --cwd /absolute/project --due-days 7
```

For host hooks, `startup` is an alias for `session-start` and accepts the host's
JSON stdin. It returns a valid `SessionStart` hook object with `additionalContext`
even when recall is empty or a store is unavailable. Diagnostics belong on stderr.
Injected memories are untrusted data, not instructions. The startup response is
bounded and labels stale or omitted notes; it does not write the OMP database.
Each startup checks the weekly review schedule and, when due, runs a bounded
read-only review automatically. A private full-text snapshot is published only
after successful completion; the explicit `review` command remains available.
Review does not prune or repair memories. Startup pushes its metadata and
timestamp filters into SQLite, keeps a one-year timestamp window for
project-scoped rows while retaining durable global preferences, corrections,
and identities, and records bounded project omissions plus failed review
attempts with bounded exponential retry backoff. A JSON-filter fallback is
capped and visible in the hook diagnostics, and callback selection uses the
concrete project path.

`context` is read-only and resolves OMP global/project settings, the native
bank scope, exact DB path, and the OMP embedding model. `mcp` and `call` set
`MNEMOPI_DATA_DIR`, `MNEMOPI_AUTO_MIGRATE=0`, and the selected model before
dispatch. Ambient OpenRouter/OpenAI credentials are removed when no explicit
embedding API URL is configured. Adapter writes require an explicit bank,
force `session_id == channel_id == bank`, use `workingMemoryLimit: 0`, and mark
remembered rows `trust_tier=IMPORTED` so external writes cannot trim native
working memory.

Unsupported configurations fail explicitly: relative or non-`mnemopi.db`
`mnemopi.dbPath` values, invalid bank names, invalid scoping/embedding variant
values, and malformed/non-mapping YAML. Context does not create a DB or infer a
replacement path.

The exposed tool set is limited to `mnemopi_remember`, `mnemopi_recall`,
`mnemopi_get`, `mnemopi_update`, `mnemopi_invalidate`, and `mnemopi_stats`.
Errors retain MCP `isError` semantics; the `call` mode exits non-zero on thrown
or structured tool errors.

The bundle leaves optional `fastembed` and `onnxruntime-node` external so the
existing OMP runtime cache can load them. No global install or live database
write is performed by this adapter slice.

The adapter is a narrow MCP boundary around the canonical OMP Mnemopi SQLite
store. Native OMP session histories remain separate; this repository does not
copy or manage live databases. `context` resolves settings read-only, while
`mcp` and `call` expose only the six durable-memory tools listed above.

Adapter mutations are journaled in a private JSONL file beside the configured data
directory. The journal contains full before/after note text and hashes so an update
can be reconstructed; native OMP writes and other processes are not covered.
If the journal cannot record an attempt, the mutation is blocked. If a mutation
commits but its outcome cannot be recorded, the caller receives an explicit
`mutation_committed_journal_incomplete` error. Raw recall keeps stock order and
scores but adds evidence labels. Task-scoped recall selection can abstain from
dense-only matches; SessionStart's curated bootstrap is deterministic and does
not apply that query-abstention policy. Review compares private snapshots and
reports changes without pruning or repair.
