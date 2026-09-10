import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const apply = Bun.argv.includes("--run");
const root = path.resolve(import.meta.dir, "..");
const bundleIndex = Bun.argv.indexOf("--bundle");
const bundleArg = bundleIndex >= 0 ? Bun.argv[bundleIndex + 1] : undefined;
const bundle = bundleArg && !bundleArg.startsWith("--")
	? path.resolve(bundleArg)
	: path.join(root, "adapter", "dist", "shared-memory.js");
if (!apply) {
	console.log("dry run: no host session or database will be touched");
	console.log("run `bun scripts/hook-smoke.ts --run` after building to exercise a clean fixture hook");
	process.exit(0);
}

if (!Bun.file(bundle).size) throw new Error(`missing bundle ${bundle}; run ` + "`bun run build` first");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "mnemopi-hook-smoke-"));
const agentDir = path.join(fixtureRoot, "agent");
const dataDir = path.join(fixtureRoot, "data");
mkdirSync(agentDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(agentDir, "config.yml"), [
	"memory:",
	"  backend: mnemopi",
	"mnemopi:",
	`  dbPath: ${path.join(dataDir, "mnemopi.db")}`,
	"  scoping: global",
	"  noEmbeddings: true",
	"",
].join("\n"));

try {
	const input = JSON.stringify({ session_id: "fixture-hook", cwd: fixtureRoot, source: "hook-smoke" });
	const proc = Bun.spawn([process.execPath, bundle, "startup", "--host", "codex"], {
		cwd: fixtureRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(`${input}\n`);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`hook exited ${exitCode}: ${stderr.trim()}`);
	const payload = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown } };
	if (payload.hookSpecificOutput?.hookEventName !== "SessionStart") throw new Error("hook event name was not SessionStart");
	if (typeof payload.hookSpecificOutput.additionalContext !== "string") throw new Error("hook additionalContext was not a string");
	console.log("clean fixture hook smoke passed; no host settings or live database were opened");
} finally {
	rmSync(fixtureRoot, { recursive: true, force: true });
}
