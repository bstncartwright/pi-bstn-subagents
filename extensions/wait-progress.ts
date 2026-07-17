/** Safe, partial-only progress contract for foreground wait tools. */
export type WaitProgressStatus = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "paused" | "closed";
export interface WaitProgressMetrics {
	sampledAt: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }; compactionCount: number;
}
export interface WaitProgressAgent {
	id: string; agentName: string; backend: "pi" | "cursor"; model: string; thinking?: string; status: WaitProgressStatus;
	createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number; closedAt?: number; lastActivityAt: number;
	activity: string | null; turnId?: string; turnSequence?: number; terminalReason?: string; queuePosition?: number; permissionPending: boolean; metrics?: WaitProgressMetrics;
}
export interface WaitProgressPartial {
	v: 1; mode: "one" | "all"; targets: string[]; elapsedMs: number;
	counts: { total: number; queued: number; active: number; settled: number; permissionPending: number };
	agents: WaitProgressAgent[];
}
const final = new Set<WaitProgressStatus>(["completed", "failed", "interrupted", "paused", "closed"]);
export function makeWaitProgress(mode: "one" | "all", targets: readonly string[], agents: readonly WaitProgressAgent[], startedAt: number, now: number): WaitProgressPartial {
	const selected = agents.filter((agent) => targets.includes(agent.agentName)).map((agent) => ({ ...agent, metrics: agent.metrics ? { ...agent.metrics, ...(agent.metrics.contextUsage ? { contextUsage: { ...agent.metrics.contextUsage } } : {}) } : undefined }));
	const counts = { total: selected.length, queued: 0, active: 0, settled: 0, permissionPending: 0 };
	for (const agent of selected) { if (agent.status === "queued") counts.queued++; if (["starting", "running"].includes(agent.status)) counts.active++; if (final.has(agent.status)) counts.settled++; if (agent.permissionPending) counts.permissionPending++; }
	return { v: 1, mode, targets: [...targets], elapsedMs: Math.max(0, now - startedAt), counts, agents: selected };
}
export function formatWaitProgress(progress: WaitProgressPartial): string {
	const elapsed = `${Math.floor(progress.elapsedMs / 60_000)}:${String(Math.floor(progress.elapsedMs / 1000) % 60).padStart(2, "0")}`;
	return `Waiting ${progress.counts.settled}/${progress.counts.total} settled · ${progress.counts.active} active · ${progress.counts.queued} queued${progress.counts.permissionPending ? ` · ${progress.counts.permissionPending} approval` : ""} · ${elapsed}`;
}
export function waitProgressResult(progress: WaitProgressPartial) { return { content: [{ type: "text" as const, text: formatWaitProgress(progress) }], details: { wait_progress: progress } }; }

function compact(value: unknown, max = 72): string {
	const clean = typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\b(token|secret|password)\s*[=:]\s*[^\s,&;]+/gi, "$1=[REDACTED]").replace(/\s+/g, " ").trim() : "";
	const points = Array.from(clean); return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join("")}…` : clean;
}
function usage(agent: WaitProgressAgent): string {
	if (agent.backend === "cursor") return "usage — · context — · compactions —";
	const metrics = agent.metrics; if (!metrics) return "usage — · context — · compactions —";
	const context = metrics.contextUsage?.tokens == null ? "—" : `${metrics.contextUsage.tokens}/${metrics.contextUsage.contextWindow}${metrics.contextUsage.percent == null ? "" : ` ${Math.round(metrics.contextUsage.percent * 10) / 10}%`}`;
	return `usage ${metrics.totalTokens} · context ${context} · compactions ${metrics.compactionCount}`;
}
/** Compact, terminal-safe partial rows for foreground wait renderers. */
export function formatWaitProgressRows(progress: WaitProgressPartial, maxRows = 8): string {
	const header = formatWaitProgress(progress); const rows = progress.agents.slice(0, Math.max(0, maxRows)).map((agent) => {
		const detail = agent.queuePosition !== undefined ? `queue #${agent.queuePosition}` : compact(agent.activity) || "—";
		return `${compact(agent.agentName, 48)} [${agent.backend}] ${agent.status} · ${detail} · ${usage(agent)}`;
	});
	if (progress.agents.length > rows.length) rows.push(`… ${progress.agents.length - rows.length} more targets`);
	return [header, ...rows].join("\n");
}
