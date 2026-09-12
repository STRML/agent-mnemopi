import { lstatSync, readFileSync } from "node:fs";
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
 * OMP caps each file at 120 lines, so three full files can reach roughly 36,000
 * characters, far past anything worth injecting. Measured against 13 real project
 * banks, the largest holds 5,206 characters across all three files and the rest
 * are under 2,400, so this fits every observed project and still bounds the worst
 * case. A file past the cap is left out whole and counted.
 */
export const SHARPSHOOTER_RESERVE_CHARS = 6000;
export const SHARPSHOOTER_HEADING = "PROJECT DECISIONS (sharpshooter; friction-earned rules for this project):";

export interface SharpshooterDecisions {
	/** Rendered block, heading first, already bounded. Empty when nothing is stored. */
	readonly lines: readonly string[];
	/** Whole files left out because the block hit its cap. */
	readonly omittedFiles: number;
}

/** Directory OMP writes this project's decision files to. */
export function sharpshooterBankDir(context: AdapterContext): string {
	return path.join(getMemoriesDir(context.agentDir), "sharpshooter", projectBankSegment(context.cwd));
}

/** Read one file's trimmed content; anything unreadable reads as empty. */
function readFile(dir: string, name: string): string {
	try {
		const file = path.join(dir, name);
		// lstat, not stat: stat follows a link, so a symlink planted in this directory
		// would read any file on disk into the agent's context.
		if (!lstatSync(file).isFile()) return "";
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

/** Age of the injection, so a stale file cannot pass for a current one. */
function consolidatedAt(dir: string, now: Date): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
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
	const dir = sharpshooterBankDir(context);
	const files = SHARPSHOOTER_FILES.map(name => ({ name, content: readFile(dir, name) })).filter(file => file.content.length > 0);
	if (files.length === 0) return { lines: [], omittedFiles: 0 };
	const age = consolidatedAt(dir, now);
	const heading = age ? `${SHARPSHOOTER_HEADING} ${age}` : SHARPSHOOTER_HEADING;
	const blocks = files.map(file => `## ${file.name.slice(0, -3)}\n${file.content}`);
	const size = (values: readonly string[]): number => values.reduce((sum, value) => sum + value.length + 1, 0);
	if (size([heading, ...blocks]) <= maxChars) return { lines: [heading, ...blocks], omittedFiles: 0 };
	// Something will not fit, so the omission line is part of the budget from here on.
	const omitted = (count: number): string => `SHARPSHOOTER FILES OMITTED: count=${count}; they exceeded the block budget`;
	const lines: string[] = [heading];
	let used = heading.length + 1 + omitted(blocks.length).length + 1;
	for (const block of blocks) {
		if (used + block.length + 1 > maxChars) continue;
		lines.push(block);
		used += block.length + 1;
	}
	const omittedFiles = blocks.length - (lines.length - 1);
	// A heading over no rules states nothing; the omission alone is the honest report.
	if (lines.length === 1) return { lines: [omitted(omittedFiles)], omittedFiles };
	return { lines: [...lines, omitted(omittedFiles)], omittedFiles };
}
