import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// An append-only log of memory changes kept inside each bank. SQLite triggers
// write it, so every writer is captured: this adapter, native OMP retention and
// consolidation, and any external tool. The weekly review reads it, then prunes
// it through the position it recorded, so prior text lives at most one cycle.

export const CHANGE_LOG_TABLE = "adapter_memory_changes";
export const CHANGE_LOG_META_TABLE = "adapter_changelog_meta";
export const CHANGE_LOG_VERSION = 1;
const TRIGGER_PREFIX = "adapter_cl";
const TRIGGER_NAME = `${TRIGGER_PREFIX}${CHANGE_LOG_VERSION}`;
// Native OMP (packages/coding-agent/src/mnemopi/state.ts) writes whole session
// transcripts under this source. Their prior text is never copied into the log.
const TRANSCRIPT_SOURCE = "coding-agent-transcript";
export const TRACKED_COLUMNS = ["content", "metadata_json", "valid_until", "superseded_by", "corrected_by"] as const;
const MEMORY_TABLES = [
	{ table: "working_memory", short: "wm" },
	{ table: "episodic_memory", short: "em" },
] as const;

export type ChangeOp = "insert" | "update" | "delete";

export interface ChangeEntry {
	readonly seq: number;
	readonly changedAt: string;
	readonly op: ChangeOp;
	readonly memoryTable: string;
	readonly memoryId: string;
	readonly source: string | null;
	/** Tracked columns an update changed; empty for insert and delete. */
	readonly columns: readonly string[];
	readonly oldRow: Record<string, unknown> | null;
}

export interface LogState {
	readonly present: boolean;
	readonly version: number | null;
	readonly installId: string | null;
	readonly prunedThrough: number;
	readonly maxSeq: number;
}

export interface ChangeLogResult<S extends string> {
	readonly status: S;
	readonly error?: string;
}

function tableColumns(db: Database, table: string): string[] {
	return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);
}

function existingTables(db: Database): { table: string; short: string; columns: string[] }[] {
	return MEMORY_TABLES.map(entry => ({ ...entry, columns: tableColumns(db, entry.table) })).filter(entry => entry.columns.length > 0);
}

function expectedTriggers(tables: readonly { short: string }[]): string[] {
	return tables.flatMap(({ short }) => ["ins", "upd", "del"].map(kind => `${TRIGGER_NAME}_${short}_${kind}`));
}

function objectExists(db: Database, type: "table" | "trigger", name: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== null;
}

function metaValue(db: Database, key: string): string | null {
	if (!objectExists(db, "table", CHANGE_LOG_META_TABLE)) return null;
	const row = db.query(`SELECT value FROM ${CHANGE_LOG_META_TABLE} WHERE key = ?`).get(key) as { value: string } | null;
	return row?.value ?? null;
}

export function readLogState(db: Database): LogState {
	const hasLog = objectExists(db, "table", CHANGE_LOG_TABLE);
	const versionText = metaValue(db, "version");
	const version = versionText === null ? null : Number(versionText);
	const tables = existingTables(db);
	const present = hasLog && tableColumns(db, CHANGE_LOG_TABLE).includes("columns") && version === CHANGE_LOG_VERSION && tables.length > 0 && expectedTriggers(tables).every(name => objectExists(db, "trigger", name));
	return {
		present,
		version: Number.isFinite(version) ? version : null,
		installId: metaValue(db, "install_id"),
		prunedThrough: Number(metaValue(db, "pruned_through") ?? 0) || 0,
		maxSeq: maxSeq(db),
	};
}

export function changeLogPresent(db: Database): boolean {
	return readLogState(db).present;
}

function transcriptCheck(prefix: "OLD" | "NEW", columns: readonly string[]): string {
	return columns.includes("source") ? `${prefix}.source = '${TRANSCRIPT_SOURCE}'` : "0";
}

function oldRowExpression(columns: readonly string[], maskWhen: string): string {
	const pairs: string[] = [];
	for (const column of TRACKED_COLUMNS) {
		if (!columns.includes(column)) continue;
		const value = column === "content" ? `CASE WHEN ${maskWhen} THEN NULL ELSE OLD.content END` : `OLD.${column}`;
		pairs.push(`'${column}', ${value}`);
	}
	for (const column of ["source", "timestamp"]) if (columns.includes(column)) pairs.push(`'${column}', OLD.${column}`);
	return `json_object(${pairs.join(", ")})`;
}

