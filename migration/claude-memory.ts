#!/usr/bin/env bun

/**
 * Exact-content importer for Claude (and unexpected Codex) Markdown memory.
 *
 * The Mnemopi engine is loaded from the vendored OMP source and all writes go
 * through BeamMemory.importFromDict. Inventory is read-only; import requires
 * both --apply and an explicit --data-dir. Runtime use does not read the OMP
 * checkout; its source dependencies are bundled or linked only for builds.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { BeamMemory } from "../adapter/src/vendor/mnemopi/core/beam/index.ts";
import { computeMnemopiBankScope } from "../adapter/src/vendor/omp-config.ts";

type JsonRecord = Record<string, unknown>;
type Classification = "active" | "cold-archive" | "unresolved" | "quarantined" | "failure";

export interface InventoryOptions {
	claudeHome?: string;
	codexHome?: string;
	configuredBank?: string;
	scoping?: "global" | "per-project" | "per-project-tagged";
}

export interface SourceRecord {
	source_path: string;
	canonical_source_path: string;
	source_kind: string;
	source_project_dir?: string;
	bytes: number;
	sha256: string;
	mtime_ms: number;
	mtime: string;
	classification: Classification;
	disposition: "import" | "skip";
	bank: string;
	resolved_cwd?: string;
	resolution?: string;
	memory_id: string;
	archive: boolean;
	historical: boolean;
	secret_like: boolean;
	error?: string;
}

export interface InventoryManifest {
	schema_version: 1;
	generated_at: string;
	tool: "claude-memory-import";
	options: Required<Pick<InventoryOptions, "claudeHome" | "codexHome" | "scoping">> & {
		configuredBank?: string;
	};
	sources: { claude_projects: number; claude_global: number; codex: number };
	counts: Record<string, number>;
	records: SourceRecord[];
}

export interface ImportReport {
	schema_version: 1;
	started_at: string;
	finished_at: string;
	manifest: string;
	data_dir: string;
	counts: Record<string, number>;
	successful: Array<{ source_path: string; memory_id: string; bank: string; bytes: number; sha256: string }>;
	skipped: Array<{ source_path: string; memory_id: string; bank: string; reason: string }>;
	failures: Array<{ source_path: string; memory_id: string; bank: string; reason: string }>;
	unresolved: Array<{ source_path: string; source_project_dir?: string; reason: string; bank: string }>;
}

const DEFAULT_SCOPING = "per-project-tagged" as const;
const IMPORT_SOURCE = "claude-memory-import";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function hashText(value: string): string {
	return sha256(new TextEncoder().encode(value));
}

function now(): string {
	return new Date().toISOString();
}

function canonicalPath(value: string): string {
	return resolve(value);
}

/** Claude's project directory encoding is path separators replaced by '-'. */
export function encodeClaudeProjectPath(projectPath: string): string {
	return [...projectPath.replaceAll("\\", "/")].map(char => /[A-Za-z0-9-]/.test(char) ? char : "-").join("");
}

function shortHash(value: string): string {
	return hashText(value).slice(0, 12);
}

function sharedBank(configuredBank?: string): string {
	return computeMnemopiBankScope(configuredBank, "/", "global").globalBank;
}

function limitBank(value: string): string {
	if (value.length <= 64) return value;
	const hash = Bun.hash(value).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = value.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

/** Use the adapter's bundled OMP scope helper so importer and live clients agree. */
export function projectBank(cwd: string, configuredBank?: string): string {
	return computeMnemopiBankScope(configuredBank, canonicalPath(cwd), "per-project-tagged").retainBank;
}

function archiveBank(cwd: string | undefined, kind: "archive" | "unresolved" | "quarantine"): string {
	if (kind === "unresolved") return limitBank(`claude-archive-unresolved-${shortHash(cwd ?? "unknown")}`);
	if (kind === "quarantine") return "claude-quarantine-secrets";
	return limitBank(`claude-archive-${shortHash(cwd ?? "global")}`);
}

function walkMarkdown(root: string): string[] {
	const result: string[] = [];
	const visit = (directory: string): void => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(canonicalPath(path));
		}
	};
	visit(root);
	return result.sort();
}

