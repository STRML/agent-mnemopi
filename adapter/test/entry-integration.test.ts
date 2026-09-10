import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
