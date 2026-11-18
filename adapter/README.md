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
shared-memory changelog-install --cwd /absolute/project
```

For host hooks, `startup` is an alias for `session-start` and accepts the host's
JSON stdin. It returns a valid `SessionStart` hook object with `additionalContext`
even when recall is empty or a store is unavailable. Diagnostics belong on stderr.
Injected memories are untrusted data, not instructions. The startup response is
bounded and labels stale or omitted notes; it does not write the OMP database.
Each startup checks the weekly review schedule using only private marker names.
When due, it launches a detached background worker. The worker and the explicit
`review` command share a SQLite lock, so only one review runs at a time.

Change detection uses an in-database change log. The adapter adds two tables,
`adapter_memory_changes` and `adapter_changelog_meta` (version, install id,
pruned-through position), and `adapter_cl1_*` triggers on `working_memory` and
`episodic_memory` in every bank. The triggers record each insert, delete, and
update of `content`, `metadata_json`, `valid_until`, `superseded_by` or
`corrected_by` (never `recall_count`), with the changed column names and the
prior values as JSON. Rows whose source is `coding-agent-transcript` are logged
without content. Because SQLite triggers fire for every connection, native OMP
and external writes are captured too, and they add a small insert to each
memory write. Other mnemopi tables (facts, triples, gists and so on) are not
logged. These are the only objects the adapter writes into a bank, and this
schema write is not journaled. `shared-memory changelog-uninstall` removes
them.

Startup only checks whether the recall banks have the log; if one does not, it
launches a detached `changelog-install`. Each review installs it, inside the
review lock, before reading. A bank that cannot take the log is recorded in
`.adapter-review/changelog-install-failure.json`, and startup waits an hour
before trying again.

Each successful review writes a small private marker (`marker-<ms>-*.json`)
listing every bank it read with that bank's log install id and position. The
next review decides per bank: a bank absent from the previous marker reports
all its rows as added (so does every bank on the first review); a bank whose
log is missing, newly installed, reinstalled, reset, or pruned past the marker
is listed under `baseline` with the reason and has no change detection for that
period; otherwise added, changed (with the changed columns) and missing
memories come from the log. Banks in the previous marker that no longer exist
are listed under `banksRemoved`. After the marker is written, the review prunes
each bank's log through the recorded position, so the prior text of a changed
or deleted memory stays in the bank for at most one review cycle. It also
deletes full-text `snapshot-*.json` files left by earlier versions. Markers are
pruned to the newest 2. Startup reports the schedule and launch status.
Run `shared-memory review` to print the full report. Review never prunes or
repairs memories themselves. Startup reads in two phases: the decision columns of every row,
then content only for the rows it admits.
Admission is decided in JS by parsing metadata with JSON.parse, so metadata has
one reading. Startup keeps a one-year timestamp window for project-scoped rows,
keeps durable global preferences, corrections, and identities regardless of
age (excluding only future-dated ones), reports project rows it omits for the
window, and backs off failed review sweeps with bounded exponential retry.
Callback selection uses the concrete project path.
Startup also reads OMP's sharpshooter decision files for the project and injects
them above the memory index, labeled with the age of the last consolidation.
That block is capped at 6,000 characters and granted its room on top of the
store's budget, so it costs the memory tiers nothing; a file past the cap is
left out whole and counted. The adapter never writes to that directory.

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
existing OMP runtime cache can load them. The only live database write outside
the memory tools is the change log described above.

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
not apply that query-abstention policy. Review reads each bank's change log and
reports changes without pruning or repairing memories.
