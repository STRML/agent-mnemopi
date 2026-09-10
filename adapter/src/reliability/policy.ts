import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_FILENAME, dataDir } from "../vendor/mnemopi/config";

export type ReliabilityErrorCode = "store_missing" | "store_unavailable" | "store_schema_mismatch" | "journal_unavailable";

export interface StoreProvenance {
	readonly dbPath: string;
	readonly bank: string;
	readonly baseBank: string;
	readonly baseDbPath: string;
	readonly configFiles: readonly string[];
}

export class ReliabilityError extends Error {
	readonly code: ReliabilityErrorCode;
	readonly provenance: StoreProvenance;
	constructor(code: ReliabilityErrorCode, message: string, provenance: StoreProvenance) {
		super(message);
		this.name = "ReliabilityError";
		this.code = code;
		this.provenance = provenance;
	}
	toResult(): Record<string, unknown> {
		return { status: "error", error: this.code, message: this.message, db_path: this.provenance.dbPath, bank: this.provenance.bank, config_files: [...this.provenance.configFiles], base_db_path: this.provenance.baseDbPath, base_bank: this.provenance.baseBank };
	}
}

export interface StoreResolution {
	readonly dbPath: string;
	readonly dataDir: string;
	readonly bank: string;
	readonly baseBank: string;
	readonly baseDbPath: string;
	readonly configFiles: readonly string[];
}
export interface PreflightOptions {
	readonly dbPath: string;
	readonly bank: string;
	readonly baseBank?: string;
	readonly baseDbPath?: string;
	readonly configFiles?: readonly string[];
}
export interface PreflightSuccess { readonly ok: true; readonly exists: true; readonly provenance: StoreProvenance; }
export type PreflightResult = PreflightSuccess | { readonly ok: false; readonly error: ReliabilityError };
const EXPECTED_TABLES = ["working_memory", "episodic_memory"] as const;

function configuredFiles(): readonly string[] {
	return (process.env.MNEMOPI_CONFIG_FILES ?? process.env.MNEMOPI_CONFIG_FILE ?? "").split(/[;,]/).map(value => value.trim()).filter(Boolean);
}
function provenance(options: PreflightOptions): StoreProvenance {
	return { dbPath: options.dbPath, bank: options.bank, baseBank: options.baseBank ?? process.env.MNEMOPI_BASE_BANK ?? "default", baseDbPath: options.baseDbPath ?? process.env.MNEMOPI_BASE_DB_PATH ?? options.dbPath, configFiles: options.configFiles ?? configuredFiles() };
}
function fail(code: ReliabilityErrorCode, message: string, options: PreflightOptions): PreflightResult {
	return { ok: false, error: new ReliabilityError(code, message, provenance(options)) };
}

/** Verify a resolved store without invoking Beam (which creates/migrates missing files). */
export function preflightStore(options: PreflightOptions): PreflightResult {
	const details = provenance(options);
	if (!existsSync(options.dbPath)) return fail("store_missing", `Resolved Mnemopi store is missing: ${options.dbPath}`, options);
	try {
		if (!statSync(options.dbPath).isFile()) return fail("store_unavailable", `Resolved Mnemopi store is not a file: ${options.dbPath}`, options);
		accessSync(options.dbPath, constants.R_OK);
	} catch (error) {
		return fail("store_unavailable", `Resolved Mnemopi store is unreadable: ${options.dbPath} (${String(error)})`, options);
	}
	let db: Database | undefined;
	try {
		db = new Database(options.dbPath, { create: false, readwrite: false, strict: true });
		const rows = db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>;
		const tables = new Set(rows.map(row => row.name));
		const missing = EXPECTED_TABLES.filter(table => !tables.has(table));
		if (missing.length > 0) return fail("store_schema_mismatch", `Resolved store is not a Mnemopi database; missing tables: ${missing.join(", ")}`, options);
		const malformed = EXPECTED_TABLES.filter(table => {
			const columns = new Set((db as Database).query(`PRAGMA table_info(${table})`).all().map((row: unknown) => (row as { name?: unknown }).name));
			return !columns.has("id") || !columns.has("content");
		});
		if (malformed.length > 0) return fail("store_schema_mismatch", `Resolved store has incomplete Mnemopi tables: ${malformed.join(", ")}`, options);
		return { ok: true, exists: true, provenance: details };
	} catch (error) {
		return fail("store_unavailable", `Resolved Mnemopi store cannot be opened read-only: ${options.dbPath} (${String(error)})`, options);
	} finally {
		try { db?.close(); } catch { /* best effort */ }
	}
}
export function throwPreflight(result: PreflightResult): asserts result is PreflightSuccess { if (!result.ok) throw result.error; }

