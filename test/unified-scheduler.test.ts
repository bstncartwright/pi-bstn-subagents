import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parentScopeKey, registerUnifiedSubagents } from "../extensions/unified.ts";
import { parseRunLedgerJsonl } from "../extensions/run-ledger.ts";
import type { HerdrOperations, PiRuntime, PiRuntimeAgent, UnifiedSubagentDependencies } from "../extensions/unified-deps.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };
function api() {
	const tools = new Map<string, Tool>(); const events = new Map<string, Array<(...args: any[]) => unknown>>();
	return { tools, registerTool(tool: Tool) { tools.set((tool as any).name, tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, fn: any) { events.set(name, [...(events.get(name) ?? []), fn]); }, async emit(name: string, ...args: any[]) { for (const fn of events.get(name) ?? []) await fn(...args); }, getThinkingLevel: () => "low", getActiveTools: () => ["read"], getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }], sendMessage() {} } as any;
}
function ctx(parent: string, cwd: string) { return { cwd, mode: "json", model: { provider: "test", id: "model" }, modelRegistry: { find: () => ({}) }, sessionManager: { getSessionId: () => parent, getSessionFile: () => join(cwd, `${parent}.jsonl`) }, ui: { setWidget() {}, notify() {} } } as any; }
async function call(api: any, name: string, params: unknown, context: any) { return api.tools.get(name)!.execute("id", params, undefined, undefined, context); }
async function ticks(count = 4) { for (let index = 0; index < count; index++) await new Promise<void>((resolve) => setImmediate(resolve)); }

class SchedulerFakes {
	readonly starts: string[] = []; readonly prompts = new Map<string, { handlers: any; prompt?: string; token?: string }>();
	readonly cursors = new Map<string, { handlers: any; prompt?: string; token?: string; resolve?: (value: { stopReason?: string }) => void }>();
	readonly viewers: string[] = []; readonly closedViewers: string[] = []; readonly parentStates: boolean[] = []; private dependencySerial = 0; private clock = 10_000;
	createPi = (info: PiRuntimeAgent, handlers: { onEvent(event: unknown): void; onExit(error?: Error): void }): PiRuntime => {
		this.starts.push(info.canonicalName); this.prompts.set(info.canonicalName, { handlers });
		return { start: async () => {}, prompt: async (message, token) => { const record = this.prompts.get(info.canonicalName)!; record.prompt = message; record.token = token; }, steer: async (message) => { this.prompts.get(info.canonicalName)!.prompt = message; }, abort: async () => {}, close: async () => {} };
	};
	settle(name: string, output = `done:${name}`, token?: string) { const record = this.prompts.get(name); assert.ok(record, `runtime ${name}`); record.handlers.onEvent({ type: "settled", output }, token ?? record.token); }
	settleCursor(cwd: string, output: string) { const record = this.cursors.get(cwd); assert.ok(record); record.handlers.onNotification({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } } } }, record.token); record.resolve?.({}); }
	deps(root: string): UnifiedSubagentDependencies {
		let serial = 0; const scope = ++this.dependencySerial;
		const herdr: HerdrOperations = { ensure: async () => {}, createViewer: async (info) => { this.viewers.push(info.canonicalName); return { paneId: `pane-${info.id}`, tabId: `tab-${info.id}` }; }, closeViewer: async (info) => { this.closedViewers.push(info.canonicalName); }, reportParent: async (working) => { this.parentStates.push(working); } };
		return { clock: () => ++this.clock, uuid: () => `d${scope}-id-${++serial}`, paths: { root, configPath: join(root, "config.json"), agentsDir: join(root, "agents"), runsDir: join(root, "runs"), cursorConfigPath: join(root, "cursor.json") }, herdr, createPiRuntime: this.createPi,
			createCursorRuntime: (cwd, handlers) => {
				const record: { handlers: any; prompt?: string; token?: string; resolve?: (value: { stopReason?: string }) => void } = { handlers }; this.cursors.set(cwd, record);
				return { start: async () => ({ sessionId: "cursor", model: "Auto", configOptions: [], agentCapabilities: {}, loaded: false }), prompt: async (message: string, token?: string) => { record.prompt = message; record.token = token; return new Promise<{ stopReason?: string }>((resolve) => { record.resolve = resolve; }); }, cancel: () => record.resolve?.({}), close: async () => {} };
			},
		};
	}
}

async function spawnMany(instance: any, context: any, names: string[]) {
	for (const name of names) { const result = await call(instance, "spawn_agent", { task_name: name, message: name, backend: "pi" }, context); assert.equal(result.details.status, "queued"); assert.ok(result.details.turn_id); }
}

