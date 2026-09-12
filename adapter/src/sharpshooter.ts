import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { AdapterContext } from "./context";
import { projectBankSegment } from "./vendor/omp-config";

/**
 * OMP's sharpshooter backend distills friction-gated project decisions into three
 * markdown files per project. This reads them; OMP owns every write, and rewrites
 * all three in full on each consolidation.
 *
 * `projectBankSegment` is the same function mnemopi bank scoping uses, so both
 * subsystems name the directory identically regardless of mnemopi's own scoping.
 */
const SHARPSHOOTER_FILES = ["architecture.md", "product.md", "style.md"] as const;
/**
 * Cap on the injected block, matching the store's own startup budget.
 *
 * Measured against 13 real project banks, the largest holds 5,206 characters
 * across all three files and the rest are under 2,400, so this fits every
 * observed project. OMP's 120-line cap says nothing about line length, so it
 * gives no upper bound of its own; that is what the byte cap below is for. A
 * file past this cap is left out whole and counted.
 */
export const SHARPSHOOTER_RESERVE_CHARS = 6000;
/**
 * Most a single decision file may be before it is refused unread.
 *
 * OMP caps each file at 120 lines, and the largest of 13 real banks holds 5,206
 * characters across all three, so 128 KiB is far past any real file while still
 * keeping a runaway one out of memory.
 */
const SHARPSHOOTER_MAX_FILE_BYTES = 128 * 1024;
export const SHARPSHOOTER_HEADING = "PROJECT DECISIONS (sharpshooter; friction-earned rules for this project):";

export interface SharpshooterDecisions {
	/** Rendered block, heading first, already bounded. Empty when nothing is stored. */
	readonly lines: readonly string[];
	/** Whole files left out because the block hit its cap. */
	readonly omittedFiles: number;
	/** Files that exist but could not be read, so the rule set has a hole in it. */
	readonly unreadable: number;
	/** The bank path is not a plain directory chain, so nothing was read. */
	readonly redirected?: boolean;
}

const unreadableNote = (count: number): string =>
	`SHARPSHOOTER FILES UNREADABLE: count=${count}; the project decisions below are incomplete`;

/** Directory OMP writes this project's decision files to. */
export function sharpshooterBankDir(context: AdapterContext): string {
	return path.join(getMemoriesDir(context.agentDir), "sharpshooter", projectBankSegment(context.cwd));
}

/**
 * True when every component from the memories root down to the bank is a real
 * directory. A symlinked parent redirects the whole bank, which the per-file
 * check cannot see, so the path is walked before any file in it is opened.
 */
function bankPathState(context: AdapterContext): "ok" | "missing" | "redirected" {
	const root = getMemoriesDir(context.agentDir);
	// The memories root is walked too: a link there redirects everything below it,
	// and checking only the segments under it would miss that.
	let walked = "";
	for (const segment of [root, "sharpshooter", projectBankSegment(context.cwd)]) {
		walked = walked ? path.join(walked, segment) : segment;
		try {
			// A link or a file where a directory belongs is worth reporting. A path
			// that simply is not there is a project OMP has never opened.
			if (!lstatSync(walked).isDirectory()) return "redirected";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "redirected";
		}
	}
	return "ok";
}

/**
 * Read one regular file under the bank, bounded, without following a link.
 *
 * Opened once and inspected through the descriptor, so the path cannot be
 * swapped between the check and the read. `O_NOFOLLOW` refuses a symlinked
 * leaf, and `O_NONBLOCK` keeps a FIFO from parking startup forever: this runs
 * before the hook answers, and a blocked read is a hung session.
 *
 * The cap bounds the read itself, not just what is injected. The buffer is
 * fixed and one byte larger than the cap, so a file that grew between the stat
 * and the read cannot pull in more than that: the extra byte is what proves it
 * overflowed. OMP writes at most 120 lines per file, so anything at the cap is
 * not a decision file. It is reported rather than truncated, because half a
 * rule set reads like a whole one.
 */
