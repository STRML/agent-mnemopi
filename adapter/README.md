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
`isError` behavior. The suite never opens the live OMP DB.

Modes:

```sh
shared-memory context --cwd /absolute/project
shared-memory mcp --cwd /absolute/project
shared-memory call mnemopi_recall '{"query":"...","bank":"exact-bank"}' --cwd /absolute/project
```

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

Known limits: tool calls are explicit and do not automatically inject recall
into host prompts; retrieval scores are not calibrated confidence values and
there is no general abstention threshold; SQLite writes are mutable rather than
an append-only audit trail; and no automatic retention sweep or maintenance
scheduler is included.