test("parent FIFO admits four, keeps queued viewers visible, and releases slots independently", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-scheduler-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root));
	const a = ctx("parent-a", root); const b = ctx("parent-b", root);
	try {
		await spawnMany(instance, a, ["a1", "a2", "a3", "a4", "a5"]); await ticks();
		assert.equal(fakes.starts.filter((name) => name.startsWith("/a")).length, 4);
		assert.deepEqual(fakes.viewers.filter((name) => name.startsWith("/a")), ["/a1", "/a2", "/a3", "/a4", "/a5"]);
		let listed = await call(instance, "list_agents", {}, a); assert.equal(listed.details.agents.find((entry: any) => entry.agent_name === "/a5")!.agent_status, "queued");
		const queuedWait = call(instance, "wait_agent", { targets: ["a5"] }, a); let done = false; void queuedWait.finally(() => { done = true; }); await ticks(); assert.equal(done, false);
		fakes.settle("/a1"); await ticks(); assert.equal(fakes.starts.filter((name) => name.startsWith("/a")).length, 5);
		await spawnMany(instance, b, ["b1", "b2", "b3", "b4"]); await ticks(); assert.equal(fakes.starts.filter((name) => name.startsWith("/b")).length, 4, "another parent owns independent slots");
		await call(instance, "spawn_agent", { task_name: "a6", message: "queued", backend: "pi" }, a); await ticks(); assert.equal(fakes.starts.includes("/a6"), false);
		await call(instance, "interrupt_agent", { target: "a6" }, a); assert.equal(fakes.starts.includes("/a6"), false, "queued interrupt never launches a runtime");
		await call(instance, "close_agent", { target: "a6" }, a); assert.ok(fakes.closedViewers.includes("/a6"), "queued close cleans its immediate viewer");
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});

test("reload reconciles old work, projections regenerate, corruption fails closed, and legacy info migrates", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-reload-")); const firstFakes = new SchedulerFakes(); const first = api(); registerUnifiedSubagents(first, firstFakes.deps(root)); const context = ctx("reload-parent", root);
	try {
		await spawnMany(first, context, ["r1", "r2", "r3", "r4", "r5"]); await ticks();
		const startedBeforeReload = firstFakes.starts.length; const second = api(); registerUnifiedSubagents(second, firstFakes.deps(root));
		const afterReload = await call(second, "list_agents", {}, context);
		assert.equal(afterReload.details.agents.filter((entry: any) => entry.agent_status === "interrupted").length, 4);
		assert.equal(afterReload.details.agents.find((entry: any) => entry.agent_name === "/r5")!.agent_status, "paused");
		assert.equal(firstFakes.starts.length, startedBeforeReload, "reconciliation never auto-dispatches old work");
		const queued = await call(second, "send_message", { target: "r5", message: "fresh after reload" }, context); assert.ok(queued.details.turn_id); await ticks(); assert.equal(firstFakes.starts.length, startedBeforeReload + 1);
		// Old manager callbacks see lost epoch ownership and cannot reclaim or mutate fresh work.
		firstFakes.settle("/r1", "stale-old-manager");
		const afterStale = await call(second, "list_agents", {}, context); assert.equal(afterStale.details.agents.find((entry: any) => entry.agent_name === "/r5")!.agent_status, "running");
		const scope = join(root, "runs", parentScopeKey("reload-parent")); const info = readdirSync(scope).find((name) => name.endsWith(".info.json"))!; unlinkSync(join(scope, info));
		await call(second, "get_agent_missing_does_not_exist", {}, context).catch(() => undefined); // no authority read path
		await call(second, "list_agents", {}, context); assert.equal(existsSync(join(scope, info)), true, "manifest read regenerates deleted compatibility projection");
		writeFileSync(join(scope, "queue.manifest.json"), "{not json"); await assert.rejects(() => call(second, "list_agents", {}, context), /manifest is corrupt|manifest is unreadable/);
	} finally { rmSync(root, { recursive: true, force: true }); }

	const legacyRoot = await mkdtemp(join(tmpdir(), "pi-legacy-")); const legacyScope = join(legacyRoot, "runs", parentScopeKey("legacy-parent")); const id = "legacy-id";
	try {
		const info = { id, taskName: "legacy", canonicalName: "/legacy", backend: "pi", parentSessionId: "legacy-parent", cwd: legacyRoot, model: "test:model", provider: "test", modelId: "model", thinking: "low", tools: "read", skills: [], skillPaths: [], extensions: [], extensionPaths: [], permissionMode: "agent", infoFile: join(legacyScope, `${id}.info.json`), logFile: join(legacyScope, `${id}.events.log`), responseFile: join(legacyScope, `${id}.response.txt`), sessionFile: join(legacyScope, `${id}.session.jsonl`), createdAt: 1, updatedAt: 2, lastActivity: 2, turn: 1, status: "running" };
		mkdirSync(legacyScope, { recursive: true }); writeFileSync(info.infoFile, JSON.stringify(info)); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(legacyRoot));
		const migrated = await call(instance, "list_agents", {}, ctx("legacy-parent", legacyRoot)); assert.equal(migrated.details.agents[0].agent_status, "interrupted"); assert.equal(existsSync(join(legacyScope, "queue.manifest.json")), true);
	} finally { rmSync(legacyRoot, { recursive: true, force: true }); }
});


