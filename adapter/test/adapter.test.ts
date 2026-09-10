import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";

const adapterRoot = path.resolve(import.meta.dir, "..");
const bundlePath = path.join(adapterRoot, "dist", "shared-memory.js");

interface Fixture {
	root: string;
	agentDir: string;
	dataDir: string;
	dbPath: string;
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "shared-memory-adapter-"));
	const agentDir = path.join(root, "agent");
	const dataDir = path.join(root, "data");
	const dbPath = path.join(dataDir, "mnemopi.db");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "config.yml"),
		["memory:", "  backend: mnemopi", "mnemopi:", `  dbPath: ${dbPath}`, "  scoping: global", "  noEmbeddings: true", "  embeddingModel: BAAI/bge-base-en-v1.5", ""].join("\n"),
	);
	return { root, agentDir, dataDir, dbPath };
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(fx: Fixture, args: readonly string[], input?: string): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, bundlePath, ...args], {
		cwd: fx.root,
		env: { ...process.env, PI_CODING_AGENT_DIR: fx.agentDir },
		stdin: input === undefined ? undefined : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (input !== undefined) {
		proc.stdin.write(input);
		proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function json(result: RunResult): Record<string, unknown> {
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

function dbRows(fx: Fixture): Array<{ id: string; content: string; timestamp: string; trust_tier: string }> {
	const db = new Database(fx.dbPath, { readonly: true });
	try {
		return db
			.query("SELECT id, content, timestamp, trust_tier FROM working_memory ORDER BY created_at, id")
			.all() as Array<{ id: string; content: string; timestamp: string; trust_tier: string }>;
	} finally {
		db.close();
	}
}

function ageRows(fx: Fixture, ids: readonly string[]): void {
	const db = new Database(fx.dbPath);
	try {
		for (const id of ids) db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", id]);
	} finally {
		db.close();
	}
}

describe("shared-memory adapter bundle", () => {
	it("returns exact persisted content and supports get/update", async () => {
		const fx = fixture();
		try {
			const stored = json(await run(fx, ["call", "mnemopi_remember", JSON.stringify({ content: "exact persisted adapter phrase", bank: "default", source: "test", metadata: { test: true } }), "--cwd", fx.root]));
			expect(stored.status).toBe("stored");
			expect(stored.content).toBe("exact persisted adapter phrase");
			const id = stored.memory_id as string;
			expect(id).toMatch(/^[0-9a-f]+$/);

			const fetched = json(await run(fx, ["call", "mnemopi_get", JSON.stringify({ memory_id: id, bank: "default" }), "--cwd", fx.root]));
			expect((fetched.memory as Record<string, unknown>).content).toBe("exact persisted adapter phrase");
			const updated = json(await run(fx, ["call", "mnemopi_update", JSON.stringify({ memory_id: id, content: "exact updated phrase", bank: "default" }), "--cwd", fx.root]));
			expect(updated.status).toBe("updated");
			const missing = await run(fx, ["call", "mnemopi_update", JSON.stringify({ memory_id: "missing-memory", content: "should fail", bank: "default" }), "--cwd", fx.root]);
			expect(missing.exitCode).toBe(1);
			expect(json(missing).status).toBe("not_found");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("keeps aged native and IMPORTED rows when adapter writes follow", async () => {
		const fx = fixture();
		try {
			const native = json(await run(fx, ["call", "mnemopi_remember", JSON.stringify({ content: "aged native row", bank: "default", source: "conversation" }), "--cwd", fx.root]));
			const durable = json(await run(fx, ["call", "mnemopi_remember", JSON.stringify({ content: "aged imported row", bank: "default", source: "claude" }), "--cwd", fx.root]));
			ageRows(fx, [native.memory_id as string, durable.memory_id as string]);
			const fresh = await run(fx, ["call", "mnemopi_remember", JSON.stringify({ content: "subsequent adapter row", bank: "default" }), "--cwd", fx.root]);
			expect(fresh.exitCode).toBe(0);
			const rows = dbRows(fx);
			expect(rows.map(row => row.content)).toEqual(expect.arrayContaining(["aged native row", "aged imported row", "subsequent adapter row"]));
			expect(rows.find(row => row.content === "subsequent adapter row")?.trust_tier).toBe("IMPORTED");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("supports concurrent independent writer processes on one bank", async () => {
		const fx = fixture();
		try {
			// Initialize the empty SQLite schema before racing independent
			// processes; live OMP banks are pre-existing and this isolates the
			// concurrent-write property from first-open journal setup.
			const seed = await run(fx, ["call", "mnemopi_remember", JSON.stringify({ content: "concurrency seed", bank: "default" }), "--cwd", fx.root]);
			expect(seed.exitCode).toBe(0);
			const results = await Promise.all(
				["concurrent writer one", "concurrent writer two"].map(content =>
					run(fx, ["call", "mnemopi_remember", JSON.stringify({ content, bank: "default" }), "--cwd", fx.root]),
				),
			);
			if (results.some(result => result.exitCode !== 0)) throw new Error(JSON.stringify(results));
			expect(dbRows(fx).map(row => row.content)).toEqual(expect.arrayContaining(["concurrent writer one", "concurrent writer two"]));
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("emits MCP isError for invalid tool arguments", async () => {
		const fx = fixture();
		try {
			const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mnemopi_stats", arguments: {} } });
			const result = await run(fx, ["mcp", "--cwd", fx.root], `${request}\n`);
			expect(result.exitCode).toBe(0);
			const response = JSON.parse(result.stdout.trim()) as { result?: { isError?: boolean } };
			expect(response.result?.isError).toBe(true);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});
});
