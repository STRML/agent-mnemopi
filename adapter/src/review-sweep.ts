import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AdapterContext } from "./context";
import { ensurePrivateDir, review, reviewDue, type ReviewOptions, type ReviewResult } from "./review";

const REVIEW_FAILURE_FILE = "review-failure.json";
const REVIEW_RETRY_BASE_MS = 60_000;
const REVIEW_RETRY_MAX_MS = 3_600_000;

export interface ReviewFailureState {
	readonly attempts: number;
	readonly failedAt: string;
	readonly retryAt: string;
	readonly error?: string;
}

export interface LockedReviewOptions {
	readonly mode: "sweep" | "explicit";
	readonly now?: Date;
	readonly waitMs?: number;
	readonly dueDays?: number;
	readonly snapshotWriter?: ReviewOptions["snapshotWriter"];
}

export interface LockedReviewResult {
	readonly status: "ok" | "error" | "busy" | "skipped";
	readonly reason?: "not_due" | "deferred";
	readonly error?: string;
	readonly review?: ReviewResult;
}

function reviewFailurePath(context: AdapterContext): string {
	return path.join(context.dataDir, ".adapter-review", REVIEW_FAILURE_FILE);
}

export function readReviewFailure(context: AdapterContext): ReviewFailureState | undefined {
	try {
		const file = reviewFailurePath(context);
		const info = lstatSync(file);
		if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const state = parsed as Partial<ReviewFailureState>;
		if (typeof state.attempts !== "number" || !Number.isInteger(state.attempts) || state.attempts < 1 || typeof state.failedAt !== "string" || typeof state.retryAt !== "string") return undefined;
		if (!Number.isFinite(Date.parse(state.failedAt)) || !Number.isFinite(Date.parse(state.retryAt))) return undefined;
		return { attempts: state.attempts, failedAt: state.failedAt, retryAt: state.retryAt, ...(typeof state.error === "string" ? { error: state.error } : {}) };
	} catch {
		return undefined;
	}
}

function retryDelayMs(attempts: number): number {
	return Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * 2 ** Math.min(10, Math.max(0, attempts - 1)));
}

function writeReviewFailure(context: AdapterContext, state: ReviewFailureState): ReviewFailureState | undefined {
	const target = reviewFailurePath(context);
	const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		ensurePrivateDir(path.dirname(target));
		writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, target);
		return state;
	} catch {
		return undefined;
	} finally {
		try { unlinkSync(temporary); } catch { /* no temp or best effort */ }
	}
}

export function recordReviewFailure(context: AdapterContext, now: Date, error: string): ReviewFailureState | undefined {
	const attempts = (readReviewFailure(context)?.attempts ?? 0) + 1;
	return writeReviewFailure(context, {
		attempts,
		failedAt: now.toISOString(),
		retryAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
		error: error.slice(0, 1000),
	});
}

export function clearReviewFailure(context: AdapterContext): void {
	try { unlinkSync(reviewFailurePath(context)); } catch { /* no marker or best effort */ }
}

function removeOrphans(directory: string): void {
	for (const name of readdirSync(directory)) {
		if (name.startsWith(".stage-") || (name.startsWith("snapshot-") && name.includes(".tmp-"))) unlinkSync(path.join(directory, name));
	}
}

function skipReason(context: AdapterContext, now: Date, dueDays: number): LockedReviewResult["reason"] {
	if (reviewDue(context.cwd, dueDays, { context, now }).status === "not_due") return "not_due";
	const failure = readReviewFailure(context);
	if (failure && Date.parse(failure.retryAt) > now.getTime()) return "deferred";
	return undefined;
}

function performReview(context: AdapterContext, options: LockedReviewOptions, now: Date): LockedReviewResult {
	const dueDays = options.dueDays ?? 7;
	const reason = options.mode === "sweep" ? skipReason(context, now, dueDays) : undefined;
	if (reason) return { status: "skipped", reason };
	const attempt = options.mode === "sweep"
		? recordReviewFailure(context, now, "sweep did not finish (worker died or was killed)")
		: undefined;
	if (options.mode === "sweep" && !attempt) return { status: "error", error: "could not record review sweep attempt" };
	try {
		const result = review(context.cwd, dueDays, { context, now, snapshotWriter: options.snapshotWriter });
		if (result.status === "ok") clearReviewFailure(context);
		else if (attempt) writeReviewFailure(context, { ...attempt, error: (result.error ?? "unknown error").slice(0, 1000) });
		return { status: result.status, ...(result.error ? { error: result.error } : {}), review: result };
	} catch (error) {
		if (attempt) writeReviewFailure(context, { ...attempt, error: String(error).slice(0, 1000) });
		return { status: "error", error: String(error) };
	}
}

function acquireLock(lock: Database, waitMs: number): boolean {
	lock.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
	try {
		lock.exec("BEGIN EXCLUSIVE");
		return true;
	} catch (error) {
		if (String(error).includes("database is locked")) return false;
		throw error;
	}
}

export function runLockedReview(context: AdapterContext, options: LockedReviewOptions): LockedReviewResult {
	const directory = path.join(context.dataDir, ".adapter-review");
	ensurePrivateDir(directory);
	const lock = new Database(path.join(directory, "review.lock"), { create: true });
	try {
		const waitMs = options.waitMs ?? (options.mode === "sweep" ? 30_000 : 600_000);
		if (!acquireLock(lock, waitMs)) return { status: "busy", error: "review lock is busy (database is locked)" };
		try {
			removeOrphans(directory);
			return performReview(context, options, options.now ?? new Date());
		} finally {
			try { removeOrphans(directory); } finally { lock.exec("ROLLBACK"); }
		}
	} finally {
		lock.close();
	}
}

export function launchReviewSweep(cwd: string): Promise<{ started: boolean; error?: string }> {
	return new Promise(resolve => {
		try {
			const sourceEntry = path.join(import.meta.dir, "entry.ts");
			const entry = existsSync(sourceEntry) ? sourceEntry : Bun.main;
			const child = spawn(process.execPath, [entry, "review-sweep", "--cwd", cwd], { detached: true, stdio: "ignore" });
			child.once("spawn", () => resolve({ started: true }));
			child.once("error", error => resolve({ started: false, error: String(error) }));
			child.unref();
		} catch (error) {
			resolve({ started: false, error: String(error) });
		}
	});
}