function projectDirectories(claudeHome: string): string[] {
	const root = join(claudeHome, "projects");
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.filter(entry => {
				try { return statSync(join(root, entry.name, "memory")).isDirectory(); } catch { return false; }
			})
			.map(entry => canonicalPath(join(root, entry.name)))
			.sort();
	} catch {
		return [];
	}
}

function absolutePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	if (!value.startsWith("/")) return undefined;
	return canonicalPath(value);
}

function addEvidence(target: Map<string, Set<string>>, encodedDir: string, value: unknown): void {
	const path = absolutePath(value);
	if (!path) return;
	const set = target.get(encodedDir) ?? new Set<string>();
	set.add(path);
	target.set(encodedDir, set);
}

function isArchivePath(path: string): boolean {
	const name = basename(path).toLowerCase();
	return name === "archive.md" || name.includes("archive") || name.includes("stale");
}

function secretLike(content: string): boolean {
	if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) return true;
	return /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(content);
}

async function readBytes(path: string): Promise<{ bytes: Uint8Array; sha256: string; mtimeMs: number; mtime: string }> {
	const before = statSync(path);
	const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	const digest = sha256(bytes);
	const after = statSync(path);
	if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("source changed while reading");
	return { bytes, sha256: digest, mtimeMs: after.mtimeMs, mtime: new Date(after.mtimeMs).toISOString() };
}

function sourceId(kind: string, path: string, contentHash: string): string {
	return `claude-import-${hashText(`${kind}\0${path}\0${contentHash}`)}`;
}

function resolveProject(sourceDir: string, evidence: Map<string, Set<string>>): { cwd?: string; reason: string } {
	const name = basename(sourceDir);
	const all = [...new Set(evidence.get(name) ?? [])].sort();
	const exact = all.filter(path => encodeClaudeProjectPath(path) === name);
	if (exact.length === 1) return { cwd: exact[0], reason: "authoritative project metadata with exact Claude encoding" };
	// A leading '-' is the unambiguous encoded form Claude uses for absolute
	// paths. Never decode such a name heuristically.
	if (name.startsWith("-")) {
		if (exact.length === 0) return { reason: "no authoritative project metadata whose Claude encoding matches source directory" };
		return { reason: `ambiguous encoded project metadata (${exact.length} matching paths)` };
	}
	if (all.length === 1) return { cwd: all[0], reason: "single authoritative cwd for friendly project directory" };
	const named = all.filter(candidate => claudeFriendlyProjectName(candidate) === name);
	if (named.length === 1) return { cwd: named[0], reason: "authoritative cwd verified by Claude project-dir namer" };
	const namedRoots = [...new Set(named.map(gitTopLevel).filter((root): root is string => root !== undefined))]
		.filter(root => claudeFriendlyProjectName(root) === name);
	if (namedRoots.length === 1) return { cwd: namedRoots[0], reason: "friendly alias verified by Claude project-dir namer and canonical git root" };
	// Friendly aliases can contain sessions launched from subdirectories. A
	// root is accepted only when metadata identifies it as an existing git root
	// and it is an ancestor (with path-boundary semantics) of every candidate.
	const roots = all.filter(candidate => {
		try { return statSync(join(candidate, ".git"), { throwIfNoEntry: false }) !== undefined; } catch { return false; }
	});
	const rootMatches = roots.filter(root => all.every(candidate => candidate === root || candidate.startsWith(`${root}/`)));
	if (rootMatches.length === 1) return { cwd: rootMatches[0], reason: "friendly alias collapsed to verified metadata git root" };
	return { reason: `ambiguous authoritative project metadata (${all.length} candidate cwds)` };
}

function hasGitMetadata(candidate: string): boolean {
	try { return statSync(join(candidate, ".git"), { throwIfNoEntry: false }) !== undefined; } catch { return false; }
}

