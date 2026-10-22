import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const bundle = process.env.ADAPTER_BUNDLE?.trim() || path.join(repoRoot, "adapter", "dist", "shared-memory.js");

async function run(bundleArgs: readonly string[], input: string | undefined, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
	const child = Bun.spawn([process.execPath, bundle, ...bundleArgs], { cwd: repoRoot, env: { ...process.env, ...env }, stdin: input === undefined ? undefined : "pipe", stdout: "pipe", stderr: "pipe" });
	if (input !== undefined) { child.stdin.write(`${input}\n`); child.stdin.end(); }
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, out, err };
}

describe("entrypoint hook contract", () => {
	it("returns valid hook JSON when stdin is malformed", async () => {
		const result = await run(["startup", "--host", "codex"], "{bad", {});
		expect(result.code).toBe(1);
		const payload = JSON.parse(result.out) as Record<string, unknown>;
		expect((payload.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe("SessionStart");
		expect((payload.hookSpecificOutput as Record<string, unknown>).additionalContext).toBeString();
		expect(payload.systemMessage).toBeString();
	});

	it("fails startup on a bare --host instead of dropping the harness gate", async () => {
		const result = await run(["startup", "--host"], JSON.stringify({ cwd: repoRoot }), {});
		expect(result.code).toBe(1);
		const payload = JSON.parse(result.out) as Record<string, unknown>;
		expect(payload.systemMessage).toContain("--host needs a harness name");
	});

	it("reports a missing fixture store through a valid startup response", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-entry-hook-"));
		const agent = path.join(root, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(path.join(agent, "config.yml"), ["mnemopi:", `  dbPath: ${path.join(root, "data", "mnemopi.db")}`, "  scoping: global", "  noEmbeddings: true", ""].join("\n"));
		try {
			const result = await run(["startup", "--host", "codex"], JSON.stringify({ cwd: root, source: "fixture" }), { PI_CODING_AGENT_DIR: agent });
			expect(result.code).toBe(0);
			const payload = JSON.parse(result.out) as Record<string, unknown>;
			expect(payload.systemMessage).toContain("store_missing");
			expect((payload.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe("SessionStart");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("makes explicit review failures non-zero", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-entry-review-"));
		const agent = path.join(root, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(path.join(agent, "config.yml"), ["mnemopi:", `  dbPath: ${path.join(root, "data", "mnemopi.db")}`, "  scoping: global", "  noEmbeddings: true", ""].join("\n"));
		try {
			const result = await run(["review", "--cwd", root], undefined, { PI_CODING_AGENT_DIR: agent });
			expect(result.code).toBe(1);
			expect(JSON.parse(result.out).status).toBe("error");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("background review sweep", () => {
	function collect(stream: NodeJS.ReadableStream): Promise<string> {
		return new Promise((resolve, reject) => {
			let text = "";
			stream.on("data", chunk => { text += String(chunk); });
			stream.on("end", () => resolve(text));
			stream.on("error", reject);
		});
	}

	function waitForLockFree(lockPath: string): void {
		const probe = new Database(lockPath, { create: true });
		try {
			probe.exec("PRAGMA busy_timeout = 30000");
			probe.exec("BEGIN EXCLUSIVE");
			probe.exec("ROLLBACK");
		} finally { probe.close(); }
	}

	function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
		return Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`${what} did not finish within ${ms}ms`); })]);
	}

	it("returns from the startup hook while the sweep waits, and the sweep outlives the hook's process group", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-entry-sweep-"));
		const agent = path.join(root, "agent");
		const data = path.join(root, "data");
		const reviewDir = path.join(data, ".adapter-review");
		const lockPath = path.join(reviewDir, "review.lock");
		const snapshots = (): string[] => readdirSync(reviewDir).filter(name => name.startsWith("snapshot-") && name.endsWith(".json"));
		mkdirSync(agent, { recursive: true });
		mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(agent, "config.yml"), ["mnemopi:", `  dbPath: ${path.join(data, "mnemopi.db")}`, "  scoping: global", "  noEmbeddings: true", ""].join("\n"));
		const store = new Database(path.join(data, "mnemopi.db"), { create: true });
		store.exec("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, metadata_json TEXT, memory_type TEXT); CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, timestamp TEXT, metadata_json TEXT);");
		store.close();
		// Barrier: the worker waits on this lock, so the hook is checked while its sweep is still pending.
		const barrier = new Database(lockPath, { create: true });
		barrier.exec("BEGIN EXCLUSIVE");
		let released = false;
		const release = (): void => { if (released) return; released = true; barrier.exec("ROLLBACK"); barrier.close(); };
		try {
			const hook = spawn(process.execPath, [bundle, "startup", "--host", "claude"], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
			hook.stdin.end(`${JSON.stringify({ cwd: root, source: "fixture" })}\n`);
			const exited = new Promise<number | null>(resolve => hook.on("exit", code => resolve(code)));
			// Claude Code waits for the hook's stdout to close; a worker holding it open would block here.
			const [out, err, code] = await within(Promise.all([collect(hook.stdout), collect(hook.stderr), exited]), 5000, "startup hook");
			expect(code).toBe(0);
			expect(err).toBe("");
			expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("sweep started in background");
			expect(snapshots()).toEqual([]);
			// A host that kills the hook's process group must not take the sweep with it.
			try { process.kill(-(hook.pid as number), "SIGKILL"); } catch { /* the group is already empty */ }
			release();
			const deadline = Date.now() + 20_000;
			while (snapshots().length === 0 && Date.now() < deadline) await Bun.sleep(100);
			expect(snapshots().length).toBe(1);
			waitForLockFree(lockPath);
			// The worker's attempt record is cleared once the sweep succeeds.
			expect(existsSync(path.join(reviewDir, "review-failure.json"))).toBe(false);
		} finally {
			release();
			// Reap on every path, assertion failures included, before the fixture is removed.
			waitForLockFree(lockPath);
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("portable hook installer", () => {
	it("is dry-run by default even when an ambient apply flag is set and writes isolated fixtures only", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-hook-install-"));
		const home = path.join(root, "home");
		mkdirSync(path.join(home, ".claude"), { recursive: true });
		mkdirSync(path.join(home, ".codex"), { recursive: true });
		const claude = path.join(home, ".claude", "settings.json");
		const codex = path.join(home, ".codex", "hooks.json");
		const initial = JSON.stringify({ hooks: { SessionStart: [{ matcher: "restrictive", hooks: [{ type: "command", command: "existing" }] }] } }, null, 2) + "\n";
		writeFileSync(claude, initial); writeFileSync(codex, initial);
		try {
			const dry = Bun.spawn([process.execPath, path.join(repoRoot, "scripts/install-hooks.ts"), "--command", "/bin/sh"], { env: { ...process.env, HOME: home, MNEMOPI_INSTALL_APPLY: "1" }, stdout: "pipe", stderr: "pipe" });
			const [out, code] = await Promise.all([new Response(dry.stdout).text(), dry.exited]);
			expect(code).toBe(0);
			expect(out).toContain("would append");
			expect(readFileSync(claude, "utf8")).toBe(initial);
			expect(readFileSync(codex, "utf8")).toBe(initial);
			expect(existsSync(path.join(home, ".claude", "settings.json.bak"))).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rolls back an earlier host when a later host cannot be written", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-hook-rollback-"));
		const home = path.join(root, "home");
		const claudeDir = path.join(home, ".claude");
		const codexDir = path.join(home, ".codex");
		mkdirSync(claudeDir, { recursive: true }); mkdirSync(codexDir, { recursive: true });
		const claude = path.join(claudeDir, "settings.json");
		const initial = JSON.stringify({ hooks: { SessionStart: [] } }) + "\n";
		writeFileSync(claude, initial);
		// The installer plans both files before writing; this directory makes only
		// the second atomic replacement fail, exercising rollback of Claude.
		const codex = path.join(codexDir, "hooks.json");
		writeFileSync(codex, initial);
		chmodSync(codexDir, 0o500);
		try {
			const child = Bun.spawn([process.execPath, path.join(repoRoot, "scripts/install-hooks.ts"), "--command", "/bin/sh", "--apply"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
			const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
			expect(code).toBe(1);
			expect(err).toContain("rollback");
			expect(readFileSync(claude, "utf8")).toBe(initial);
		} finally { chmodSync(codexDir, 0o700); rmSync(root, { recursive: true, force: true }); }
	});
});
