import * as path from "node:path";
import { contextForCwd, type AdapterContext } from "./context";
import { runMcpServer } from "./vendor/mnemopi/mcp-server";
import { handleToolCall } from "./vendor/mnemopi/mcp-tools";

function usage(): never {
	console.error("usage: shared-memory <mcp [--cwd ABS]|context --cwd ABS|call TOOL JSON>");
	process.exit(2);
}

function argValue(args: readonly string[], key: string): string | undefined {
	const index = args.indexOf(key);
	return index >= 0 ? args[index + 1] : undefined;
}

function cwdArg(args: readonly string[]): string {
	const value = argValue(args, "--cwd") ?? process.cwd();
	if (!path.isAbsolute(value)) throw new Error(`--cwd must be absolute: ${value}`);
	return path.resolve(value);
}

function configureRuntime(context: AdapterContext): void {
	process.env.MNEMOPI_DATA_DIR = context.dataDir;
	process.env.MNEMOPI_BASE_BANK = context.baseBank;
	process.env.MNEMOPI_BASE_DB_PATH = context.dbPath;
	process.env.MNEMOPI_EMBEDDING_MODEL = context.embeddingModel;
	process.env.MNEMOPI_AUTO_MIGRATE = "0";
	// Never let ambient credentials turn the default local model into a remote
	// OpenRouter/OpenAI embedding call. Explicit mnemopi.embeddingApiUrl remains
	// deliberate configuration and is preserved.
	if (context.embeddingApiUrl) {
		process.env.MNEMOPI_EMBEDDING_API_URL = context.embeddingApiUrl;
	} else {
		delete process.env.MNEMOPI_EMBEDDING_API_URL;
		delete process.env.OPENROUTER_BASE_URL;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.OPENAI_API_KEY;
	}
	if (context.noEmbeddings) process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	else delete process.env.MNEMOPI_NO_EMBEDDINGS;
	// The adapter does not infer an LLM from the host process. A configured
	// mnemopi llmMode is reported by context, but stock MCP has no LLM wiring.
	process.env.MNEMOPI_LLM_ENABLED = "0";
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<void> {
	const mode = argv[0];
	if (!mode) usage();
	if (mode === "context") {
		const context = contextForCwd(cwdArg(argv.slice(1)));
		printJson(context);
		return;
	}
	if (mode === "call") {
		const name = argv[1];
		const raw = argv[2];
		if (!name || raw === undefined) usage();
		const cwd = cwdArg(argv.slice(3));
		const context = contextForCwd(cwd);
		configureRuntime(context);
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be a JSON object");
			args = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(`invalid tool JSON: ${String(error)}`);
		}
		const result = await handleToolCall(name, args);
		printJson(result);
		if (Object.hasOwn(result, "error") || result.status === "error") process.exitCode = 1;
		return;
	}
	if (mode === "mcp") {
		const context = contextForCwd(cwdArg(argv.slice(1)));
		configureRuntime(context);
		await runMcpServer("stdio");
		return;
	}
	usage();
}

if (import.meta.main) {
	try {
		await main(Bun.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export { main };