function gitTopLevel(candidate: string): string | undefined {
	try {
		const process = Bun.spawnSync(["git", "-C", candidate, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
		if (process.exitCode !== 0) return undefined;
		const root = new TextDecoder().decode(process.stdout).trim();
		return root.startsWith("/") ? canonicalPath(root) : undefined;
	} catch {
		return undefined;
	}
}

/** Use the installed read-only Claude namer when available; never infer names from strings. */
function claudeFriendlyProjectName(candidate: string): string | undefined {
	if (!hasGitMetadata(candidate)) return undefined;
	const command = process.env.CLAUDE_PROJECT_DIR_NAME?.trim() || Bun.which("claude-project-dir-name");
	if (!command) return undefined;
	try {
		const process = Bun.spawnSync([command], { cwd: candidate, stdout: "pipe", stderr: "ignore" });
		if (process.exitCode !== 0) return undefined;
		const value = new TextDecoder().decode(process.stdout).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

function sourceCandidates(claudeHome: string, codexHome: string): Array<{ path: string; kind: string; projectDir?: string }> {
	const candidates: Array<{ path: string; kind: string; projectDir?: string }> = [];
	for (const projectDir of projectDirectories(claudeHome)) {
		const memoryDir = join(projectDir, "memory");
		for (const path of walkMarkdown(memoryDir)) candidates.push({ path, kind: "claude-project-memory", projectDir });
	}
	const globalMemory = join(claudeHome, "MEMORY.md");
	try {
		if (statSync(globalMemory).isFile()) candidates.push({ path: canonicalPath(globalMemory), kind: "claude-global-memory" });
	} catch {}
	const globalRules = join(claudeHome, "rules", "global-memory.md");
	try {
		if (statSync(globalRules).isFile()) candidates.push({ path: canonicalPath(globalRules), kind: "claude-global-rule" });
	} catch {}
	for (const path of walkMarkdown(join(claudeHome, "memory"))) candidates.push({ path, kind: "claude-global-memory-dir" });
	try {
		for (const entry of readdirSync(claudeHome, { withFileTypes: true })) {
			if (entry.name.startsWith("agent-memory") && entry.isDirectory()) {
				for (const path of walkMarkdown(join(claudeHome, entry.name))) candidates.push({ path, kind: "claude-agent-memory" });
			}
		}
	} catch {}
	for (const path of walkMarkdown(join(codexHome, "memories"))) candidates.push({ path, kind: "codex-memory" });
	const deduped = new Map<string, { path: string; kind: string; projectDir?: string }>();
	for (const candidate of candidates) deduped.set(candidate.path, candidate);
	return [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function inventory(options: InventoryOptions = {}): Promise<InventoryManifest> {
	const claudeHome = canonicalPath(options.claudeHome ?? join(homedir(), ".claude"));
	const codexHome = canonicalPath(options.codexHome ?? join(homedir(), ".codex"));
	const scoping = options.scoping ?? DEFAULT_SCOPING;
	const configuredBank = options.configuredBank;
	const evidence = await collectProjectEvidenceAsync(claudeHome);
	const candidates = sourceCandidates(claudeHome, codexHome);
	const records: SourceRecord[] = [];
	let claudeProjects = 0;
	let claudeGlobal = 0;
	let codex = 0;
	for (const candidate of candidates) {
		if (candidate.kind === "codex-memory") codex++;
		else if (candidate.projectDir) claudeProjects++;
		else claudeGlobal++;
		const path = canonicalPath(candidate.path);
		let read;
		try {
			read = await readBytes(path);
		} catch (error) {
			records.push({
				source_path: path,
				canonical_source_path: path,
				source_kind: candidate.kind,
				source_project_dir: candidate.projectDir,
				bytes: 0,
				sha256: "",
				mtime_ms: 0,
				mtime: "",
				classification: "failure",
				disposition: "skip",
				bank: archiveBank(undefined, "unresolved"),
				resolution: "source could not be read",
				memory_id: sourceId(candidate.kind, path, "unreadable"),
				archive: true,
				historical: true,
				secret_like: false,
				error: String(error),
			});
			continue;
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
		} catch {
			records.push({
				source_path: path,
				canonical_source_path: path,
				source_kind: candidate.kind,
				source_project_dir: candidate.projectDir,
				bytes: read.bytes.byteLength,
				sha256: read.sha256,
				mtime_ms: read.mtimeMs,
				mtime: read.mtime,
				classification: "failure",
				disposition: "skip",
				bank: archiveBank(undefined, "unresolved"),
				resolution: "source is not valid UTF-8 Markdown",
				memory_id: sourceId(candidate.kind, path, read.sha256),
				archive: true,
				historical: true,
				secret_like: false,
				error: "invalid UTF-8",
			});
			continue;
		}
		const isIsolatedExternal = candidate.kind === "codex-memory" || candidate.kind.startsWith("claude-agent-memory");
		const isGlobal = !candidate.projectDir && !isIsolatedExternal;
		const project = candidate.projectDir ? resolveProject(candidate.projectDir, evidence) : { cwd: undefined, reason: "global source" };
		const unresolved = isIsolatedExternal || Boolean(candidate.projectDir && !project.cwd);
		const historical = isArchivePath(path) || candidate.kind === "claude-global-memory-dir" && basename(path).toLowerCase().includes("archive");
		const secret = secretLike(content);
		let classification: Classification = "active";
		let bank = "default";
		let resolution = project.reason;
		if (secret) {
			classification = "quarantined";
			bank = archiveBank(project.cwd, "quarantine");
			resolution = "high-confidence secret-like content; isolated quarantine bank";
		} else if (unresolved) {
			classification = "unresolved";
			bank = archiveBank(candidate.projectDir ?? path, "unresolved");
		} else if (historical) {
			classification = "cold-archive";
			bank = archiveBank(project.cwd, "archive");
			resolution = "historical/archive content; excluded from normal recall";
		} else if (isGlobal) {
			bank = sharedBank(configuredBank);
		} else if (project.cwd) {
			bank = scoping === "global" ? "default" : projectBank(project.cwd, configuredBank);
		}
		const archive = classification !== "active";
		records.push({
			source_path: path,
			canonical_source_path: path,
			source_kind: candidate.kind,
			source_project_dir: candidate.projectDir,
			bytes: read.bytes.byteLength,
			sha256: read.sha256,
			mtime_ms: read.mtimeMs,
			mtime: read.mtime,
			classification,
			disposition: secret ? "skip" : "import",
			bank,
			resolved_cwd: project.cwd,
			resolution,
			memory_id: sourceId(candidate.kind, path, read.sha256),
			archive,
			historical: historical || unresolved,
			secret_like: secret,
		});
	}
	const counts: Record<string, number> = {};
	for (const record of records) counts[record.classification] = (counts[record.classification] ?? 0) + 1;
	return {
		schema_version: 1,
		generated_at: now(),
		tool: "claude-memory-import",
		options: { claudeHome, codexHome, configuredBank, scoping },
		sources: { claude_projects: claudeProjects, claude_global: claudeGlobal, codex },
		counts,
		records,
	};
}

/** Async metadata pass; it never parses transcript content fields. */
async function collectProjectEvidenceAsync(claudeHome: string): Promise<Map<string, Set<string>>> {
	const evidence = new Map<string, Set<string>>();
	for (const projectDir of projectDirectories(claudeHome)) {
		const encodedDir = basename(projectDir);
		const entries: unknown[] = [];
		let names: string[] = [];
		try { names = readdirSync(projectDir); } catch { continue; }
		for (const name of names) {
			if (!name.startsWith("sessions-index") || !name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await Bun.file(join(projectDir, name)).text()) as JsonRecord;
				if (Array.isArray(parsed.entries)) entries.push(...parsed.entries);
				addEvidence(evidence, encodedDir, parsed.originalPath);
			} catch {}
		}
		for (const raw of entries) {
			if (!raw || typeof raw !== "object") continue;
			const item = raw as JsonRecord;
			for (const field of ["originalPath", "projectPath", "cwd"]) addEvidence(evidence, encodedDir, item[field]);
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			try {
				for (const line of (await Bun.file(join(projectDir, name)).text()).split("\n")) {
					if (!line.trim()) continue;
					try {
						const item = JSON.parse(line) as JsonRecord;
						for (const field of ["cwd", "projectPath", "project"]) addEvidence(evidence, encodedDir, item[field]);
						if (item.sessionInfo && typeof item.sessionInfo === "object") {
							const session = item.sessionInfo as JsonRecord;
							for (const field of ["cwd", "projectPath"]) addEvidence(evidence, encodedDir, session[field]);
						}
					} catch {}
				}
			} catch {}
		}
	}
	try {
		for (const line of (await Bun.file(join(claudeHome, "history.jsonl")).text()).split("\n")) {
			if (!line.trim()) continue;
			try {
				const item = JSON.parse(line) as JsonRecord;
				for (const field of ["projectPath", "project", "cwd"]) {
					const path = absolutePath(item[field]);
					if (path) addEvidence(evidence, encodeClaudeProjectPath(path), path);
				}
			} catch {}
		}
	} catch {}
	return evidence;
}


function rowFor(record: SourceRecord, content: string, importedAt: string, revisionOf: string[] = []): JsonRecord {
	return {
		id: record.memory_id,
		content,
		source: IMPORT_SOURCE,
		timestamp: record.mtime,
		session_id: record.bank,
		importance: 0.5,
		metadata_json: JSON.stringify({
			source_path: record.canonical_source_path,
			source_sha256: record.sha256,
			source_bytes: record.bytes,
			source_mtime: record.mtime,
			source_mtime_ms: record.mtime_ms,
			source_kind: record.source_kind,
			resolved_cwd: record.resolved_cwd ?? null,
			classification: record.classification,
			historical: record.historical,
			secret_like: record.secret_like,
			imported_at: importedAt,
			consolidated_import: true,
			recall_excluded: record.archive,
			revision_of: revisionOf,
			revision_conflict: revisionOf.length > 0,
		}),
		valid_until: null,
		superseded_by: null,
		scope: "bank",
		veracity: "imported",
		consolidated_at: importedAt,
		memory_type: "claude-memory-markdown",
		trust_tier: "IMPORTED",
	};
}

function dbPathFor(dataDir: string, bank: string): string {
	return bank === "default" ? join(dataDir, "mnemopi.db") : join(dataDir, "banks", bank, "mnemopi.db");
}

async function verifyExisting(beam: any, record: SourceRecord, content: string): Promise<"skip" | "conflict" | "absent"> {
	const row = beam.db.query("SELECT content, metadata_json FROM working_memory WHERE id = ?").get(record.memory_id) as JsonRecord | null;
	if (!row) return "absent";
	if (String(row.content ?? "") !== content) return "conflict";
	try {
		const metadata = JSON.parse(String(row.metadata_json ?? "{}")) as JsonRecord;
		if (metadata.source_sha256 !== record.sha256 || metadata.source_path !== record.canonical_source_path) return "conflict";
	} catch {
		return "conflict";
	}
	return "skip";
}

export async function importManifest(manifest: InventoryManifest, dataDirInput: string, manifestPath = "<manifest>"): Promise<ImportReport> {
	const dataDir = canonicalPath(dataDirInput);
	if (!dataDirInput) throw new Error("--data-dir is required");
	const started = now();
	process.env.MNEMOPI_AUTO_MIGRATE = "0";
	mkdirSync(join(dataDir, "banks"), { recursive: true });
	const beams = new Map<string, any>();
	const successful: ImportReport["successful"] = [];
	const skipped: ImportReport["skipped"] = [];
	const failures: ImportReport["failures"] = [];
	const unresolved: ImportReport["unresolved"] = [];
	for (const record of manifest.records) {
		if (record.classification === "unresolved" || record.classification === "quarantined") unresolved.push({ source_path: record.source_path, source_project_dir: record.source_project_dir, reason: record.resolution ?? record.classification, bank: record.bank });
		if (record.disposition !== "import") continue;
		let read;
		try { read = await readBytes(record.source_path); } catch (error) { failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: String(error) }); continue; }
		if (read.sha256 !== record.sha256 || read.bytes.byteLength !== record.bytes || read.mtimeMs !== record.mtime_ms) {
			failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: "source changed since inventory; no import attempted" });
			continue;
		}
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes); } catch { failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: "invalid UTF-8 source" }); continue; }
		let beam = beams.get(record.bank);
		try {
			if (!beam) {
				const path = dbPathFor(dataDir, record.bank);
				mkdirSync(dirname(path), { recursive: true });
				beam = new BeamMemory({ dbPath: path, sessionId: record.bank, workingMemoryLimit: 0, noEmbeddings: true, llm: false });
				beams.set(record.bank, beam);
			}
			const state = await verifyExisting(beam, record, content);
			if (state === "skip") { skipped.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: "deterministic import already present" }); continue; }
			if (state === "conflict") { failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: "deterministic ID exists with different content or provenance" }); continue; }
			const priorRows = beam.db.query("SELECT id, metadata_json FROM working_memory WHERE source = ?").all(IMPORT_SOURCE) as JsonRecord[];
			const revisionOf: string[] = [];
			for (const prior of priorRows) {
				try {
					const metadata = JSON.parse(String(prior.metadata_json ?? "{}")) as JsonRecord;
					if (metadata.source_path === record.canonical_source_path && metadata.source_sha256 !== record.sha256) revisionOf.push(String(prior.id));
				} catch {}
			}
			if (revisionOf.length > 0) unresolved.push({ source_path: record.source_path, source_project_dir: record.source_project_dir, reason: `source revision conflict; imported as new ID linked to ${revisionOf.join(",")}`, bank: record.bank });
			const importedAt = started;
			beam.importFromDict({ working_memory: [rowFor(record, content, importedAt, revisionOf)] }, false);
			const persisted = await verifyExisting(beam, record, content);
			if (persisted !== "skip") { failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: "post-import content/provenance verification failed" }); continue; }
			successful.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, bytes: record.bytes, sha256: record.sha256 });
		} catch (error) {
			failures.push({ source_path: record.source_path, memory_id: record.memory_id, bank: record.bank, reason: String(error) });
		}
	}
	for (const beam of beams.values()) {
		try { beam.close(); } catch {}
	}
	const counts: Record<string, number> = { successful: successful.length, skipped: skipped.length, failures: failures.length, unresolved: unresolved.length };
	return { schema_version: 1, started_at: started, finished_at: now(), manifest: manifestPath, data_dir: dataDir, counts, successful, skipped, failures, unresolved };
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) continue;
		const [key, inline] = arg.slice(2).split("=", 2);
		if (inline !== undefined) flags.set(key, inline);
		else if (rest[i + 1] && !rest[i + 1].startsWith("--")) flags.set(key, rest[++i]);
		else flags.set(key, true);
	}
	return { command, flags };
}

