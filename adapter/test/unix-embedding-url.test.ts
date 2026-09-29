import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { embed } from "../src/vendor/mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "../src/vendor/mnemopi/core/runtime-options";

// A `unix:<path>` embedding API URL addresses `mnemopi embed-serve --socket` (oh-my-pi #13785), the
// shared embeddings server, so Claude/Codex MCP processes need not load their own ONNX runtime.
const MODEL = "BAAI/bge-base-en-v1.5";
let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
	await server?.stop(true);
	server = null;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("unix: embedding API URLs", () => {
	it("sends embedding requests over the named socket and returns its vectors", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "mn-"));
		const socket = path.join(dir, "e.sock");
		const seen: unknown[] = [];
		server = Bun.serve({
			unix: socket,
			async fetch(request) {
				const { pathname } = new URL(request.url);
				if (request.method !== "POST" || pathname !== "/v1/embeddings") return new Response("no", { status: 404 });
				const body = (await request.json()) as { model: string; input: string[] };
				seen.push(body);
				return Response.json({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1] })) });
			},
		});
		const vectors = await withMnemopiRuntimeOptions({ embeddings: { apiUrl: `unix:${socket}`, model: MODEL } }, () =>
			embed(["hello", "sky"]),
		);
		expect(vectors?.map(v => Array.from(v))).toEqual([
			[5, 1],
			[3, 1],
		]);
		expect(seen).toEqual([{ model: MODEL, input: ["hello", "sky"] }]);
	});
});
