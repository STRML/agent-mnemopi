import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const PINNED_OMP_COMMIT = "d9aa759dc54ae138c4b05639bf41c75f6c51e014";
const configuredSource = process.env.OMP_SOURCE?.trim();
if (!configuredSource) throw new Error("OMP_SOURCE must point to an OMP checkout at the pinned public commit");
const source = resolve(configuredSource);
const result = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
if (result.exitCode !== 0) throw new Error(`OMP_SOURCE is not a git checkout: ${source}`);
const commit = new TextDecoder().decode(result.stdout).trim();
if (commit !== PINNED_OMP_COMMIT) throw new Error(`OMP_SOURCE must be pinned at ${PINNED_OMP_COMMIT}; found ${commit}`);

const packages = ["pi-ai", "pi-catalog", "pi-natives", "pi-utils"];
const root = resolve(import.meta.dir, "..");
const scope = join(root, "node_modules", "@oh-my-pi");
mkdirSync(scope, { recursive: true });
for (const name of packages) {
	const target = join(scope, name);
	const packagePath = join(source, "packages", name === "pi-ai" ? "ai" : name === "pi-catalog" ? "catalog" : name === "pi-natives" ? "natives" : "utils");
	if (!existsSync(packagePath)) throw new Error(`Missing OMP package ${packagePath}`);
	if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) rmSync(target, { recursive: true, force: true });
	symlinkSync(packagePath, target, "dir");
}
console.log(`linked OMP ${commit} dependencies from ${source}`);
