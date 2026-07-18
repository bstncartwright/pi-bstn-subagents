import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packed package contains and loads its declared Pi extension entry", async () => {
	const temporary = await mkdtemp(join(root, ".pack-smoke-"));
	try {
		const packed = await run("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: root, encoding: "utf8", timeout: 30_000 }); const rows = JSON.parse(packed.stdout); assert.equal(rows.length, 1); const tarball = join(temporary, rows[0].filename);
		await run("tar", ["-xzf", tarball, "-C", temporary], { cwd: root, timeout: 30_000 }); const extracted = join(temporary, "package"); const metadata = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8")); assert.deepEqual(metadata.pi.extensions, ["./extensions/index.ts"]);
		const files = rows[0].files.map((entry: any) => entry.path); assert.ok(files.includes("extensions/index.ts")); assert.ok(files.includes("extensions/git-worktree.ts")); assert.equal(files.some((path: string) => path.startsWith("test/") || path === "scratch.md" || path === "VENT.md"), false);
		const loaded = await import(`${pathToFileURL(join(extracted, metadata.pi.extensions[0])).href}?pack-smoke=${Date.now()}`); assert.equal(typeof loaded.default, "function");
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
