import { join } from "node:path";
import { DEFAULT_DB_FILENAME } from "../vendor/mnemopi/config";

export interface BankPathOptions {
	readonly dataDir: string;
	readonly baseBank: string;
	readonly baseDbPath: string;
}

/**
 * Resolve a bank using the adapter's canonical layout without touching disk.
 *
 * The literal `default` bank is the legacy sibling of a configured custom
 * base bank, not `banks/default`. A custom base bank still wins when the
 * requested bank equals `baseBank`.
 */
export function resolveBankDbPath(options: BankPathOptions, bank: string): string {
	if (bank === options.baseBank) return options.baseDbPath;
	if (bank === "default") return join(options.dataDir, DEFAULT_DB_FILENAME);
	return join(options.dataDir, "banks", bank, DEFAULT_DB_FILENAME);
}
