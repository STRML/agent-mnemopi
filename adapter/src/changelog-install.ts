import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AdapterContext } from "./context";
import { installChangeLog } from "./changelog";
import { ensurePrivateDir, listBanks } from "./review";

const INSTALL_FAILURE_FILE = "changelog-install-failure.json";
const INSTALL_RETRY_MS = 3_600_000;

export interface ChangeLogInstallSummary {
	readonly installed: string[];
	readonly present: string[];
	/** Locked by a writer; retried at the next start without backoff. */
	readonly busy: string[];
	readonly failed: { bank: string; error: string }[];
	/** Banks left alone because a recent install already failed on them. */
	readonly skipped: string[];
}

export interface InstallFailure {
	readonly failedAt: string;
	readonly error: string;
	/** Retry deadline per failed bank. null (an older record) means `retryAt` covers every bank. */
	readonly banks: Readonly<Record<string, string>> | null;
	readonly retryAt?: string;
}

function deadline(failure: InstallFailure | undefined, bank: string): number | undefined {
	if (!failure) return undefined;
	const value = failure.banks === null ? failure.retryAt : failure.banks[bank];
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(time) ? time : undefined;
}

// Installs the change log into every existing bank. Nothing here creates a bank.
export function failureCovers(failure: InstallFailure | undefined, bank: string, now: Date): boolean {
	const until = deadline(failure, bank);
	return until !== undefined && until > now.getTime();
}

export function installChangeLogAll(context: AdapterContext, options: { skipFailedBefore?: { failure: InstallFailure | undefined; now: Date } } = {}): ChangeLogInstallSummary {
	const summary: ChangeLogInstallSummary = { installed: [], present: [], busy: [], failed: [], skipped: [] };
	const skip = options.skipFailedBefore;
	for (const { bank, dbPath } of listBanks(context)) {
		if (skip && failureCovers(skip.failure, bank, skip.now)) { summary.skipped.push(bank); continue; }
		const result = installChangeLog(dbPath);
		if (result.status === "installed") summary.installed.push(bank);
		else if (result.status === "present") summary.present.push(bank);
		else if (result.status === "busy") summary.busy.push(bank);
		else summary.failed.push({ bank, error: result.error ?? result.status });
	}
	return summary;
}

function failurePath(context: AdapterContext): string {
	return path.join(context.dataDir, ".adapter-review", INSTALL_FAILURE_FILE);
}

/**
 * A bank that cannot take the log would otherwise relaunch an install on every
 * start. Each failed bank waits an hour; a skipped bank keeps its own deadline.
 */
export function recordInstallOutcome(context: AdapterContext, summary: ChangeLogInstallSummary, now: Date): void {
	const target = failurePath(context);
	const prior = readInstallFailure(context);
	const banks: Record<string, string> = Object.create(null);
	for (const bank of summary.skipped) {
		const until = deadline(prior, bank);
		if (until !== undefined) banks[bank] = new Date(until).toISOString();
	}
	for (const entry of summary.failed) banks[entry.bank] = new Date(now.getTime() + INSTALL_RETRY_MS).toISOString();
	if (Object.keys(banks).length === 0) {
		try { unlinkSync(target); } catch { /* nothing recorded */ }
		return;
	}
	const errors = summary.failed.map(entry => `${entry.bank}: ${entry.error}`);
	const record: InstallFailure = {
		failedAt: summary.failed.length > 0 ? now.toISOString() : prior?.failedAt ?? now.toISOString(),
		error: (errors.length > 0 ? errors.join("; ") : prior?.error ?? "").slice(0, 1000),
		banks,
	};
	const temporary = `${target}.tmp-${process.pid}`;
	try {
		ensurePrivateDir(path.dirname(target));
		writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, target);
	} catch {
		try { unlinkSync(temporary); } catch { /* best effort */ }
	}
}

export function readInstallFailure(context: AdapterContext): InstallFailure | undefined {
	try {
		const file = failurePath(context);
		const info = lstatSync(file);
		if (!info.isFile() || (info.mode & 0o077) !== 0) return undefined;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const retryAt = typeof parsed.retryAt === "string" ? parsed.retryAt : undefined;
		let banks: Record<string, string> | null = null;
		if (Array.isArray(parsed.banks)) {
			// Bank list with one shared deadline.
			banks = Object.fromEntries(parsed.banks.filter((bank): bank is string => typeof bank === "string").map(bank => [bank, retryAt ?? ""]));
		} else if (parsed.banks !== null && typeof parsed.banks === "object") {
			banks = Object.fromEntries(Object.entries(parsed.banks as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		} else if (retryAt === undefined) {
			return undefined;
		}
		return { failedAt: String(parsed.failedAt ?? ""), error: String(parsed.error ?? ""), banks, ...(retryAt ? { retryAt } : {}) };
	} catch {
		return undefined;
	}
}
