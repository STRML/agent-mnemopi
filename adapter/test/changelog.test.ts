import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANGE_LOG_VERSION, changeLogPresent, installChangeLog, maxSeq, pruneChanges, readChanges, readLogState, uninstallChangeLog } from "../src/changelog";

const schema = readFileSync(path.join(import.meta.dir, "fixtures", "bank-schema.sql"), "utf8");
const roots: string[] = [];

function makeBank(customSchema = schema): string {
	const root = mkdtempSync(path.join(tmpdir(), "mnemopi-changelog-"));
	roots.push(root);
	const dbPath = path.join(root, "mnemopi.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(customSchema);
	db.close();
	return dbPath;
}

function insert(db: Database, id: string, content: string, source = "claude"): void {
	db.run("INSERT INTO working_memory (id, content, source, timestamp) VALUES (?, ?, ?, ?)", [id, content, source, "2026-11-18T00:00:00Z"]);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("change log", () => {
	it("installs once and reports present after", () => {
		const dbPath = makeBank();
		expect(installChangeLog(dbPath).status).toBe("installed");
		expect(installChangeLog(dbPath).status).toBe("present");
		const db = new Database(dbPath);
		expect(changeLogPresent(db)).toBe(true);
		db.close();
	});

	it("logs insert, content update, delete", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "v1");
		db.run("UPDATE working_memory SET content = 'v2' WHERE id = 'm1'");
		db.run("DELETE FROM working_memory WHERE id = 'm1'");
		const changes = readChanges(db, 0);
		expect(changes.map(change => change.op)).toEqual(["insert", "update", "delete"]);
		expect(changes.every(change => change.memoryTable === "working_memory" && change.memoryId === "m1")).toBe(true);
		expect(changes[0].oldRow).toBeNull();
		expect(changes[1].oldRow?.content).toBe("v1");
		expect(changes[2].oldRow?.content).toBe("v2");
		expect(maxSeq(db)).toBe(changes[2].seq);
		expect(readChanges(db, changes[1].seq).map(change => change.op)).toEqual(["delete"]);
		db.close();
	});

	it("ignores recall_count and last_recalled updates", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "v1");
		const before = maxSeq(db);
		db.run("UPDATE working_memory SET recall_count = recall_count + 1, last_recalled = ? WHERE id = 'm1'", ["2026-11-18T01:00:00Z"]);
		expect(maxSeq(db)).toBe(before);
		db.close();
	});

	it("logs validity changes made without touching content", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "v1");
		db.run("UPDATE working_memory SET valid_until = ? WHERE id = 'm1'", ["2026-11-18T02:00:00Z"]);
		const last = readChanges(db, 0).at(-1);
		expect(last?.op).toBe("update");
		expect(last?.oldRow?.valid_until).toBeNull();
		expect(last?.oldRow?.content).toBe("v1");
		db.close();
	});

	it("omits transcript content", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "t1", "whole session text", "coding-agent-transcript");
		db.run("UPDATE working_memory SET content = 'longer session text' WHERE id = 't1'");
		db.run("DELETE FROM working_memory WHERE id = 't1'");
		const [, update, remove] = readChanges(db, 0);
		expect(update.oldRow?.content).toBeNull();
		expect(remove.oldRow?.content).toBeNull();
		expect(remove.source).toBe("coding-agent-transcript");
		db.close();
	});

	it("logs episodic_memory changes", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		db.run("INSERT INTO episodic_memory (id, content, source, timestamp) VALUES ('e1', 'ep', 'sleep_consolidation', '2026-11-18T00:00:00Z')");
		db.run("DELETE FROM episodic_memory WHERE id = 'e1'");
		const changes = readChanges(db, 0);
		expect(changes.map(change => `${change.memoryTable}:${change.op}`)).toEqual(["episodic_memory:insert", "episodic_memory:delete"]);
		expect(changes[1].oldRow?.content).toBe("ep");
		db.close();
	});

	it("keeps FTS in sync", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "alpha");
		db.run("UPDATE working_memory SET content = 'bravo' WHERE id = 'm1'");
		const hits = db.query("SELECT id FROM fts_working WHERE fts_working MATCH 'bravo'").all() as { id: string }[];
		expect(hits.map(hit => hit.id)).toEqual(["m1"]);
		db.close();
	});

	it("returns busy under a held write lock", () => {
		const dbPath = makeBank();
		const holder = new Database(dbPath);
		holder.exec("BEGIN IMMEDIATE");
		try {
			expect(installChangeLog(dbPath, { busyTimeoutMs: 50 }).status).toBe("busy");
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
		expect(installChangeLog(dbPath).status).toBe("installed");
	});

	it("reports a missing db without creating it", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-changelog-"));
		roots.push(root);
		const dbPath = path.join(root, "absent", "mnemopi.db");
		expect(installChangeLog(dbPath).status).toBe("missing");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("installs on tables without corrected_by", () => {
		const dbPath = makeBank(`
			CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, metadata_json TEXT, valid_until TEXT, superseded_by TEXT, recall_count INTEGER DEFAULT 0);
			CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, timestamp TEXT, metadata_json TEXT);
		`);
		expect(installChangeLog(dbPath).status).toBe("installed");
		const db = new Database(dbPath);
		db.run("INSERT INTO episodic_memory (id, content) VALUES ('e1', 'x')");
		db.run("UPDATE episodic_memory SET content = 'y' WHERE id = 'e1'");
		const changes = readChanges(db, 0);
		expect(changes.map(change => change.op)).toEqual(["insert", "update"]);
		expect(changes[1].source).toBeNull();
		db.close();
	});

	it("reports maxSeq 0 when the log is absent", () => {
		const dbPath = makeBank();
		const db = new Database(dbPath);
		expect(changeLogPresent(db)).toBe(false);
		expect(maxSeq(db)).toBe(0);
		expect(readChanges(db, 0)).toEqual([]);
		db.close();
	});

	it("records an install identity and version, and keeps the identity across an upgrade", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		const state = readLogState(db);
		expect(state.present).toBe(true);
		expect(state.version).toBe(CHANGE_LOG_VERSION);
		expect(state.installId).toMatch(/^[0-9a-f-]{36}$/);
		db.run("UPDATE adapter_changelog_meta SET value = '0' WHERE key = 'version'");
		expect(changeLogPresent(db)).toBe(false);
		db.close();
		expect(installChangeLog(dbPath).status).toBe("installed");
		const after = new Database(dbPath);
		expect(readLogState(after).installId).toBe(state.installId);
		expect(readLogState(after).version).toBe(CHANGE_LOG_VERSION);
		after.close();
	});

	it("records which tracked columns an update changed", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "v1");
		db.run("UPDATE working_memory SET valid_until = '2026-12-01', metadata_json = '{}' WHERE id = 'm1'");
		db.run("UPDATE working_memory SET content = 'v2' WHERE id = 'm1'");
		const [, first, second] = readChanges(db, 0);
		expect(first.columns).toEqual(["metadata_json", "valid_until"]);
		expect(second.columns).toEqual(["content"]);
		db.close();
	});

	it("omits content when an update turns a row into a transcript", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "m1", "private text");
		db.run("UPDATE working_memory SET source = 'coding-agent-transcript', content = 'whole session' WHERE id = 'm1'");
		expect(readChanges(db, 0)[1].oldRow?.content).toBeNull();
		db.close();
	});

	it("prunes through a sequence and records the watermark", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const db = new Database(dbPath);
		insert(db, "a", "1");
		insert(db, "b", "2");
		insert(db, "c", "3");
		const second = readChanges(db, 0)[1].seq;
		expect(pruneChanges(dbPath, second).status).toBe("pruned");
		expect(readChanges(db, 0).map(change => change.memoryId)).toEqual(["c"]);
		expect(readLogState(db).prunedThrough).toBe(second);
		expect(pruneChanges(dbPath, 1).status).toBe("pruned");
		expect(readLogState(db).prunedThrough).toBe(second);
		db.close();
	});

	it("returns busy from prune under a held write lock", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		const holder = new Database(dbPath);
		holder.exec("BEGIN IMMEDIATE");
		try {
			expect(pruneChanges(dbPath, 1, { busyTimeoutMs: 50 }).status).toBe("busy");
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
	});

	it("uninstalls the triggers and tables", () => {
		const dbPath = makeBank();
		installChangeLog(dbPath);
		expect(uninstallChangeLog(dbPath).status).toBe("uninstalled");
		const db = new Database(dbPath);
		const leftovers = db.query("SELECT name FROM sqlite_master WHERE name LIKE 'adapter_%'").all();
		expect(leftovers).toEqual([]);
		insert(db, "m1", "v1");
		db.close();
		expect(uninstallChangeLog(dbPath).status).toBe("absent");
	});

	it("migrates a log table that predates the columns field", () => {
		const dbPath = makeBank();
		const db = new Database(dbPath);
		db.exec("CREATE TABLE adapter_memory_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, changed_at TEXT NOT NULL DEFAULT 'x', op TEXT NOT NULL, memory_table TEXT NOT NULL, memory_id TEXT NOT NULL, source TEXT, old_row TEXT)");
		db.close();
		expect(installChangeLog(dbPath).status).toBe("installed");
		const after = new Database(dbPath);
		insert(after, "m1", "v1");
		after.run("UPDATE working_memory SET content = 'v2' WHERE id = 'm1'");
		expect(readChanges(after, 0).map(change => change.columns)).toEqual([[], ["content"]]);
		after.close();
	});

});
