import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import {
	colorViewerFrame,
	parseViewerArgs,
	renderViewerFrame,
} from "../extensions/run-ledger-viewer.ts";
import { buildRunLedgerViewerCommand, quotePosixShell } from "../extensions/unified.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "run-ledger-viewer-"));
	const info = join(dir, "odd ' info.json");
	const journal = join(dir, "odd ; journal.jsonl");
	const raw = join(dir, "odd raw.events.log");
	writeFileSync(info, JSON.stringify({ id: "run", canonicalName: "/Ada", backend: "pi", model: "test", thinking: "high", cwd: "/work", lastTaskMessage: "seed task", status: "running", startedAt: 1000, turn: 3 }));
	writeFileSync(raw, "[old] tool: \u001b[31mred\u001b[0m\n[old] assistant: legacy\n");
	return { dir, info, journal, raw };
}

function journalLine(kind: string, fields: Record<string, unknown>, seq: number, ts = 1000 + seq * 1000) {
	return JSON.stringify({ v: 1, kind, seq, ts, turn: 3, ...fields });
}

test("POSIX viewer command quotes adversarial executable and all paths", () => {
	assert.equal(quotePosixShell("a'$(touch nope); b"), "'a'\\''$(touch nope); b'");
	const command = buildRunLedgerViewerCommand({ nodeExecutable: "/x/node; bad", viewerPath: "/x/viewer '$(x).ts", infoPath: "/x/i ;.json", journalPath: "/x/j $(x)", rawLogPath: "/x/r '" });
	assert.match(command, /^'\/x\/node; bad' --experimental-strip-types --no-warnings /);
	assert.match(command, /'\/x\/viewer '\\''\$\(x\)\.ts'/);
});

test("snapshot renders seeded wide and narrow frames without color", () => {
	const paths = fixture();
	writeFileSync(paths.journal, [
		journalLine("phase", { name: "tail phase" }, 90),
		journalLine("response", { text: "response text" }, 91),
	].join("\n") + "\n");
	const wide = renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 110, height: 8 });
	const narrow = renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 28, height: 5 });
	assert.match(wide, /^RUN \/Ada · running · 1:31 · turn 3/m);
	assert.match(wide, /seed task/);
	assert.match(narrow, /\/Ada/);
	assert.equal(colorViewerFrame(wide, false), wide);
	assert.doesNotMatch(wide, /\x1b/);
	// The run event can age out; the bounded journal tail must still inherit private info.
	writeFileSync(paths.journal, `${"x".repeat(300_000)}\n${journalLine("phase", { name: "new tail" }, 300)}\n`);
	const tailed = renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 100, height: 6 });
	assert.match(tailed, /RUN \/Ada/);
	assert.match(tailed, /seed task/);
	assert.match(tailed, /new tail/);
});

test("missing, malformed, and unsupported journals safely use bounded sanitized legacy fallback", () => {
	const paths = fixture();
	for (const content of ["", "not json\n", '{"v":99}\n']) {
		writeFileSync(paths.journal, content);
		const frame = renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 60, height: 4 });
		assert.match(frame, /Legacy event log/);
		assert.match(frame, /red/);
		assert.doesNotMatch(frame, /\x1b/);
	}
});

test("valid semantic events survive malformed neighbors and an exact bounded tail boundary", () => {
	const paths = fixture();
	writeFileSync(paths.journal, `not json\n${journalLine("task", { synopsis: "valid beside malformed" }, 1)}\n{"v":99}\n`);
	assert.match(renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 90, height: 6 }), /valid beside malformed/);
	const record = `${journalLine("task", { synopsis: "exact boundary" }, 2)}\n`;
	const tail = `${record}${"\n".repeat(256 * 1024 - Buffer.byteLength(record))}`;
	writeFileSync(paths.journal, `${"p".repeat(20)}\n${tail}`);
	assert.match(renderViewerFrame({ infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, width: 90, height: 6 }), /exact boundary/);
});

test("TTY viewer remains alive and redraws after a journal append", async (t) => {
	try { execFileSync("script", ["-q", "/dev/null", "true"], { stdio: "ignore" }); } catch { t.skip("script pseudo-terminal is unavailable"); return; }
	const paths = fixture();
	writeFileSync(paths.journal, `${journalLine("task", { synopsis: "before update" }, 1)}\n`);
	const viewer = new URL("../extensions/run-ledger-viewer.ts", import.meta.url);
	const child = spawn("script", ["-q", "/dev/null", process.execPath, "--experimental-strip-types", "--no-warnings", viewer.pathname, "--info", paths.info, "--journal", paths.journal, "--raw", paths.raw], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk) => { output += chunk.toString(); });
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(child.exitCode, null, "referenced poll interval keeps the TTY viewer alive");
	writeFileSync(paths.journal, `${journalLine("task", { synopsis: "after update" }, 1)}\n${journalLine("response", { text: "redraw marker" }, 2)}\n`);
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.equal(child.exitCode, null);
	assert.match(output, /redraw marker/);
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
});

test("viewer CLI accepts flags, remains import-safe, and launches TypeScript snapshot", () => {
	const paths = fixture();
	writeFileSync(paths.journal, `${journalLine("task", { synopsis: "CLI task" }, 1)}\n`);
	assert.deepEqual(parseViewerArgs(["--info", paths.info, "--journal", paths.journal, "--raw", paths.raw, "--snapshot", "--width", "80", "--height", "6"]), {
		infoPath: paths.info, journalPath: paths.journal, rawLogPath: paths.raw, snapshot: true, width: 80, height: 6,
	});
	assert.equal(parseViewerArgs(["--info", paths.info, "--journal", paths.journal, "--legacy", paths.raw]).rawLogPath, paths.raw);
	const viewer = new URL("../extensions/run-ledger-viewer.ts", import.meta.url);
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", viewer.pathname, "--info", paths.info, "--journal", paths.journal, "--raw", paths.raw, "--snapshot", "--width", "80", "--height", "6"], { encoding: "utf8" });
	assert.match(output, /CLI task/);
	chmodSync(paths.journal, 0o600);
});
