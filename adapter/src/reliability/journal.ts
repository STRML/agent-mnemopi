import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type JournalPhase = "attempt" | "outcome";
export type JournalOutcome = "committed" | "failed";
export type JournalSyncHook = (kind: "file" | "directory", fd: number) => void;
let journalSyncHook: JournalSyncHook = (kind, fd) => fsyncSync(fd);
export function setJournalSyncHook(hook: JournalSyncHook | null): void {
	journalSyncHook = hook ?? ((kind, fd) => fsyncSync(fd));
}

export interface JournalMutation {
	readonly operation: "remember" | "update" | "invalidate";
	readonly bank: string;
	readonly memoryId?: string | null;
	readonly replacementId?: string | null;
	readonly sourceHarness?: string;
	readonly beforeContent?: string | null;
	readonly afterContent?: string | null;
	readonly content?: string | null;
	readonly importance?: number | null;
}

export interface JournalRecord {
	readonly phase: JournalPhase;
	readonly operation_id: string;
	readonly utc: string;
	readonly operation: JournalMutation["operation"];
	readonly bank: string;
	readonly memory_id: string | null;
	readonly replacement_id: string | null;
	readonly source_harness: string;
	readonly outcome?: JournalOutcome;
	readonly error?: string;
	readonly before?: JournalValue;
	readonly after?: JournalValue;
}

export interface JournalValue {
	readonly content: string | null;
	readonly content_sha256: string | null;
	readonly content_length: number;
	readonly importance?: number | null;
}

export class JournalUnavailableError extends Error {
	constructor(message: string, readonly journalFile: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "JournalUnavailableError";
	}
}

export function journalPath(configuredDataDir: string): string {
	const configured = process.env.MNEMOPI_ADAPTER_JOURNAL_PATH?.trim();
	return configured ? resolve(configured) : join(configuredDataDir, ".adapter-journal", "events.jsonl");
}

function value(content: string | null | undefined, importance?: number | null): JournalValue | undefined {
	if (content === undefined && importance === undefined) return undefined;
	const text = content ?? null;
	return {
		content: text,
		content_sha256: text === null ? null : createHash("sha256").update(text, "utf8").digest("hex"),
		content_length: text === null ? 0 : text.length,
		...(importance === undefined ? {} : { importance }),
	};
}

function operationId(): string { return randomUUID(); }

/** Append-only private journal. Every append is O_APPEND and fsync'd before return. */
export class MutationJournal {
	readonly path: string;
	constructor(configuredDataDir: string, private readonly now: () => Date = () => new Date()) {
		this.path = journalPath(configuredDataDir);
	}

	private append(record: JournalRecord): void {
		let fd: number | undefined;
		try {
			const directory = dirname(this.path);
			const directoryCreated = ensurePrivateJournalDirectory(directory);
			const fileCreated = !exists(this.path);
			if (!fileCreated && !isPrivateRegularFile(this.path)) throw new Error(`journal path is not a private regular file: ${this.path}`);
			fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
			const file = fstatSync(fd);
			if (!file.isFile() || (typeof process.getuid === "function" && file.uid !== process.getuid())) throw new Error(`journal file ownership/type changed: ${this.path}`);
			fchmodSync(fd, 0o600);
			const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
			if (writeSync(fd, bytes) !== bytes.byteLength) throw new Error("short journal write");
			journalSyncHook("file", fd);
			if (fileCreated || directoryCreated) {
				fsyncDirectory(directory);
				if (directoryCreated) fsyncDirectory(dirname(directory));
			}
		} catch (error) {
			throw new JournalUnavailableError(`Cannot append adapter mutation journal: ${this.path}`, this.path, { cause: error });
		} finally {
			if (fd !== undefined) {
				try { closeSync(fd); } catch { /* best effort */ }
			}
		}
	}

	appendAttempt(mutation: JournalMutation, id = operationId()): string {
		this.append({
			phase: "attempt",
			operation_id: id,
			utc: this.now().toISOString(),
			operation: mutation.operation,
			bank: mutation.bank,
			memory_id: mutation.memoryId ?? null,
			replacement_id: mutation.replacementId ?? null,
			source_harness: mutation.sourceHarness ?? "adapter",
			before: value(mutation.beforeContent, mutation.importance),
			after: value(mutation.afterContent ?? mutation.content, mutation.importance),
		});
		return id;
	}

	appendOutcome(mutation: JournalMutation, operationIdValue: string, outcome: JournalOutcome, error?: unknown): void {
		this.append({
			phase: "outcome",
			operation_id: operationIdValue,
			utc: this.now().toISOString(),
			operation: mutation.operation,
			bank: mutation.bank,
			memory_id: mutation.memoryId ?? null,
			replacement_id: mutation.replacementId ?? null,
			source_harness: mutation.sourceHarness ?? "adapter",
			outcome,
			...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
			before: value(mutation.beforeContent, mutation.importance),
			after: value(mutation.afterContent ?? mutation.content, mutation.importance),
		});
	}
}

function exists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}

function isPrivateRegularFile(path: string): boolean {
	try {
		const info = lstatSync(path);
		return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function ensurePrivateJournalDirectory(directory: string): boolean {
	let current = parse(resolve(directory)).root;
	for (const segment of resolve(directory).slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, segment);
		if (exists(current) && lstatSync(current).isSymbolicLink() && !["/tmp", "/var", "/private"].includes(current))
			throw new Error(`journal path contains symlink component: ${current}`);
	}
	const created = !exists(directory);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = lstatSync(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`journal parent is not a directory: ${directory}`);
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`journal parent is not owned by current user: ${directory}`);
	if ((info.mode & 0o077) !== 0) throw new Error(`journal parent is not private: ${directory}`);
	return created;
}

function fsyncDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
		journalSyncHook("directory", fd);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function createMutationJournal(configuredDataDir: string): MutationJournal {
	return mutationJournalFactory(configuredDataDir);
}

export type MutationJournalFactory = (configuredDataDir: string) => MutationJournal;
let mutationJournalFactory: MutationJournalFactory = configuredDataDir => new MutationJournal(configuredDataDir);

/** Test/integration seam for deterministic append-failure recovery tests. */
export function setMutationJournalFactory(factory: MutationJournalFactory | null): void {
	mutationJournalFactory = factory ?? (configuredDataDir => new MutationJournal(configuredDataDir));
}
