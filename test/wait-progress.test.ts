import assert from "node:assert/strict";
import test from "node:test";
import { formatWaitProgress, makeWaitProgress } from "../extensions/wait-progress.ts";

test("wait progress is aggregate-only and clones safe metrics", () => {
	const metrics = { sampledAt: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0, contextUsage: { tokens: null, contextWindow: 100, percent: null }, compactionCount: 0 };
	const progress = makeWaitProgress("all", ["/a"], [{ id: "a", agentName: "/a", backend: "pi", model: "m", status: "running", createdAt: 0, updatedAt: 1, lastActivityAt: 1, activity: "Working", permissionPending: false, metrics }], 0, 1_200);
	assert.equal(formatWaitProgress(progress), "Waiting 0/1 settled · 1 active · 0 queued · 0:01");
	assert.notEqual(progress.agents[0]!.metrics, metrics);
	assert.notEqual(progress.agents[0]!.metrics?.contextUsage, metrics.contextUsage);
	assert.doesNotMatch(JSON.stringify(progress), /prompt|response|cwd|approval/i);
});

test("compact wait rows expose safe target state and backend-honest metrics", async () => {
	const { formatWaitProgressRows } = await import("../extensions/wait-progress.ts");
	const progress = makeWaitProgress("all", ["/a", "/b"], [
		{ id: "a", agentName: "/a", backend: "pi", model: "m", status: "queued", createdAt: 0, updatedAt: 1, lastActivityAt: 1, activity: "token=private", queuePosition: 2, permissionPending: false, metrics: { sampledAt: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, cost: 0, contextUsage: { tokens: 20, contextWindow: 100, percent: 20 }, compactionCount: 1 } },
		{ id: "b", agentName: "/b", backend: "cursor", model: "Auto", status: "running", createdAt: 0, updatedAt: 1, lastActivityAt: 1, activity: "Working", permissionPending: true },
	], 0, 2_000);
	assert.equal(formatWaitProgressRows(progress), "Waiting 0/2 settled · 1 active · 1 queued · 1 approval · 0:02\n/a [pi] queued · queue #2 · usage 5 · context 20/100 · compactions 1\n/b [cursor] running · Working · usage — · context — · compactions —");
	assert.doesNotMatch(formatWaitProgressRows(progress), /private|token|prompt|response|cwd/i);
});