test("Cursor correction transfers an active slot and target waits observe only its successor", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-cursor-correction-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root)); const context = ctx("cursor-parent", root);
	try {
		await call(instance, "spawn_agent", { task_name: "cursor", message: "old", backend: "cursor", cursor_model: "Auto" }, context);
		await spawnMany(instance, context, ["p1", "p2", "p3"]); await new Promise((resolve) => setTimeout(resolve, 350));
		const before = (await call(instance, "list_agents", {}, context)).details.agents.find((entry: any) => entry.agent_name === "/cursor");
		const waiting = call(instance, "wait_agent", { targets: ["cursor"] }, context);
		const correction = await call(instance, "send_message", { target: "cursor", message: "new" }, context);
		assert.equal(correction.details.delivery, "cancel-and-prompt"); assert.notEqual(correction.details.turn_id, before.turn_id);
		// The canceled prompt settles before successor dispatch; its generation cannot terminal the new turn.
		fakes.settleCursor(root, "successor"); const event = await waiting;
		assert.equal(event.details.turn_id, correction.details.turn_id); assert.match(event.content[0].text, /successor/);
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});


test("fresh Pi handle rejects a late old-turn token after a follow-up", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-turn-token-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root)); const context = ctx("token-parent", root);
	try {
		await call(instance, "spawn_agent", { task_name: "token", message: "old", backend: "pi" }, context); await ticks();
		const oldToken = fakes.prompts.get("/token")!.token!; fakes.settle("/token", "old-result", oldToken);
		await call(instance, "send_message", { target: "token", message: "new", }, context); await ticks();
		const record = fakes.prompts.get("/token")!; assert.notEqual(record.token, oldToken);
		record.handlers.onEvent({ type: "text", text: "late-old-text" }, oldToken);
		const wait = call(instance, "wait_agent", { targets: ["token"] }, context); fakes.settle("/token", "new-result", record.token);
		const result = await wait; assert.match(result.content[0].text, /new-result/); assert.doesNotMatch(result.content[0].text, /late-old-text/);
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});

test("wait_all validates every explicit target before observing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-waitall-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root)); const context = ctx("waitall-parent", root);
	try {
		await call(instance, "spawn_agent", { task_name: "valid", message: "x", backend: "pi" }, context); await ticks();
		await assert.rejects(() => call(instance, "wait_all_agents", { targets: ["valid", "typo"] }, context), /Agent not found in this parent session: \/typo/);
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});


test("attached parent Herdr state follows only its own outstanding manifest turns", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-state-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root));
	const a = ctx("herdr-a", root); const b = ctx("herdr-b", root);
	try {
		await instance.emit("session_start", {}, a);
		await call(instance, "spawn_agent", { task_name: "a", message: "a", backend: "pi" }, a); await ticks();
		assert.equal(fakes.parentStates.at(-1), true);
		fakes.settle("/a"); await ticks(); assert.equal(fakes.parentStates.at(-1), false);
		const reportsAfterA = fakes.parentStates.length;
		await call(instance, "spawn_agent", { task_name: "b", message: "b", backend: "pi" }, b); await ticks();
		assert.equal(fakes.parentStates.length, reportsAfterA, "work in an unattached parent cannot report A working");
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});

test("response write failure terminals failed and releases the scheduler slot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-response-write-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root)); const context = ctx("response-parent", root);
	try {
		await spawnMany(instance, context, ["a1", "a2", "a3", "a4", "a5"]); await ticks();
		const scope = join(root, "runs", parentScopeKey("response-parent")); const projection = readdirSync(scope).filter((name) => name.endsWith(".info.json")).find((name) => JSON.parse(readFileSync(join(scope, name), "utf8")).taskName === "a1")!;
		const responsePath = join(scope, `${projection.slice(0, -".info.json".length)}.response.txt`); rmSync(responsePath, { force: true }); mkdirSync(responsePath);
		fakes.settle("/a1", "cannot persist"); await ticks();
		const listed = await call(instance, "list_agents", {}, context); const failed = listed.details.agents.find((entry: any) => entry.agent_name === "/a1");
		assert.equal(failed.agent_status, "failed"); assert.equal(failed.terminal_reason, "response-write-failed");
		assert.equal(fakes.starts.filter((name) => name.startsWith("/a")).length, 5, "failed terminal releases the fifth FIFO slot");
	} finally { await instance.emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); }
});

test("shutdown does not append interrupted terminal records to an already completed journal", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-shutdown-journal-")); const fakes = new SchedulerFakes(); const instance = api(); registerUnifiedSubagents(instance, fakes.deps(root)); const context = ctx("journal-parent", root);
	try {
		await call(instance, "spawn_agent", { task_name: "done", message: "done", backend: "pi" }, context); await ticks(); fakes.settle("/done", "done"); await ticks();
		const scope = join(root, "runs", parentScopeKey("journal-parent")); const journal = join(scope, readdirSync(scope).find((name) => name.endsWith(".viewer.jsonl"))!);
		const before = parseRunLedgerJsonl(await (await import("node:fs/promises")).readFile(journal, "utf8")).events.length;
		await instance.emit("session_shutdown");
		const events = parseRunLedgerJsonl(await (await import("node:fs/promises")).readFile(journal, "utf8")).events;
		assert.equal(events.length, before, "settled journal receives no shutdown terminal rewrite");
		assert.equal(events.filter((event) => event.kind === "completion" && event.status === "interrupted").length, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
