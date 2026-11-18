import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { pruneChanges, readChanges, readLogState, TRACKED_COLUMNS, type ChangeEntry } from "./changelog";
import { contextForCwd, type AdapterContext } from "./context";
import { resolveBankDbPath } from "./reliability/bank-path";
import { journalPath as configuredJournalPath } from "./reliability/journal";

const SNAPSHOT_DIR = ".adapter-review";
// Legacy full-text snapshots from before the change log. Their names still count
// for the due check; the first successful review deletes them.
const SNAPSHOT_PREFIX = "snapshot-";
const MARKER_PREFIX = "marker-";
// The newest marker is the baseline; the second is a fallback if it cannot be read.
const KEEP_MARKERS = 2;
const NATIVE_COVERAGE = "The change log in each bank captures every writer (adapter, native OMP, external). Banks in changeLogMissing and banks listed under baseline have no change detection for this period.";

export type BaselineReason = "log_missing" | "log_installed" | "log_reinstalled" | "sequence_reset" | "pruned_past_cursor" | "invalid_cursor";

export interface ReviewOptions {
	readonly context?: AdapterContext;
	readonly now?: Date | (() => Date);
	/** false reports without writing a marker, pruning the log, or retiring snapshots. */
	readonly writeMarker?: boolean;
	/** Fixture-only seam for proving a failed marker write keeps the prior marker and the log. */
	readonly markerWriter?: (directory: string, completedAt: string, payload: ReviewMarker) => string;
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
	readonly markerPath?: string;
	readonly previousMarkerPath?: string;
	readonly report: {
		/** Banks whose changes this period could not be read from the log, and why. */
		readonly baseline: readonly { bank: string; reason: BaselineReason }[];
		readonly changeLogMissing: readonly string[];
		/** Banks in the previous marker that no longer exist. */
		readonly banksRemoved: readonly string[];
		/** Banks whose log could not be pruned this time (retried next review). */
		readonly pruneSkipped: readonly string[];
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
	/** The tracked columns as they were at the previous review. */
	readonly before: ReviewRow;
	readonly after: ReviewRow;
	/** Tracked columns that changed since the previous review. */
	readonly columns: readonly string[];
}

export interface JournalGap {
	readonly kind: "attempt_without_outcome" | "outcome_without_attempt" | "committed_without_outcome";
	readonly operationId: string;
}

export interface MarkerBank {
	readonly installId: string | null;
	readonly seq: number;
}

export interface ReviewMarker {
	readonly completedAt: string;
	readonly banks: Record<string, MarkerBank>;
}

interface LoadedMarker {
	readonly path: string;
	readonly completedAt: string;
	/** A bank whose entry is malformed maps to undefined: known, but no usable cursor. */
	readonly banks: Map<string, MarkerBank | undefined>;
}

function nowValue(value: ReviewOptions["now"]): Date {
	const date = typeof value === "function" ? value() : value;
	return date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
}

function snapshotDir(context: AdapterContext): string {
	return path.join(context.dataDir, SNAPSHOT_DIR);
}

export function ensurePrivateDir(dir: string): void {
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
	return prefixedFiles(dir, SNAPSHOT_PREFIX);
}

function markerFiles(dir: string): string[] {
	return prefixedFiles(dir, MARKER_PREFIX);
}

function pruneOldest(files: readonly string[], keep: number): void {
	for (const file of files.slice(0, Math.max(0, files.length - keep))) {
		try { unlinkSync(file); } catch { /* A file another review already removed is fine. */ }
	}
}

function validMarkerBank(value: unknown): MarkerBank | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	const installId = entry.installId;
	if (installId !== null && typeof installId !== "string") return undefined;
	if (typeof entry.seq !== "number" || !Number.isSafeInteger(entry.seq) || entry.seq < 0) return undefined;
	return { installId, seq: entry.seq };
}