function readFile(dir: string, name: string): { text: string; failed: boolean } {
	let fd: number | undefined;
	try {
		fd = openSync(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) return { text: "", failed: false };
		const buffer = Buffer.alloc(SHARPSHOOTER_MAX_FILE_BYTES + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			filled += read;
		}
		if (filled > SHARPSHOOTER_MAX_FILE_BYTES) return { text: "", failed: true };
		return { text: buffer.subarray(0, filled).toString("utf8").trim(), failed: false };
	} catch (error) {
		// A file OMP never wrote is the normal case; anything else is worth reporting.
		const code = (error as NodeJS.ErrnoException).code;
		return { text: "", failed: code !== "ENOENT" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Age of the injection, so a stale file cannot pass for a current one. */
function consolidatedAt(dir: string, now: Date): string | undefined {
	try {
		const state = readFile(dir, "state.json");
		if (!state.text) return undefined;
		const parsed: unknown = JSON.parse(state.text);
		if (parsed === null || typeof parsed !== "object") return undefined;
		const at = (parsed as { lastConsolidatedAt?: unknown }).lastConsolidatedAt;
		if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
		const days = (now.getTime() - at) / 86_400_000;
		return `last consolidated ${new Date(at).toISOString()} (${Math.max(0, days).toFixed(1)} days ago)`;
	} catch {
		return undefined;
	}
}

/**
 * Render this project's decision files as context lines, bounded by `maxChars`.
 *
 * Files are admitted whole: a file that does not fit is left out and counted,
 * rather than injected as a fragment that reads like the complete rule set.
 */
export function readSharpshooterDecisions(context: AdapterContext, now: Date, maxChars = SHARPSHOOTER_RESERVE_CHARS): SharpshooterDecisions {
	// A redirected bank is reported, not read: silently injecting another
	// directory's rules is worse than injecting none. A missing one is the normal
	// case on a project OMP has never opened, and says nothing.
	const state = bankPathState(context);
	if (state !== "ok") return { lines: [], omittedFiles: 0, unreadable: 0, ...(state === "redirected" ? { redirected: true } : {}) };
	const dir = sharpshooterBankDir(context);
	const read = SHARPSHOOTER_FILES.map(name => ({ name, ...readFile(dir, name) }));
	// A file that exists but cannot be read is a hole in the rule set, so say so
	// rather than presenting what is left as the whole of it.
	const unreadable = read.filter(file => file.failed).length;
	const files = read.filter(file => file.text.length > 0);
	// `maxChars` bounds everything returned, diagnostics included. A budget too
	// small even for one line yields no lines; the counts still reach the caller.
	const fits = (line: string): boolean => line.length + 1 <= maxChars;
	if (files.length === 0) {
		const note = unreadable > 0 && fits(unreadableNote(unreadable)) ? [unreadableNote(unreadable)] : [];
		return { lines: note, omittedFiles: 0, unreadable };
	}
	const age = consolidatedAt(dir, now);
	const heading = age ? `${SHARPSHOOTER_HEADING} ${age}` : SHARPSHOOTER_HEADING;
	const blocks = files.map(file => `## ${file.name.slice(0, -3)}\n${file.text}`);
	// The note counts against the budget but is not a file, so it is never part of
	// the omitted-file count.
	const notes = unreadable > 0 ? [unreadableNote(unreadable)] : [];
	const size = (values: readonly string[]): number => values.reduce((sum, value) => sum + value.length + 1, 0);
	if (size([heading, ...blocks, ...notes]) <= maxChars) return { lines: [heading, ...blocks, ...notes], omittedFiles: 0, unreadable };
	// Something will not fit, so the omission line is part of the budget from here on.
	const omitted = (count: number): string => `SHARPSHOOTER FILES OMITTED: count=${count}; they exceeded the block budget`;
	const shown: string[] = [];
	let used = heading.length + 1 + omitted(blocks.length).length + 1 + size(notes);
	for (const block of blocks) {
		if (used + block.length + 1 > maxChars) continue;
		shown.push(block);
		used += block.length + 1;
	}
	const omittedFiles = blocks.length - shown.length;
	// A heading over no rules states nothing; the counts alone are the honest
	// report. They are admitted against the room actually left, not one at a time,
	// so two diagnostics cannot together overrun a budget each of them fits.
	const head = shown.length === 0 ? [] : [heading, ...shown];
	let left = maxChars - size(head);
	const tail: string[] = [];
	for (const line of [...notes, omitted(omittedFiles)]) {
		if (line.length + 1 > left) continue;
		tail.push(line);
		left -= line.length + 1;
	}
	return { lines: [...head, ...tail], omittedFiles, unreadable };
}
