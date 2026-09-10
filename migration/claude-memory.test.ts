import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BeamMemory } from "../adapter/src/vendor/mnemopi/core/beam/index.ts";
import { encodeClaudeProjectPath, importManifest, inventory } from "./claude-memory.ts";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "claude-memory-migration-"));
}

async function makeFixture() {
	const root = fixtureRoot();
	const claudeHome = join(root, "claude");
	const codexHome = join(root, "codex");
	const cwd = "/synthetic/project/My.Project";
	const projectDir = join(claudeHome, "projects", encodeClaudeProjectPath(cwd));
	mkdirSync(join(projectDir, "memory"), { recursive: true });
	mkdirSync(join(claudeHome, "rules"), { recursive: true });
	mkdirSync(join(claudeHome, "memory"), { recursive: true });
	mkdirSync(join(codexHome, "memories"), { recursive: true });
	await Bun.write(join(projectDir, "sessions-index.json"), JSON.stringify({ originalPath: cwd, entries: [{ projectPath: cwd }] }));
	await Bun.write(join(projectDir, "memory", "topic.md"), "# exact\nline 2\n");
	await Bun.write(join(projectDir, "memory", "ARCHIVE.md"), "historical\n");
	await Bun.write(join(claudeHome, "MEMORY.md"), "global exact\n");
	await Bun.write(join(claudeHome, "rules", "global-memory.md"), "");
	await Bun.write(join(claudeHome, "memory", "global-archive.md"), "archive global\n");
	await Bun.write(join(codexHome, "memories", "native.md"), "codex note\n");
	return { root, claudeHome, codexHome, projectDir };
}

function seedExistingNativeRows(dataDir: string): void {
	const dbPath = join(dataDir, "mnemopi.db");
	const beam = new BeamMemory({ dbPath, sessionId: "default", workingMemoryLimit: 0, noEmbeddings: true, llm: false });
	try {
		beam.db.run(
			`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, scope, trust_tier)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["preexisting-aged-native", "preexisting native memory", "conversation", "2020-01-01T00:00:00.000Z", "default", 0.5, "{}", "bank", "STATED"],
		);
		beam.db.run(
			"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)",
			["preexisting-aged-native", "[0.1,0.2,0.3]", "test-model"],
		);
	} finally {
		beam.close();
	}
}

describe("Claude exact-content migration", () => {
	test("inventories mappings, archives, and isolated external notes", async () => {
		const fixture = await makeFixture();
		try {
			const plan = await inventory({ claudeHome: fixture.claudeHome, codexHome: fixture.codexHome });
			expect(plan.records).toHaveLength(6);
			expect(plan.records.filter(record => record.resolved_cwd).every(record => record.resolved_cwd === "/synthetic/project/My.Project")).toBe(true);
			expect(plan.counts.active).toBe(3);
			expect(plan.counts["cold-archive"]).toBe(2);
			expect(plan.counts.unresolved).toBe(1);
			expect((plan.records.find(record => record.source_kind === "codex-memory")?.bank ?? "").startsWith("claude-archive-")).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("preserves bytes, marks imports durable, and reruns without duplicates", async () => {
		const fixture = await makeFixture();
		try {
			await Bun.write(join(fixture.projectDir, "memory", "duplicate.md"), "# exact\nline 2\n");
			const plan = await inventory({ claudeHome: fixture.claudeHome, codexHome: fixture.codexHome });
			const dataDir = join(fixture.root, "data");
			seedExistingNativeRows(dataDir);
			const first = await importManifest(plan, dataDir, "fixture");
			expect(first.counts.successful).toBe(7);
			const preserved = new Database(join(dataDir, "mnemopi.db"), { readonly: true });
			expect(preserved.query("SELECT COUNT(*) AS count FROM working_memory WHERE id = ?").get("preexisting-aged-native").count).toBe(1);
			expect(preserved.query("SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?").get("preexisting-aged-native").embedding_json).toBe("[0.1,0.2,0.3]");
			preserved.close();
			const second = await importManifest(plan, dataDir, "fixture");
			expect(second.counts.skipped).toBe(7);
			const bank = plan.records.find(record => record.resolved_cwd && record.classification === "active")?.bank;
			const db = new Database(join(dataDir, "banks", bank!, "mnemopi.db"), { readonly: true });
			const row = db.query("SELECT content, scope, session_id, trust_tier, consolidated_at FROM working_memory WHERE source = 'claude-memory-import' AND content LIKE '# exact%'").get() as Record<string, string>;
			expect(row.content).toBe("# exact\nline 2\n");
			expect(row.scope).toBe("bank");
			expect(row.session_id).toBe(bank);
			expect(row.trust_tier).toBe("IMPORTED");
			expect(row.consolidated_at).toBeTruthy();
			expect(db.query("SELECT COUNT(*) AS count FROM working_memory WHERE content = ?").get("# exact\nline 2\n").count).toBe(2);
			db.close();
			await Bun.write(join(fixture.projectDir, "memory", "topic.md"), "corrected\n");
			const revised = await inventory({ claudeHome: fixture.claudeHome, codexHome: fixture.codexHome });
			const revisionReport = await importManifest(revised, dataDir, "revised");
			expect(revisionReport.counts.successful).toBe(1);
			expect(revisionReport.unresolved.some(item => item.reason.includes("source revision conflict"))).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("fails closed when source bytes change after inventory", async () => {
		const fixture = await makeFixture();
		try {
			const plan = await inventory({ claudeHome: fixture.claudeHome, codexHome: fixture.codexHome });
			await Bun.write(join(fixture.projectDir, "memory", "topic.md"), "corrected\n");
			const report = await importManifest(plan, join(fixture.root, "data"), "fixture");
			expect(report.failures.some(item => item.reason.includes("changed since inventory"))).toBe(true);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