function configuredBaseDbPath(): string { return process.env.MNEMOPI_BASE_DB_PATH ?? join(dataDir(), DEFAULT_DB_FILENAME); }
/** Resolve the same bank paths used by the adapter, without creating folders. */
export function resolveStore(bank: string): StoreResolution {
	const configuredDataDir = dataDir();
	const baseBank = process.env.MNEMOPI_BASE_BANK ?? "default";
	const baseDbPath = configuredBaseDbPath();
	const dbPath = bank === baseBank ? baseDbPath : join(configuredDataDir, "banks", bank, DEFAULT_DB_FILENAME);
	return { dbPath, dataDir: configuredDataDir, bank, baseBank, baseDbPath, configFiles: configuredFiles() };
}
export function preflightResolvedStore(store: StoreResolution): PreflightResult { return preflightStore(store); }
export function preflightCanonicalStore(store: StoreResolution): PreflightResult {
	return preflightStore({ dbPath: store.baseDbPath, bank: store.baseBank, baseBank: store.baseBank, baseDbPath: store.baseDbPath, configFiles: store.configFiles });
}

export type RecallStore = { readonly kind: "ready"; readonly store: StoreResolution } | { readonly kind: "empty_derived"; readonly store: StoreResolution } | { readonly kind: "error"; readonly error: ReliabilityError };
/** Missing derived banks are an empty recall scope; canonical stores are not. */
export function prepareRecallStore(bank: string): RecallStore {
	const store = resolveStore(bank);
	if (!existsSync(store.dbPath) && bank !== store.baseBank) {
		const base = preflightCanonicalStore(store);
		if (!base.ok) return { kind: "error", error: base.error };
		return { kind: "empty_derived", store };
	}
	const checked = preflightResolvedStore(store);
	return checked.ok ? { kind: "ready", store } : { kind: "error", error: checked.error };
}
export type MutationStore = { readonly kind: "ready"; readonly store: StoreResolution; readonly created: boolean } | { readonly kind: "error"; readonly error: ReliabilityError };
/** Only an explicit derived bank may be created, and only after base validation. */
export function prepareMutationStore(bank: string): MutationStore {
	const store = resolveStore(bank);
	if (bank !== store.baseBank) {
		const base = preflightCanonicalStore(store);
		if (!base.ok) return { kind: "error", error: base.error };
	}
	if (existsSync(store.dbPath)) {
		const checked = preflightResolvedStore(store);
		return checked.ok ? { kind: "ready", store, created: false } : { kind: "error", error: checked.error };
	}
	if (bank === store.baseBank) {
		const checked = preflightCanonicalStore(store);
		return { kind: "error", error: checked.ok ? new ReliabilityError("store_missing", `Resolved canonical Mnemopi store is missing: ${store.dbPath}`, store) : checked.error };
	}
	return { kind: "ready", store, created: true };
}

export type RecallCandidate = Record<string, unknown> & { readonly id: string };
export type RecallEvidence = "metadata_exact" | "query_lexical" | "dense_only" | "no_query_evidence";
// Recall callbacks may prepend natural-language framing (for example,
// "session startup") to a concrete project path. These words should not be
// allowed to turn a positive lexical score into evidence by themselves.
const LEXICAL_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "in", "is", "it", "its",
	"of", "on", "or", "that", "the", "their", "there", "this", "to", "was", "were", "with", "you", "your",
	"exists", "list", "session", "startup",
]);

