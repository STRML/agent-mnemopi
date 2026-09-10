import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { contextForCwd, type AdapterContext } from "./context";
import { journalPath as configuredJournalPath } from "./reliability/journal";

const SNAPSHOT_DIR = ".adapter-review";
const SNAPSHOT_PREFIX = "snapshot-";

export interface ReviewOptions {
	readonly context?: AdapterContext;
	readonly now?: Date | (() => Date);
	readonly writeSnapshot?: boolean;
	/** Fixture-only seam for proving failed writes preserve the prior snapshot. */
	readonly snapshotWriter?: (directory: string, completedAt: string, rows: readonly ReviewRow[], journalPath?: string) => string;
	readonly timeoutMs?: number;
	/** Internal worker mode: write a private stage file; the parent publishes it after success. */
	readonly stageSnapshot?: boolean;
}

export interface ReviewDueResult {
	readonly status: "due" | "not_due" | "error";
	readonly dueDays: number;
	readonly lastSuccessfulSnapshotAt?: string;
	readonly ageDays?: number;
	readonly reason: string;
	readonly snapshotDir: string;
}

export interface ReviewResult {
	readonly status: "ok" | "error";
	readonly due: ReviewDueResult;
	readonly snapshotPath?: string;
	readonly previousSnapshotPath?: string;
	readonly report: {
		readonly banks: readonly string[];
		readonly added: readonly ReviewRow[];
		readonly changed: readonly ReviewChange[];
		readonly missing: readonly ReviewRow[];
		readonly stale: readonly ReviewRow[];
		readonly duplicates: readonly ReviewRow[];
		readonly expired: readonly ReviewRow[];
		readonly superseded: readonly ReviewRow[];
		readonly unresolvedImports: readonly ReviewRow[];
		readonly unjournaledNativeOrExternal: readonly ReviewRow[];
		readonly journalGaps: readonly JournalGap[];
		readonly nativeCoverage: string;
	};
	readonly error?: string;
}

export interface ReviewRow {
	readonly bank: string;
	readonly table: string;
	readonly id: string;
	readonly contentHash: string;
	readonly timestamp?: string | null;
	readonly ageDays?: number | null;
	readonly flags?: readonly string[];
	readonly coverage?: "adapter_journaled" | "unjournaled_native_or_external";
	readonly row: Record<string, unknown>;
}

export interface ReviewChange {
	readonly before: ReviewRow;
	readonly after: ReviewRow;
}

export interface JournalGap {
	readonly kind: "attempt_without_outcome" | "outcome_without_attempt" | "committed_without_outcome";
	readonly operationId: string;
}

interface Snapshot {
	readonly completedAt: string;
	readonly rows: readonly ReviewRow[];
	readonly journalPath?: string;
}

function nowValue(value: ReviewOptions["now"]): Date {
	const date = typeof value === "function" ? value() : value;
	return date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
}

function snapshotDir(context: AdapterContext): string {
	return path.join(context.dataDir, SNAPSHOT_DIR);
}