function triggerStatements(table: string, short: string, columns: readonly string[]): string[] {
	const newSource = columns.includes("source") ? "NEW.source" : "NULL";
	const oldSource = columns.includes("source") ? "OLD.source" : "NULL";
	const tracked = TRACKED_COLUMNS.filter(column => columns.includes(column));
	const insertInto = `INSERT INTO ${CHANGE_LOG_TABLE} (op, memory_table, memory_id, source, columns, old_row)`;
	const statements = [
		`CREATE TRIGGER ${TRIGGER_NAME}_${short}_ins AFTER INSERT ON ${table} BEGIN ${insertInto} VALUES ('insert', '${table}', NEW.id, ${newSource}, NULL, NULL); END`,
		`CREATE TRIGGER ${TRIGGER_NAME}_${short}_del AFTER DELETE ON ${table} BEGIN ${insertInto} VALUES ('delete', '${table}', OLD.id, ${oldSource}, NULL, ${oldRowExpression(columns, transcriptCheck("OLD", columns))}); END`,
	];
	if (tracked.length > 0) {
		const changedList = tracked.map(column => `CASE WHEN OLD.${column} IS NOT NEW.${column} THEN '${column},' ELSE '' END`).join(" || ");
		const changedAny = tracked.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
		const mask = `(${transcriptCheck("OLD", columns)} OR ${transcriptCheck("NEW", columns)})`;
		statements.push(`CREATE TRIGGER ${TRIGGER_NAME}_${short}_upd AFTER UPDATE OF ${tracked.join(", ")} ON ${table} WHEN ${changedAny} BEGIN ${insertInto} VALUES ('update', '${table}', NEW.id, ${newSource}, rtrim(${changedList}, ','), ${oldRowExpression(columns, mask)}); END`);
	}
	return statements;
}

function isBusy(error: unknown): boolean {
	const text = String(error);
	return text.includes("database is locked") || text.includes("SQLITE_BUSY");
}

function openWritable(dbPath: string, busyTimeoutMs: number | undefined): Database {
	const db = new Database(dbPath, { create: false, readwrite: true });
	db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs ?? 5000))}`);
	return db;
}

function inWriteTransaction<S extends string>(dbPath: string, busyTimeoutMs: number | undefined, work: (db: Database) => S | undefined, skipped?: (db: Database) => S | undefined): ChangeLogResult<S | "busy" | "missing" | "error"> {
	if (!existsSync(dbPath)) return { status: "missing" };
	let db: Database | undefined;
	try {
		db = openWritable(dbPath, busyTimeoutMs);
		const early = skipped?.(db);
		if (early) return { status: early };
		db.exec("BEGIN IMMEDIATE");
		try {
			const status = work(db) as S;
			db.exec("COMMIT");
			return { status };
		} catch (error) {
			try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
			throw error;
		}
	} catch (error) {
		return isBusy(error) ? { status: "busy", error: String(error) } : { status: "error", error: String(error) };
	} finally {
		db?.close();
	}
}

function dropTriggers(db: Database): void {
	const names = db.query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRIGGER_PREFIX}%'`).all() as { name: string }[];
	for (const { name } of names) db.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
}

/**
 * Installs (or upgrades) the log. An upgrade replaces the triggers and keeps the
 * table, its rows and the install identity, so review cursors stay valid.
 */
