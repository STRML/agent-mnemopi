import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutationJournal, journalPath, MutationJournal, setJournalSyncHook, setMutationJournalFactory } from "../src/reliability/journal";
import { annotateRecallResults, prepareMutationStore, prepareRecallStore, preflightStore, resolveStore, selectInjectableRecall } from "../src/reliability/policy";
import { BeamMemory } from "../src/vendor/mnemopi/core/beam/index";
import { handleToolCall } from "../src/vendor/mnemopi/mcp-tools";

function canonical(root: string): string {
	const path = join(root, "mnemopi.db");
	const db = new Database(path);
	db.exec("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
	db.exec("CREATE TABLE episodic_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
	db.close();
	return path;
}

function seeded(root: string): string {
	const path = join(root, "mnemopi.db");
	const beam = new BeamMemory({ dbPath: path, sessionId: "default", config: { workingMemoryLimit: 0 } });
	beam.close();
	return path;
}

function withRuntime(root: string, dbPath: string, fn: () => Promise<void>): Promise<void> {
	const saved = {
		data: process.env.MNEMOPI_DATA_DIR,
		base: process.env.MNEMOPI_BASE_DB_PATH,
		bank: process.env.MNEMOPI_BASE_BANK,
		journal: process.env.MNEMOPI_ADAPTER_JOURNAL_PATH,
	};
	process.env.MNEMOPI_DATA_DIR = root;
	process.env.MNEMOPI_BASE_DB_PATH = dbPath;
	process.env.MNEMOPI_BASE_BANK = "default";
	return fn().finally(() => {
		if (saved.data === undefined) delete process.env.MNEMOPI_DATA_DIR; else process.env.MNEMOPI_DATA_DIR = saved.data;
		if (saved.base === undefined) delete process.env.MNEMOPI_BASE_DB_PATH; else process.env.MNEMOPI_BASE_DB_PATH = saved.base;
		if (saved.bank === undefined) delete process.env.MNEMOPI_BASE_BANK; else process.env.MNEMOPI_BASE_BANK = saved.bank;
		if (saved.journal === undefined) delete process.env.MNEMOPI_ADAPTER_JOURNAL_PATH; else process.env.MNEMOPI_ADAPTER_JOURNAL_PATH = saved.journal;
		setMutationJournalFactory(null);
	});
}

function journalRecords(root: string): Array<Record<string, unknown>> {
	const path = journalPath(root);
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("reliability policy", () => {
	it("selects lexical and exact metadata evidence, never dense-only score", () => {
		const results = [
			{ id: "dense", keyword_score: 0, fts_score: 0, dense_score: 0.99, score: 0.99 },
			{ id: "lex", content: "task-7 lexical note", keyword_score: 0.2, dense_score: 0, score: 0.4 },
			{ id: "meta", metadata: { task_key: "task-7" }, score: 0.01 },
		] as never[];
		const selected = selectInjectableRecall("task-7", results);
		expect(selected.status).toBe("selected");
		if (selected.status === "selected") expect(selected.results.map(row => row.id)).toEqual(["lex", "meta"]);
		const raw = annotateRecallResults("unrelated", [results[0]]);
		expect(raw.status).toBe("no_useful_match");
		expect(raw.results.map(row => row.id)).toEqual(["dense"]);
		expect(raw.score_is_not_confidence).toBe(true);
	});

	it("ignores stopwords and requires token boundaries for lexical evidence", () => {
		const stopwordSubstring = { id: "stopword-substring", content: "listing existing context", keyword_score: 0.4 };
		const startupBoilerplate = { id: "startup-boilerplate", content: "session startup checklist", keyword_score: 0.4 };
		const pathPrefix = { id: "path-prefix", content: "handoff for /workspace/project-old", keyword_score: 0.4 };
		const pathMatch = { id: "path-match", content: "handoff for /workspace/project", keyword_score: 0.4 };

		expect(selectInjectableRecall("this list exists", [stopwordSubstring])).toEqual({
			status: "abstained",
			reason: "no_query_specific_evidence",
			results: [],
		});
		expect(selectInjectableRecall("session startup /workspace/project", [startupBoilerplate, pathPrefix, pathMatch])).toMatchObject({
			status: "selected",
			results: [{ id: "path-match", evidence: "query_lexical", evidence_label: "query_lexical" }],
		});
	});

	it("reports missing stores without creating them", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-policy-"));
		const path = join(root, "missing.db");
		const result = preflightStore({ dbPath: path, bank: "default" });
		expect(result.ok).toBe(false);
		expect(existsSync(path)).toBe(false);
		expect(statSync(root).isDirectory()).toBe(true);
	});

	it("allows absent derived recall but only after validating canonical base", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-policy-"));
		const base = canonical(root);
		const oldDir = process.env.MNEMOPI_DATA_DIR;
		const oldBase = process.env.MNEMOPI_BASE_DB_PATH;
		const oldBank = process.env.MNEMOPI_BASE_BANK;
		try {
			process.env.MNEMOPI_DATA_DIR = root;
			process.env.MNEMOPI_BASE_DB_PATH = base;
			process.env.MNEMOPI_BASE_BANK = "default";
			expect(prepareRecallStore("project-x").kind).toBe("empty_derived");
			expect(prepareMutationStore("project-x").kind).toBe("ready");
		} finally {
			if (oldDir === undefined) delete process.env.MNEMOPI_DATA_DIR; else process.env.MNEMOPI_DATA_DIR = oldDir;
			if (oldBase === undefined) delete process.env.MNEMOPI_BASE_DB_PATH; else process.env.MNEMOPI_BASE_DB_PATH = oldBase;
			if (oldBank === undefined) delete process.env.MNEMOPI_BASE_BANK; else process.env.MNEMOPI_BASE_BANK = oldBank;
		}
	});

	it("resolves literal default beside a custom base bank", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-policy-paths-"));
		const customBase = join(root, "custom-base", "mnemopi.db");
		const oldData = process.env.MNEMOPI_DATA_DIR;
		const oldBase = process.env.MNEMOPI_BASE_DB_PATH;
		const oldBank = process.env.MNEMOPI_BASE_BANK;
		try {
			process.env.MNEMOPI_DATA_DIR = root;
			process.env.MNEMOPI_BASE_DB_PATH = customBase;
			process.env.MNEMOPI_BASE_BANK = "custom";
			expect(resolveStore("custom").dbPath).toBe(customBase);
			expect(resolveStore("default").dbPath).toBe(join(root, "mnemopi.db"));
			expect(resolveStore("project").dbPath).toBe(join(root, "banks", "project", "mnemopi.db"));
		} finally {
			if (oldData === undefined) delete process.env.MNEMOPI_DATA_DIR; else process.env.MNEMOPI_DATA_DIR = oldData;
			if (oldBase === undefined) delete process.env.MNEMOPI_BASE_DB_PATH; else process.env.MNEMOPI_BASE_DB_PATH = oldBase;
			if (oldBank === undefined) delete process.env.MNEMOPI_BASE_BANK; else process.env.MNEMOPI_BASE_BANK = oldBank;
		}
	});

	it("writes private append-only before/after journal records", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-journal-"));
		const journal = createMutationJournal(root);
		const syncKinds: string[] = [];
		setJournalSyncHook(kind => syncKinds.push(kind));
		try {
			const id = journal.appendAttempt({ operation: "update", bank: "default", memoryId: "m1", beforeContent: "before", afterContent: "after", sourceHarness: "test" });
			journal.appendOutcome({ operation: "update", bank: "default", memoryId: "m1", beforeContent: "before", afterContent: "after", sourceHarness: "test" }, id, "committed");
		} finally {
			setJournalSyncHook(null);
		}
		expect(syncKinds.slice(0, 3)).toEqual(["file", "directory", "directory"]);
		const records = readFileSync(journal.path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(2);
		expect((records[0].after as Record<string, unknown>).content).toBe("after");
		expect((records[1].before as Record<string, unknown>).content).toBe("before");
		expect(statSync(journal.path).mode & 0o777).toBe(0o600);
	});

	it("distinguishes unreadable/open failure and malformed schema", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-preflight-"));
		const directoryPath = join(root, "locked.db");
		mkdirSync(directoryPath);
		const unavailable = preflightStore({ dbPath: directoryPath, bank: "default" });
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) expect(unavailable.error.code).toBe("store_unavailable");
		const badPath = join(root, "bad.db");
		const bad = new Database(badPath);
		bad.exec("CREATE TABLE working_memory (wrong TEXT)");
		bad.exec("CREATE TABLE episodic_memory (wrong TEXT)");
		bad.close();
		const mismatch = preflightStore({ dbPath: badPath, bank: "default" });
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) expect(mismatch.error.code).toBe("store_schema_mismatch");
	});

	it("blocks a remember when the journal attempt cannot be appended", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-attempt-failure-"));
		const dbPath = seeded(root);
		const journalDirectory = join(root, "journal-directory");
		mkdirSync(journalDirectory);
		await withRuntime(root, dbPath, async () => {
			process.env.MNEMOPI_ADAPTER_JOURNAL_PATH = journalDirectory;
			const result = await handleToolCall("mnemopi_remember", { bank: "default", content: "must not write" });
			expect(result.error).toBe("journal_unavailable");
			const db = new Database(dbPath, { readonly: true });
			expect((db.query("SELECT COUNT(*) AS count FROM working_memory").get() as { count: number }).count).toBe(0);
			db.close();
		});
	});

	it("records a failed outcome when the mutation does not commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-mutation-failure-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const result = await handleToolCall("mnemopi_update", { bank: "default", memory_id: "missing", content: "never" });
			expect(result.status).toBe("not_found");
			const records = journalRecords(root);
			expect(records.map(record => record.phase)).toEqual(["attempt", "outcome"]);
			expect(records[1].outcome).toBe("failed");
		});
	});

	it("reports committed-but-incomplete journal without retry claim", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-postcommit-failure-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const real = createMutationJournal(root);
			let appendCount = 0;
			setMutationJournalFactory(() => ({
				path: real.path,
				appendAttempt: mutation => {
					appendCount++;
					return real.appendAttempt(mutation);
				},
				appendOutcome: (mutation, id, outcome, error) => {
					appendCount++;
					if (appendCount === 2) throw new Error("simulated outcome append failure");
					real.appendOutcome(mutation, id, outcome, error);
				},
			} as MutationJournal));
			const result = await handleToolCall("mnemopi_remember", { bank: "default", content: "committed note" });
			expect(result.status).toBe("mutation_committed_journal_incomplete");
			expect(result.memory_id).toEqual(expect.any(String));
			expect(result.retry_claim).toBeUndefined();
			const db = new Database(dbPath, { readonly: true });
			expect((db.query("SELECT content FROM working_memory WHERE id = ?").get(result.memory_id) as { content: string }).content).toBe("committed note");
			db.close();
		});
	});

	it("reports committed-but-incomplete when postcommit extraction flush fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-postcommit-flush-failure-"));
		const dbPath = seeded(root);
		const originalFlush = BeamMemory.prototype.flushExtractions;
		BeamMemory.prototype.flushExtractions = async () => { throw new Error("simulated extraction flush failure"); };
		try {
			await withRuntime(root, dbPath, async () => {
				const result = await handleToolCall("mnemopi_remember", { bank: "default", content: "flush failure note" });
				expect(result.status).toBe("mutation_committed_journal_incomplete");
				expect(result.memory_id).toEqual(expect.any(String));
				expect(result.retry_claim).toBeUndefined();
				const records = journalRecords(root);
				expect(records.map(record => record.phase)).toEqual(["attempt", "outcome"]);
				expect(records[1].outcome).toBe("committed");
				expect(records[1].error).toBe("simulated extraction flush failure");
				const db = new Database(dbPath, { readonly: true });
				expect((db.query("SELECT content FROM working_memory WHERE id = ?").get(result.memory_id) as { content: string }).content).toBe("flush failure note");
				db.close();
			});
		} finally {
			BeamMemory.prototype.flushExtractions = originalFlush;
		}
	});

	it("keeps concurrent journal records independent and traceable", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-concurrent-journal-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const outputs = await Promise.all(["one", "two", "three", "four"].map(content => handleToolCall("mnemopi_remember", { bank: "default", content })));
			expect(outputs.every(result => result.status === "stored")).toBe(true);
			const records = journalRecords(root);
			expect(records).toHaveLength(8);
			const ids = new Set(records.map(record => record.operation_id));
			expect(ids.size).toBe(4);
			expect(records.every(record => typeof record.operation_id === "string" && record.operation_id.length > 0)).toBe(true);
		});
	});

	it("serializes conflicting updates so each attempt preimage is current", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-conflict-journal-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const stored = await handleToolCall("mnemopi_remember", { bank: "default", content: "conflict base" });
			const results = await Promise.all([
				handleToolCall("mnemopi_update", { bank: "default", memory_id: stored.memory_id, content: "conflict one" }),
				handleToolCall("mnemopi_update", { bank: "default", memory_id: stored.memory_id, content: "conflict two" }),
			]);
			expect(results.every(result => result.status === "updated")).toBe(true);
			const attempts = journalRecords(root).filter(record => record.operation === "update" && record.phase === "attempt");
			expect(attempts).toHaveLength(2);
			const beforeValues = attempts.map(record => (record.before as Record<string, unknown>).content);
			expect(beforeValues.filter(value => value === "conflict base")).toHaveLength(1);
			expect(beforeValues.every(value => ["conflict base", "conflict one", "conflict two"].includes(value as string))).toBe(true);
		});
	});

	it("creates only an explicitly requested derived bank after base validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-derived-write-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const result = await handleToolCall("mnemopi_remember", { bank: "project-x", content: "derived note" });
			expect(result.status).toBe("stored");
			expect(existsSync(join(root, "banks", "project-x", "mnemopi.db"))).toBe(true);
			expect(existsSync(join(root, "banks", "other", "mnemopi.db"))).toBe(false);
		});
	});

	it("journals update before/after content for reconstruction", async () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-update-journal-"));
		const dbPath = seeded(root);
		await withRuntime(root, dbPath, async () => {
			const stored = await handleToolCall("mnemopi_remember", { bank: "default", content: "before note" });
			await handleToolCall("mnemopi_update", { bank: "default", memory_id: stored.memory_id, content: "after note" });
			const records = journalRecords(root).filter(record => record.operation === "update");
			expect((records[0].after as Record<string, unknown>).content).toBe("after note");
			expect((records[1].before as Record<string, unknown>).content).toBe("before note");
			expect((records[1].after as Record<string, unknown>).content).toBe("after note");
		});
	});

	it("rejects symlinked journal paths before opening the target", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-journal-link-"));
		const target = join(root, "target.jsonl");
		const link = join(root, "link.jsonl");
		writeFileSync(target, "do not append\n");
		symlinkSync(target, link);
		// The env-selected path is checked with lstat and O_NOFOLLOW.
		const old = process.env.MNEMOPI_ADAPTER_JOURNAL_PATH;
		process.env.MNEMOPI_ADAPTER_JOURNAL_PATH = link;
		try {
			const linked = createMutationJournal(root);
			expect(() => linked.appendAttempt({ operation: "remember", bank: "default", content: "unsafe" })).toThrow();
			expect(readFileSync(target, "utf8")).toBe("do not append\n");
		} finally {
			if (old === undefined) delete process.env.MNEMOPI_ADAPTER_JOURNAL_PATH; else process.env.MNEMOPI_ADAPTER_JOURNAL_PATH = old;
		}
	});
});