function ensurePrivateDir(dir: string): void {
	let root = path.parse(path.resolve(dir)).root;
	for (const segment of path.resolve(dir).slice(root.length).split(path.sep).filter(Boolean)) {
		root = path.join(root, segment);
		if (existsSync(root) && lstatSync(root).isSymbolicLink() && !["/tmp", "/private", "/var"].includes(root)) throw new Error(`snapshot path contains symlink component: ${root}`);
	}
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`snapshot directory is symlinked: ${dir}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const info = lstatSync(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`snapshot parent is not a directory: ${dir}`);
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`snapshot parent is not owned by current user: ${dir}`);
	chmodSync(dir, 0o700);
}

function privateSnapshotFile(filePath: string): boolean {
	try {
		const info = lstatSync(filePath);
		return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
	} catch { return false; }
}

function snapshotFiles(dir: string): string[] {
	try {
		if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return [];
		return readdirSync(dir)
			.filter(name => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(".json"))
			.map(name => path.join(dir, name))
			.filter(privateSnapshotFile)
			.sort()
	} catch {
		return [];
	}
}

function loadSnapshot(dir: string): { path?: string; snapshot?: Snapshot } {
	const files = snapshotFiles(dir);
	for (let index = files.length - 1; index >= 0; index -= 1) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(files[index], "utf8"));
			if (parsed !== null && typeof parsed === "object" && typeof (parsed as Snapshot).completedAt === "string" && Array.isArray((parsed as Snapshot).rows)) {
				return { path: files[index], snapshot: parsed as Snapshot };
			}
		} catch {
			// Preserve malformed/old snapshots and continue to the last usable one.
		}
	}
	return {};
}

function dueCheck(context: AdapterContext, dueDays: number, now: Date): ReviewDueResult {
	const dir = snapshotDir(context);
	const last = loadSnapshot(dir);
	if (!last.snapshot) return { status: "due", dueDays, reason: "no successful snapshot exists", snapshotDir: dir };
	const timestamp = Date.parse(last.snapshot.completedAt);
	if (!Number.isFinite(timestamp)) return { status: "due", dueDays, reason: "last snapshot timestamp is invalid", snapshotDir: dir };
	const age = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
	return age >= dueDays
		? { status: "due", dueDays, lastSuccessfulSnapshotAt: last.snapshot.completedAt, ageDays: age, reason: `snapshot age ${age.toFixed(1)} days is at least ${dueDays}`, snapshotDir: dir }
		: { status: "not_due", dueDays, lastSuccessfulSnapshotAt: last.snapshot.completedAt, ageDays: age, reason: `snapshot age ${age.toFixed(1)} days is below ${dueDays}`, snapshotDir: dir };
}

function rowHash(row: Record<string, unknown>): string {
	// The audit keeps the complete row privately, while duplicate detection and
	// content-change reporting intentionally use the canonical content hash.
	return createHash("sha256").update(String(row.content ?? "")).digest("hex");
}

function rowRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function parseMetadata(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch { return {}; }
}

function readRows(bank: string, dbPath: string, now: Date): ReviewRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows: ReviewRow[] = [];
		for (const table of ["working_memory", "episodic_memory"] as const) {
			const exists = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present?: number } | null;
			if (!exists) throw new Error(`store_schema_mismatch (expected ${table})`);
			const values = db.query(`SELECT * FROM ${table}`).all() as unknown[];
			for (const value of values) {
				const row = rowRecord(value);
				const id = String(row.id ?? "");
				if (!id) continue;
				const timestamp = typeof row.timestamp === "string" ? row.timestamp : null;
				const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN;
				const ageDays = Number.isFinite(parsedTimestamp) ? Math.max(0, (now.getTime() - parsedTimestamp) / 86_400_000) : null;
				const validUntil = typeof row.valid_until === "string" ? Date.parse(row.valid_until) : Number.NaN;
				const flags: string[] = [];
				if (ageDays !== null && ageDays >= 30) flags.push("stale");
				if (Number.isFinite(validUntil) && validUntil <= now.getTime()) flags.push("expired");
				if (String(row.superseded_by ?? "").trim()) flags.push("superseded");
				const metadata = parseMetadata(row.metadata_json);
				const imported = String(row.trust_tier ?? "").toLowerCase() === "imported" || String(row.source ?? "").toLowerCase().includes("import");
				if (imported && metadata.import_resolved !== true && metadata.resolved !== true) flags.push("unresolved_import");
				rows.push({ bank, table, id, contentHash: rowHash(row), timestamp, ageDays, flags, row });
			}
		}
		return rows;
	} finally {
		db.close();
	}
}

function journalCandidates(context: AdapterContext): string[] {
	return [
		configuredJournalPath(context.dataDir),
		path.join(context.dataDir, ".adapter-journal.jsonl"),
		path.join(context.dataDir, "adapter-journal.jsonl"),
		path.join(context.dataDir, ".mnemopi-adapter", "journal.jsonl"),
		path.join(context.dataDir, SNAPSHOT_DIR, "journal.jsonl"),
	];
}


function coverageKey(bank: string, table: string, id: string): string {
	return `${bank}:${table}:${id}`;
}

function journalGaps(context: AdapterContext): { path?: string; gaps: JournalGap[]; memoryKeys: Set<string> } {
	const journalPath = journalCandidates(context).find(candidate => existsSync(candidate));
	if (!journalPath) return { gaps: [], memoryKeys: new Set() };
	const attempts = new Set<string>();
	const outcomes = new Set<string>();
	const memoryKeys = new Set<string>();
	try {
		for (const line of readFileSync(journalPath, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			let value: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				value = parsed as Record<string, unknown>;
			} catch {
				continue;
			}
			const operationId = String(value.operation_id ?? value.operationId ?? "");
			if (!operationId) continue;
			const phase = String(value.phase ?? value.kind ?? value.event ?? "").toLowerCase();
			if (phase.includes("attempt")) attempts.add(operationId);
			const outcome = String(value.outcome ?? "").toLowerCase();
			if (phase.includes("outcome") || phase === "success" || phase === "failure" || phase === "committed") outcomes.add(operationId);
			const operation = String(value.operation ?? "").toLowerCase();
			const memoryId = String(value.memory_id ?? "");
			if (phase.includes("outcome") && outcome === "committed" && operation === "remember" && memoryId) {
				memoryKeys.add(coverageKey(String(value.bank ?? "default"), String(value.table ?? "working_memory"), memoryId));
			}
		}
	} catch {
		return { path: journalPath, gaps: [{ kind: "attempt_without_outcome", operationId: "journal_unreadable" }], memoryKeys };
	}
	const gaps: JournalGap[] = [];
	for (const operationId of attempts) if (!outcomes.has(operationId)) gaps.push({ kind: "attempt_without_outcome", operationId });
	for (const operationId of outcomes) if (!attempts.has(operationId)) gaps.push({ kind: "outcome_without_attempt", operationId });
	return { path: journalPath, gaps, memoryKeys };
}

function writeSnapshot(dir: string, completedAt: string, rows: readonly ReviewRow[], journalPath?: string, prefix = SNAPSHOT_PREFIX): string {
	ensurePrivateDir(dir);
	const name = `${prefix}${Date.parse(completedAt)}-${Math.random().toString(36).slice(2)}.json`;
	const target = path.join(dir, name);
	const temporary = `${target}.tmp-${process.pid}`;
	const snapshot: Snapshot = { completedAt, rows, ...(journalPath ? { journalPath } : {}) };
	writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
	chmodSync(temporary, 0o600);
	const fileFd = openSync(temporary, "r");
	try { fsyncSync(fileFd); } finally { closeSync(fileFd); }
	renameSync(temporary, target);
	chmodSync(target, 0o600);
	const dirFd = openSync(dir, "r");
	try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
	return target;
}

function dedupeBanks(context: AdapterContext): string[] {
	const banks = new Set([context.globalBank, ...context.recallBanks]);
	// Explicit review is a store-wide audit. Discover existing bank directories
	// without creating them; startup remains scoped to recallBanks.
	try {
		for (const entry of readdirSync(path.join(context.dataDir, "banks"), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(path.join(context.dataDir, "banks", entry.name, "mnemopi.db"))) banks.add(entry.name);
		}
	} catch {
		// A missing banks directory simply means there are no derived banks.
	}
	return [...banks];
}

function dbPathForBank(context: AdapterContext, bank: string): string {
	if (bank === context.baseBank) return context.dbPath;
	if (bank === "default") return path.join(context.dataDir, "mnemopi.db");
	return path.join(context.dataDir, "banks", bank, "mnemopi.db");
}

function emptyReport(banks: readonly string[], journalGapsValue: readonly JournalGap[] = []): ReviewResult["report"] {
	return { banks, added: [], changed: [], missing: [], stale: [], duplicates: [], expired: [], superseded: [], unresolvedImports: [], unjournaledNativeOrExternal: [], journalGaps: journalGapsValue, nativeCoverage: "Adapter journal is not universal; native OMP and external writes appear as unjournaled snapshot changes." };
}

export function reviewDue(cwd: string, dueDays = 7, options: ReviewOptions = {}): ReviewDueResult {
	const context = options.context ?? contextForCwd(path.resolve(cwd));
	return dueCheck(context, Math.max(1, dueDays), nowValue(options.now));
}

export function review(cwd: string, dueDays = 7, options: ReviewOptions = {}): ReviewResult {
	const context = options.context ?? contextForCwd(path.resolve(cwd));
	const now = nowValue(options.now);
	const startedAt = Date.now();
	const due = dueCheck(context, Math.max(1, dueDays), now);
	const banks = dedupeBanks(context);
	const previous = loadSnapshot(snapshotDir(context));
	const current: ReviewRow[] = [];
	try {
		for (const bank of banks) {
			const dbPath = dbPathForBank(context, bank);
			if (!existsSync(dbPath)) {
				if (bank === context.baseBank) throw new Error(`store_missing bank=${bank} dbPath=${dbPath} configFiles=${context.configFiles.join(",") || "(none)"}`);
				continue;
			}
			if (!statSync(dbPath).isFile()) throw new Error(`store_unavailable bank=${bank} dbPath=${dbPath} configFiles=${context.configFiles.join(",") || "(none)"}`);
			current.push(...readRows(bank, dbPath, now));
		}
		const journal = journalGaps(context);
		const oldByKey = new Map((previous.snapshot?.rows ?? []).map(row => [`${row.bank}:${row.table}:${row.id}`, row]));
		const currentByKey = new Map(current.map(row => [`${row.bank}:${row.table}:${row.id}`, row]));
		const added: ReviewRow[] = [];
		const changed: ReviewChange[] = [];
		for (const [key, row] of currentByKey) {
			const before = oldByKey.get(key);
			if (!before) added.push(row);
			else if (before.contentHash !== row.contentHash) changed.push({ before, after: row });
		}
		const missing: ReviewRow[] = [];
		for (const [key, row] of oldByKey) if (!currentByKey.has(key)) missing.push(row);
		const byHash = new Map<string, ReviewRow[]>();
		for (const row of current) byHash.set(row.contentHash, [...(byHash.get(row.contentHash) ?? []), row]);
		const duplicates = [...byHash.values()].filter(group => group.length > 1).flat();
		const report = {
			banks,
			added,
			changed,
			missing,
			stale: current.filter(row => row.flags?.includes("stale")),
			duplicates,
			expired: current.filter(row => row.flags?.includes("expired")),
			superseded: current.filter(row => row.flags?.includes("superseded")),
			unresolvedImports: current.filter(row => row.flags?.includes("unresolved_import")),
			unjournaledNativeOrExternal: added.filter(row => !journal.memoryKeys.has(coverageKey(row.bank, row.table, row.id))).map(row => ({ ...row, coverage: "unjournaled_native_or_external" as const })),
			journalGaps: journal.gaps,
			nativeCoverage: "Adapter journal is not universal; native OMP and external writes appear as unjournaled snapshot changes.",
		};
		if (options.timeoutMs !== undefined && Date.now() - startedAt > options.timeoutMs) throw new Error(`review_timeout after ${Date.now() - startedAt}ms`);
		const shouldWrite = options.writeSnapshot !== false;
		const stageSnapshot = options.stageSnapshot === true || process.env.MNEMOPI_REVIEW_STAGE === "1";
		const snapshotPath = shouldWrite
			? (options.snapshotWriter ?? ((dir, completedAt, rows, journalPath) => writeSnapshot(dir, completedAt, rows, journalPath, stageSnapshot ? ".stage-" : SNAPSHOT_PREFIX)))(snapshotDir(context), now.toISOString(), current, journal.path)
			: undefined;
		return { status: "ok", due, snapshotPath, previousSnapshotPath: previous.path, report };
	} catch (error) {
		return { status: "error", due, previousSnapshotPath: previous.path, report: emptyReport(banks), error: String(error) };
	}
}
