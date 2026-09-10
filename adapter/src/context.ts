import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { computeMnemopiBankScope, extendRecallWithLegacyBanks } from "./vendor/omp-config";
import { getAgentDir, getMemoriesDir } from "@oh-my-pi/pi-utils";

export interface AdapterContext {
	readonly cwd: string;
	readonly agentDir: string;
	readonly dataDir: string;
	readonly dbPath: string;
	readonly retainBank: string;
	readonly globalBank: string;
	readonly recallBanks: readonly string[];
	readonly bank: string;
	readonly baseBank: string;
	readonly scoping: "global" | "per-project" | "per-project-tagged";
	readonly embeddingModel: string;
	readonly noEmbeddings: boolean;
	readonly embeddingApiUrl?: string;
	readonly llmMode: "none" | "smol" | "remote";
	readonly configFiles: readonly string[];
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base: Mapping, overlay: Mapping): Mapping {
	const result: Mapping = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (isMapping(result[key]) && isMapping(value)) result[key] = merge(result[key] as Mapping, value);
		else result[key] = value;
	}
	return result;
}

function expandTilde(value: string): string {
	return value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function parseConfig(filePath: string): Mapping | null {
	if (!existsSync(filePath)) return null;
	let parsed: unknown;
	try {
		const text = readFileSync(filePath, "utf8");
		parsed = filePath.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
	} catch (error) {
		throw new Error(`Cannot parse OMP settings ${filePath}: ${String(error)}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!isMapping(parsed)) throw new Error(`OMP settings must be a mapping: ${filePath}`);
	return parsed;
}

function setting(root: Mapping, key: string): unknown {
	return (isMapping(root.mnemopi) ? root.mnemopi : {})[key];
}

function booleanSetting(root: Mapping, key: string, fallback: boolean): boolean {
	const value = setting(root, key);
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`Unsupported mnemopi.${key}: expected boolean`);
	return value;
}

function stringSetting(root: Mapping, key: string): string | undefined {
	const value = setting(root, key);
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`Unsupported mnemopi.${key}: expected string`);
	return value.trim() || undefined;
}

function readEffectiveSettings(cwd: string): { settings: Mapping; files: string[]; agentDir: string } {
	const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir());
	const globalCandidates = [path.join(agentDir, "config.yml"), path.join(agentDir, "config.yaml")];
	const globalPath = globalCandidates.find(existsSync);
	const files: string[] = [];
	let settings: Mapping = {};
	if (globalPath) {
		settings = merge(settings, parseConfig(globalPath) ?? {});
		files.push(globalPath);
	}
	const projectDir = path.join(path.resolve(cwd), ".omp");
	const projectJson = path.join(projectDir, "settings.json");
	const projectYaml = path.join(projectDir, "config.yml");
	const projectYamlCompat = path.join(projectDir, "config.yaml");
	if (existsSync(projectJson)) {
		settings = merge(settings, parseConfig(projectJson) ?? {});
		files.push(projectJson);
	}
	const projectPath = [projectYaml, projectYamlCompat].find(existsSync);
	if (projectPath) {
		settings = merge(settings, parseConfig(projectPath) ?? {});
		files.push(projectPath);
	}
	return { settings, files, agentDir };
}

function validateBank(value: string | undefined): void {
	if (value === undefined) return;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
		throw new Error(`Unsupported mnemopi.bank '${value}'; use 1-64 alphanumeric, hyphen, or underscore characters`);
	}
}

/** Resolve OMP's effective Mnemopi scope without opening or creating a database. */
export function contextForCwd(cwd: string): AdapterContext {
	if (!path.isAbsolute(cwd)) throw new Error(`context --cwd must be absolute: ${cwd}`);
	const resolvedCwd = path.resolve(cwd);
	const { settings, files, agentDir } = readEffectiveSettings(resolvedCwd);
	const configuredDbPath = stringSetting(settings, "dbPath");
	let dbPath = path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");
	if (configuredDbPath !== undefined) {
		const expandedDbPath = expandTilde(configuredDbPath);
		if (!path.isAbsolute(expandedDbPath)) {
			throw new Error(`Unsupported relative mnemopi.dbPath '${configuredDbPath}'; use an absolute path`);
		}
		dbPath = path.resolve(expandedDbPath);
		if (path.basename(dbPath) !== "mnemopi.db") {
			throw new Error(`Unsupported mnemopi.dbPath '${configuredDbPath}'; adapter requires a mnemopi.db path`);
		}
	}
	const scopingRaw = stringSetting(settings, "scoping") ?? "per-project";
	if (scopingRaw !== "global" && scopingRaw !== "per-project" && scopingRaw !== "per-project-tagged") {
		throw new Error(`Unsupported mnemopi.scoping '${scopingRaw}'`);
	}
	const configuredBank = stringSetting(settings, "bank");
	validateBank(configuredBank);
	const scope = computeMnemopiBankScope(configuredBank, resolvedCwd, scopingRaw);
	const recallBanks = scopingRaw === "global"
		? scope.recallBanks
		: extendRecallWithLegacyBanks(scope.recallBanks, dbPath, resolvedCwd);
	const variant = stringSetting(settings, "embeddingVariant") ?? "en";
	if (variant !== "en" && variant !== "multilingual") throw new Error(`Unsupported mnemopi.embeddingVariant '${variant}'`);
	const embeddingModel = stringSetting(settings, "embeddingModel") ?? process.env.MNEMOPI_EMBEDDING_MODEL?.trim() ??
		(variant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5");
	const llmModeRaw = stringSetting(settings, "llmMode") ?? "none";
	if (llmModeRaw !== "none" && llmModeRaw !== "smol" && llmModeRaw !== "remote") {
		throw new Error(`Unsupported mnemopi.llmMode '${llmModeRaw}'`);
	}
	const embeddingApiUrl = stringSetting(settings, "embeddingApiUrl") ?? (process.env.MNEMOPI_EMBEDDING_API_URL?.trim() || undefined);
	return {
		cwd: resolvedCwd,
		agentDir,
		dataDir: path.dirname(dbPath),
		dbPath,
		bank: scope.bank,
		baseBank: scope.baseBank,
		retainBank: scope.retainBank,
		globalBank: scope.globalBank,
		recallBanks,
		scoping: scopingRaw,
		embeddingModel,
		noEmbeddings: booleanSetting(settings, "noEmbeddings", false),
		embeddingApiUrl,
		llmMode: llmModeRaw,
		configFiles: files,
	};
}
