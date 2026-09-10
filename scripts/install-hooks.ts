import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

type JsonMap = Record<string, unknown>;
type Host = "claude" | "codex";
interface PlannedWrite { readonly host: Host; readonly file: string; readonly original?: Buffer; readonly next: string; readonly changed: boolean; }

function usage(): never {
	console.error("usage: bun scripts/install-hooks.ts --command /absolute/path/shared-memory [--hosts claude,codex] [--apply]");
	process.exit(2);
}
function argValue(args: readonly string[], key: string): string | undefined {
	const index = args.indexOf(key);
	return index >= 0 ? args[index + 1] : undefined;
}
function map(value: unknown, label: string): JsonMap {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value as JsonMap;
}
function readJson(file: string): JsonMap {
	if (!existsSync(file)) return {};
	try { return map(JSON.parse(readFileSync(file, "utf8")), file); }
	catch (error) { throw new Error(`Cannot parse ${file}: ${String(error)}`); }
}
function sessionGroups(settings: JsonMap, file: string): JsonMap[] {
	if (settings.hooks === undefined) settings.hooks = {};
	const hookMap = map(settings.hooks, `${file}.hooks`);
	if (hookMap.SessionStart === undefined) hookMap.SessionStart = [];
	if (!Array.isArray(hookMap.SessionStart)) throw new Error(`${file}.hooks.SessionStart must be an array`);
	return (hookMap.SessionStart as unknown[]).map((group, index) => map(group, `${file}.hooks.SessionStart[${index}]`));
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function commandToken(value: string): string { return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value); }
function commandExists(groups: readonly JsonMap[], commandText: string): boolean {
	return groups.some(group => Array.isArray(group.hooks) && (group.hooks as unknown[]).some(item =>
		item !== null && typeof item === "object" && !Array.isArray(item) &&
		(item as JsonMap).type === "command" && (item as JsonMap).command === commandText));
}
function plan(host: Host, file: string, command: string): PlannedWrite {
	const original = existsSync(file) ? readFileSync(file) : undefined;
	const settings = readJson(file);
	const groups = sessionGroups(settings, file);
	const commandText = `${commandToken(command)} startup --host ${host}`;
	if (commandExists(groups, commandText)) return { host, file, original, next: original?.toString() ?? `${JSON.stringify(settings, null, 2)}\n`, changed: false };
	// Separate unfiltered group: existing matchers or restrictive settings cannot
	// accidentally apply to the new hook, and existing trust indices stay put.
	const hookMap = map(settings.hooks, `${file}.hooks`);
	(hookMap.SessionStart as unknown[]).push({ hooks: [{ type: "command", command: commandText, timeout: host === "claude" ? 10 : 15 }] });
	return { host, file, original, next: `${JSON.stringify(settings, null, 2)}\n`, changed: true };
}
function backupPath(file: string): string { return `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`; }
function atomicWrite(file: string, content: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	try { writeFileSync(temporary, content, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, file); chmodSync(file, 0o600); }
	finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
}
function validateExecutable(command: string): void {
	try { const info = statSync(command); if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error("not executable"); }
	catch (error) { throw new Error(`--command must name an executable file when applying: ${command} (${String(error)})`); }
}
function applyPlans(plans: readonly PlannedWrite[]): void {
	const changed = plans.filter(item => item.changed);
	const backups = new Map<string, string>();
	try {
		for (const item of changed) if (item.original !== undefined) { const backup = backupPath(item.file); copyFileSync(item.file, backup); chmodSync(backup, 0o600); backups.set(item.file, backup); }
		for (const item of changed) atomicWrite(item.file, item.next);
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const item of changed) try {
			const backup = backups.get(item.file);
			if (backup) atomicWrite(item.file, readFileSync(backup, "utf8"));
			else if (item.original === undefined && existsSync(item.file)) rmSync(item.file, { force: true });
		} catch (rollbackError) { rollbackFailures.push(`${item.file}: ${String(rollbackError)}`); }
		if (rollbackFailures.length > 0) {
			throw new Error(`hook installation rollback incomplete; affected paths: ${rollbackFailures.join("; ")}; original failure: ${String(error)}`);
		}
		throw new Error(`hook installation rolled back after partial-write failure: ${String(error)}`);
	}
}

const args = Bun.argv.slice(2);
const command = argValue(args, "--command");
if (command === undefined || !path.isAbsolute(command)) usage();
const requested = (argValue(args, "--hosts") ?? "claude,codex").split(",").map(value => value.trim()).filter(Boolean);
if (requested.length === 0 || requested.some(host => host !== "claude" && host !== "codex")) usage();
const hosts = requested as Host[];
const apply = args.includes("--apply");
if (apply) validateExecutable(command);
if (!apply) console.error("dry run: no host configuration was changed (pass --apply only after review)");
const home = homedir();
const plans = hosts.map(host => plan(host, host === "claude" ? path.join(home, ".claude", "settings.json") : path.join(home, ".codex", "hooks.json"), command));
for (const item of plans) console.log(`${item.host}: ${item.changed ? "would append" : "already present"} SessionStart command in ${item.file}`);
if (apply) { applyPlans(plans); console.error("Applied without changing existing hook groups. Start a fresh session and trust only this exact command through the host hook review UI."); }