async function main(): Promise<void> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	if (command === "inventory") {
		const manifest = await inventory({ claudeHome: flags.get("claude-home") as string | undefined, codexHome: flags.get("codex-home") as string | undefined, configuredBank: flags.get("configured-bank") as string | undefined, scoping: (flags.get("scoping") as InventoryOptions["scoping"]) ?? DEFAULT_SCOPING });
		const output = JSON.stringify(manifest, null, 2);
		const path = flags.get("output");
		if (typeof path === "string") await Bun.write(path, output + "\n");
		else console.log(output);
		return;
	}
	if (command === "import") {
		if (flags.get("apply") !== true) throw new Error("import requires explicit --apply");
		const manifestPath = flags.get("manifest");
		const dataDir = flags.get("data-dir");
		if (typeof manifestPath !== "string" || typeof dataDir !== "string") throw new Error("import requires --manifest PATH --data-dir DEST");
		const manifest = JSON.parse(await Bun.file(manifestPath).text()) as InventoryManifest;
		const report = await importManifest(manifest, dataDir, manifestPath);
		const output = JSON.stringify(report, null, 2);
		const reportPath = flags.get("report");
		if (typeof reportPath === "string") await Bun.write(reportPath, output + "\n");
		else console.log(output);
		if (report.failures.length > 0) process.exitCode = 2;
		return;
	}
	console.error("Usage: claude-memory.ts inventory [--output PLAN.json] [--claude-home DIR] [--codex-home DIR]\n       claude-memory.ts import --apply --manifest PLAN.json --data-dir DEST [--report REPORT.json]");
	process.exitCode = 2;
}

if (import.meta.main) await main();