export function installChangeLog(dbPath: string, options: { busyTimeoutMs?: number } = {}): ChangeLogResult<"installed" | "present" | "busy" | "missing" | "error"> {
	return inWriteTransaction(dbPath, options.busyTimeoutMs, db => {
		const tables = existingTables(db);
		if (tables.length === 0) throw new Error("store_schema_mismatch (no memory tables)");
		db.exec(`CREATE TABLE IF NOT EXISTS ${CHANGE_LOG_TABLE} (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			op TEXT NOT NULL,
			memory_table TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			source TEXT,
			columns TEXT,
			old_row TEXT
		)`);
		// A table from before the columns field gets it added in place, before any
		// trigger that writes it exists.
		if (!tableColumns(db, CHANGE_LOG_TABLE).includes("columns")) db.exec(`ALTER TABLE ${CHANGE_LOG_TABLE} ADD COLUMN columns TEXT`);
		db.exec(`CREATE TABLE IF NOT EXISTS ${CHANGE_LOG_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		dropTriggers(db);
		for (const { table, short, columns } of tables) for (const statement of triggerStatements(table, short, columns)) db.exec(statement);
		db.run(`INSERT OR IGNORE INTO ${CHANGE_LOG_META_TABLE} (key, value) VALUES ('install_id', ?)`, [randomUUID()]);
		db.run(`INSERT OR IGNORE INTO ${CHANGE_LOG_META_TABLE} (key, value) VALUES ('pruned_through', '0')`);
		db.run(`INSERT OR REPLACE INTO ${CHANGE_LOG_META_TABLE} (key, value) VALUES ('version', ?)`, [String(CHANGE_LOG_VERSION)]);
		return "installed";
	}, db => (changeLogPresent(db) ? "present" : undefined));
}

/** Deletes log rows through `throughSeq` and raises the pruned-through watermark. */
export function pruneChanges(dbPath: string, throughSeq: number, options: { busyTimeoutMs?: number } = {}): ChangeLogResult<"pruned" | "absent" | "busy" | "missing" | "error"> {
	return inWriteTransaction(dbPath, options.busyTimeoutMs, db => {
		db.run(`DELETE FROM ${CHANGE_LOG_TABLE} WHERE seq <= ?`, [throughSeq]);
		db.run(`UPDATE ${CHANGE_LOG_META_TABLE} SET value = CAST(MAX(CAST(value AS INTEGER), ?) AS TEXT) WHERE key = 'pruned_through'`, [throughSeq]);
		return "pruned";
	}, db => (objectExists(db, "table", CHANGE_LOG_TABLE) && objectExists(db, "table", CHANGE_LOG_META_TABLE) ? undefined : "absent"));
}

/** Removes every object the adapter added to a bank. */
export function uninstallChangeLog(dbPath: string, options: { busyTimeoutMs?: number } = {}): ChangeLogResult<"uninstalled" | "absent" | "busy" | "missing" | "error"> {
	return inWriteTransaction(dbPath, options.busyTimeoutMs, db => {
		dropTriggers(db);
		db.exec(`DROP TABLE IF EXISTS ${CHANGE_LOG_TABLE}`);
		db.exec(`DROP TABLE IF EXISTS ${CHANGE_LOG_META_TABLE}`);
		return "uninstalled";
	}, db => {
		const any = db.query(`SELECT 1 FROM sqlite_master WHERE name LIKE 'adapter_cl%' OR name IN ('${CHANGE_LOG_TABLE}', '${CHANGE_LOG_META_TABLE}')`).get();
		return any ? undefined : "absent";
	});
}

function parseOldRow(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch { return null; }
}

export function readChanges(db: Database, afterSeq: number): ChangeEntry[] {
	if (!objectExists(db, "table", CHANGE_LOG_TABLE)) return [];
	const rows = db.query(`SELECT seq, changed_at, op, memory_table, memory_id, source, columns, old_row FROM ${CHANGE_LOG_TABLE} WHERE seq > ? ORDER BY seq`).all(afterSeq) as Record<string, unknown>[];
	return rows.map(row => ({
		seq: Number(row.seq),
		changedAt: String(row.changed_at),
		op: row.op as ChangeOp,
		memoryTable: String(row.memory_table),
		memoryId: String(row.memory_id),
		source: typeof row.source === "string" ? row.source : null,
		columns: typeof row.columns === "string" && row.columns.length > 0 ? row.columns.split(",") : [],
		oldRow: parseOldRow(row.old_row),
	}));
}

export function maxSeq(db: Database): number {
	if (!objectExists(db, "table", CHANGE_LOG_TABLE)) return 0;
	// AUTOINCREMENT keeps counting past pruned rows, so read the sequence table
	// rather than MAX(seq), which drops to 0 once every row is pruned.
	const fromSequence = db.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(CHANGE_LOG_TABLE) as { seq: number } | null;
	const fromRows = db.query(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${CHANGE_LOG_TABLE}`).get() as { seq: number };
	return Math.max(Number(fromSequence?.seq ?? 0), Number(fromRows.seq));
}