function loadMarker(dir: string): LoadedMarker | undefined {
	const files = markerFiles(dir);
	for (let index = files.length - 1; index >= 0; index -= 1) {
		try {
			const parsed = JSON.parse(readFileSync(files[index], "utf8")) as Record<string, unknown>;
			const banks = parsed.banks;
			if (typeof parsed.completedAt !== "string" || banks === null || typeof banks !== "object" || Array.isArray(banks)) continue;
			const map = new Map<string, MarkerBank | undefined>();
			for (const [bank, value] of Object.entries(banks as Record<string, unknown>)) map.set(bank, validMarkerBank(value));
			return { path: files[index], completedAt: parsed.completedAt, banks: map };
		} catch { /* Skip an unreadable marker and use an older one. */ }
	}
	return undefined;
}

function prefixedFiles(dir: string, prefix: string): string[] {
	try {
		if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return [];
		return readdirSync(dir)
			.filter(name => name.startsWith(prefix) && name.endsWith(".json"))
			.map(name => path.join(dir, name))
			.filter(privateSnapshotFile)
			.sort()
	} catch {
		return [];
	}
}

function dueCheck(context: AdapterContext, dueDays: number, now: Date): ReviewDueResult {
	const dir = snapshotDir(context);
	let timestamp: number | undefined;
	for (const file of [...snapshotFiles(dir), ...markerFiles(dir)]) {
		const match = /^(?:snapshot|marker)-(\d+)-[A-Za-z0-9]+\.json$/.exec(path.basename(file));
		if (!match) continue;
		const value = Number(match[1]);
		if (!Number.isFinite(value) || value > now.getTime() + 300_000) continue;
		if (timestamp === undefined || value > timestamp) timestamp = value;
	}
	if (timestamp === undefined) return { status: "due", dueDays, reason: "no successful snapshot exists", snapshotDir: dir };
	const lastSuccessfulSnapshotAt = new Date(timestamp).toISOString();
	const age = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
	return age >= dueDays
		? { status: "due", dueDays, lastSuccessfulSnapshotAt, ageDays: age, reason: `snapshot age ${age.toFixed(1)} days is at least ${dueDays}`, snapshotDir: dir }
		: { status: "not_due", dueDays, lastSuccessfulSnapshotAt, ageDays: age, reason: `snapshot age ${age.toFixed(1)} days is below ${dueDays}`, snapshotDir: dir };
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

function readRows(bank: string, db: Database, now: Date): ReviewRow[] {
	{
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

function writePrivateJson(dir: string, prefix: string, completedAt: string, payload: unknown): string {
	ensurePrivateDir(dir);
	const name = `${prefix}${Date.parse(completedAt)}-${Math.random().toString(36).slice(2)}.json`;
	const target = path.join(dir, name);
	const temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
	chmodSync(temporary, 0o600);
	const fileFd = openSync(temporary, "r");
	try { fsyncSync(fileFd); } finally { closeSync(fileFd); }
	renameSync(temporary, target);
	try {
		chmodSync(target, 0o600);
		const dirFd = openSync(dir, "r");
		try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
	} catch { /* The rename already committed the private file. */ }
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

export function listBanks(context: AdapterContext): { bank: string; dbPath: string }[] {
	return dedupeBanks(context).map(bank => ({ bank, dbPath: dbPathForBank(context, bank) })).filter(entry => existsSync(entry.dbPath));
}

function dbPathForBank(context: AdapterContext, bank: string): string {
	return resolveBankDbPath({ dataDir: context.dataDir, baseBank: context.baseBank, baseDbPath: context.dbPath }, bank);
}

function emptyReport(banks: readonly string[], journalGapsValue: readonly JournalGap[] = []): ReviewResult["report"] {
	return { baseline: [], changeLogMissing: [], banksRemoved: [], pruneSkipped: [], banks, added: [], changed: [], missing: [], stale: [], duplicates: [], expired: [], superseded: [], unresolvedImports: [], unjournaledNativeOrExternal: [], journalGaps: journalGapsValue, nativeCoverage: NATIVE_COVERAGE };
}

export function reviewDue(cwd: string, dueDays = 7, options: ReviewOptions = {}): ReviewDueResult {
	const context = options.context ?? contextForCwd(path.resolve(cwd));
	return dueCheck(context, Math.max(1, dueDays), nowValue(options.now));
}

type Prior =
	| { readonly kind: "first_review" }
	| { readonly kind: "new_bank" }
	| { readonly kind: "known"; readonly entry: MarkerBank | undefined };

interface BankRead {
	readonly bank: string;
	readonly dbPath: string;
	readonly present: boolean;
	readonly installId: string | null;
	readonly maxSeq: number;
	readonly rows: ReviewRow[];
	/** Every row is new to the review: the first review, or a bank absent from the last marker. */
	readonly allAdded: boolean;
	readonly baseline?: BaselineReason;
	readonly entries?: readonly ChangeEntry[];
}

function baselineReason(present: boolean, state: { installId: string | null; maxSeq: number; prunedThrough: number }, entry: MarkerBank | undefined): BaselineReason | undefined {
	if (!present) return "log_missing";
	if (entry === undefined) return "invalid_cursor";
	if (entry.installId === null) return "log_installed";
	if (entry.installId !== state.installId) return "log_reinstalled";
	if (state.maxSeq < entry.seq) return "sequence_reset";
	if (state.prunedThrough > entry.seq) return "pruned_past_cursor";
	return undefined;
}

function readBank(bank: string, dbPath: string, now: Date, prior: Prior): BankRead {
	const db = new Database(dbPath, { readonly: true });
	try {
		// One read transaction, so the log position and the rows describe the same moment.
		db.exec("BEGIN");
		const state = readLogState(db);
		const rows = readRows(bank, db, now);
		const base = { bank, dbPath, present: state.present, installId: state.present ? state.installId : null, maxSeq: state.present ? state.maxSeq : 0, rows };
		if (prior.kind !== "known") return { ...base, allAdded: true };
		const baseline = baselineReason(state.present, state, prior.entry);
		if (baseline || !prior.entry) return { ...base, allAdded: false, baseline };
		const entries = readChanges(db, prior.entry.seq).filter(entry => entry.seq <= state.maxSeq);
		return { ...base, allAdded: false, entries };
	} finally {
		try { db.exec("COMMIT"); } catch { /* no open transaction */ }
		db.close();
	}
}

function rowBeforeChange(bank: string, entry: ChangeEntry): ReviewRow {
	const row = { ...(entry.oldRow ?? {}), id: entry.memoryId };
	const timestamp = typeof row.timestamp === "string" ? row.timestamp : null;
	return { bank, table: entry.memoryTable, id: entry.memoryId, contentHash: rowHash(row), timestamp, row };
}

function changedColumns(entries: readonly ChangeEntry[], before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	const changed = new Set<string>();
	for (const entry of entries) if (entry.op === "update") for (const column of entry.columns) changed.add(column);
	if (entries.some(entry => entry.op === "delete")) {
		// Deleted and recreated under the same id: compare what was there with what is there now.
		for (const column of TRACKED_COLUMNS) {
			if (!(column in before)) continue;
			if (column === "content" && before.content === null) { changed.add(column); continue; } // transcript text is never logged
			if ((before[column] ?? null) !== (after[column] ?? null)) changed.add(column);
		}
	}
	return TRACKED_COLUMNS.filter(column => changed.has(column));
}

// The first log entry for a memory since the last review holds its state at that
// review, so the net change is that entry against the current row.
function bankDiff(read: BankRead, out: { added: ReviewRow[]; changed: ReviewChange[]; missing: ReviewRow[] }): void {
	if (read.allAdded) { out.added.push(...read.rows); return; }
	if (!read.entries) return;
	const current = new Map(read.rows.map(row => [`${row.table}:${row.id}`, row]));
	const groups = new Map<string, ChangeEntry[]>();
	for (const entry of read.entries) {
		const key = `${entry.memoryTable}:${entry.memoryId}`;
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	for (const [key, entries] of groups) {
		const now = current.get(key);
		const first = entries[0];
		if (first.op === "insert") { if (now) out.added.push(now); continue; }
		const before = rowBeforeChange(read.bank, first);
		if (!now) { out.missing.push(before); continue; }
		const columns = changedColumns(entries, before.row, now.row);
		if (columns.length > 0) out.changed.push({ before, after: now, columns });
	}
}

function writeMarker(dir: string, completedAt: string, payload: ReviewMarker): string {
	return writePrivateJson(dir, MARKER_PREFIX, completedAt, payload);
}

export function review(cwd: string, dueDays = 7, options: ReviewOptions = {}): ReviewResult {
	const context = options.context ?? contextForCwd(path.resolve(cwd));
	const now = nowValue(options.now);
	const due = dueCheck(context, Math.max(1, dueDays), now);
	const banks = dedupeBanks(context);
	const dir = snapshotDir(context);
	const marker = loadMarker(dir);
	try {
		const reads: BankRead[] = [];
		for (const bank of banks) {
			const dbPath = dbPathForBank(context, bank);
			if (!existsSync(dbPath)) {
				if (bank === context.baseBank) throw new Error(`store_missing bank=${bank} dbPath=${dbPath} configFiles=${context.configFiles.join(",") || "(none)"}`);
				continue;
			}
			if (!statSync(dbPath).isFile()) throw new Error(`store_unavailable bank=${bank} dbPath=${dbPath} configFiles=${context.configFiles.join(",") || "(none)"}`);
			const prior: Prior = !marker ? { kind: "first_review" } : marker.banks.has(bank) ? { kind: "known", entry: marker.banks.get(bank) } : { kind: "new_bank" };
			reads.push(readBank(bank, dbPath, now, prior));
		}
		const current = reads.flatMap(read => read.rows);
		const diff = { added: [] as ReviewRow[], changed: [] as ReviewChange[], missing: [] as ReviewRow[] };
		for (const read of reads) bankDiff(read, diff);
		const reviewed = new Set(reads.map(read => read.bank));
		const journal = journalGaps(context);
		const byHash = new Map<string, ReviewRow[]>();
		for (const row of current) byHash.set(row.contentHash, [...(byHash.get(row.contentHash) ?? []), row]);
		const duplicates = [...byHash.values()].filter(group => group.length > 1).flat();
		const pruneSkipped: string[] = [];
		const report = {
			baseline: reads.flatMap(read => (read.baseline ? [{ bank: read.bank, reason: read.baseline }] : [])),
			changeLogMissing: reads.filter(read => !read.present).map(read => read.bank),
			banksRemoved: marker ? [...marker.banks.keys()].filter(bank => !reviewed.has(bank)).sort() : [],
			pruneSkipped,
			banks,
			added: diff.added,
			changed: diff.changed,
			missing: diff.missing,
			stale: current.filter(row => row.flags?.includes("stale")),
			duplicates,
			expired: current.filter(row => row.flags?.includes("expired")),
			superseded: current.filter(row => row.flags?.includes("superseded")),
			unresolvedImports: current.filter(row => row.flags?.includes("unresolved_import")),
			unjournaledNativeOrExternal: diff.added.filter(row => !journal.memoryKeys.has(coverageKey(row.bank, row.table, row.id))).map(row => ({ ...row, coverage: "unjournaled_native_or_external" as const })),
			journalGaps: journal.gaps,
			nativeCoverage: NATIVE_COVERAGE,
		};
		if (options.writeMarker === false) return { status: "ok", due, previousMarkerPath: marker?.path, report };
		const completedAt = now.toISOString();
		const payload: ReviewMarker = { completedAt, banks: Object.fromEntries(reads.map(read => [read.bank, { installId: read.installId, seq: read.maxSeq }])) };
		// The marker is the commit point: only after it is durable is the log pruned
		// through the positions it records, and the legacy snapshots retired.
		const markerPath = (options.markerWriter ?? writeMarker)(dir, completedAt, payload);
		pruneOldest(snapshotFiles(dir), 0);
		pruneOldest(markerFiles(dir), KEEP_MARKERS);
		for (const read of reads) {
			if (read.present && pruneChanges(read.dbPath, read.maxSeq).status !== "pruned") pruneSkipped.push(read.bank);
		}
		return { status: "ok", due, markerPath, previousMarkerPath: marker?.path, report };
	} catch (error) {
		return { status: "error", due, previousMarkerPath: marker?.path, report: emptyReport(banks), error: String(error) };
	}
}