function metadataValue(result: RecallCandidate, key: "task_key" | "cwd"): string | undefined {
	const direct = result[key];
	if (typeof direct === "string") return direct;
	const metadata = result.metadata;
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		const value = (metadata as Record<string, unknown>)[key];
		return typeof value === "string" ? value : undefined;
	}
	if (typeof metadata === "string") {
		try {
			const parsed = JSON.parse(metadata) as Record<string, unknown>;
			return typeof parsed[key] === "string" ? parsed[key] as string : undefined;
		} catch {
			/* malformed metadata is not evidence */
		}
	}
	return undefined;
}

function queryTokens(query: string): string[] {
	return query.toLowerCase().split(/[^a-z0-9_/-]+/).filter(token => token.length > 1 && !LEXICAL_STOPWORDS.has(token));
}

function isTokenCharacter(value: string | undefined): boolean {
	return value !== undefined && /[a-z0-9_/-]/i.test(value);
}

/** Match a query token as a complete token, not as a substring of another word/path. */
function hasTokenBoundary(text: string, token: string): boolean {
	let offset = 0;
	while (offset < text.length) {
		const index = text.indexOf(token, offset);
		if (index < 0) return false;
		const before = index > 0 ? text[index - 1] : undefined;
		const afterIndex = index + token.length;
		const after = afterIndex < text.length ? text[afterIndex] : undefined;
		if (!isTokenCharacter(before) && !isTokenCharacter(after)) return true;
		offset = index + 1;
	}
	return false;
}

function evidenceFor(query: string, result: RecallCandidate): RecallEvidence {
	if (query.length > 0 && (["task_key", "cwd"] as const).some(key => metadataValue(result, key) === query)) return "metadata_exact";
	const keyword = typeof result.keyword_score === "number" && Number.isFinite(result.keyword_score) && result.keyword_score > 0;
	const fts = typeof result.fts_score === "number" && Number.isFinite(result.fts_score) && result.fts_score > 0;
	const text = typeof result.content === "string" ? result.content.toLocaleLowerCase() : typeof result.embed_text === "string" ? result.embed_text.toLocaleLowerCase() : "";
	const tokens = queryTokens(query);
	const queryTextMatch = tokens.length > 0 && tokens.some(token => hasTokenBoundary(text, token));
	if ((keyword || fts) && queryTextMatch) return "query_lexical";
	if (typeof result.dense_score === "number" && Number.isFinite(result.dense_score) && result.dense_score > 0) return "dense_only";
	return "no_query_evidence";
}
export interface InjectableRecallSelected { readonly status: "selected"; readonly results: readonly RecallCandidate[]; }
export interface InjectableRecallAbstained { readonly status: "abstained"; readonly reason: "no_query_specific_evidence"; readonly results: readonly []; }
export type InjectableRecall = InjectableRecallSelected | InjectableRecallAbstained;
/** Select only exact metadata or query-derived lexical/FTS evidence for startup injection. */
export function selectInjectableRecall(query: string, results: readonly RecallCandidate[]): InjectableRecall {
	const selected = results.map(result => ({ result, evidence: evidenceFor(query, result) })).filter(item => item.evidence === "metadata_exact" || item.evidence === "query_lexical").map(item => ({ ...item.result, evidence: item.evidence, evidence_label: item.evidence }));
	return selected.length > 0 ? { status: "selected", results: selected } : { status: "abstained", reason: "no_query_specific_evidence", results: [] };
}
export function annotateRecallResults(query: string, results: readonly RecallCandidate[]): { readonly status: "ok" | "no_useful_match"; readonly results: readonly RecallCandidate[]; readonly score_is_not_confidence: true } {
	const annotated = results.map(result => {
		const evidence = evidenceFor(query, result);
		return { ...result, evidence, evidence_label: evidence, score_is_not_confidence: true };
	});
	const useful = annotated.some(result => result.evidence === "metadata_exact" || result.evidence === "query_lexical");
	return { status: useful ? "ok" : "no_useful_match", results: annotated, score_is_not_confidence: true };
}
