/** Compact TUI rendering for get_subagent_result. */

import { basename } from "node:path";
import type { AgentReport } from "#src/tools/get-result-report";
import type { Theme } from "#src/ui/display";
import { formatCompactModel, formatExpandedModel } from "#src/ui/model-display";

function statusPresentation(status: AgentReport["status"], theme: Theme): string {
	switch (status) {
		case "running": return theme.fg("accent", "● running");
		case "queued": return theme.fg("muted", "○ queued");
		case "completed": return theme.fg("success", "✓ completed");
		case "steered": return theme.fg("warning", "✓ completed · turn limit");
		case "stopped": return theme.fg("muted", "■ stopped");
		case "error": return theme.fg("error", "✗ error");
		case "aborted": return theme.fg("error", "✗ aborted");
	}
}

function compactStats(report: AgentReport, theme: Theme): string {
	const stats: string[] = [];
	if (report.toolUses > 0) stats.push(`${report.toolUses} tool${report.toolUses === 1 ? "" : "s"}`);
	if (report.tokens) stats.push(report.tokens);
	if (report.contextPercent !== null) {
		const percent = Math.round(report.contextPercent);
		const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
		stats.push(theme.fg(color, `context ${percent}%`));
	}
	if (report.compactionCount > 0) stats.push(`${report.compactionCount} compaction${report.compactionCount === 1 ? "" : "s"}`);
	stats.push(report.duration);
	return stats.join(theme.fg("dim", " · "));
}

function firstResultLine(report: AgentReport): string {
	const line = report.result?.split("\n").find((candidate) => candidate.trim())?.trim();
	if (!line) return "No output.";
	return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function resultBody(report: AgentReport, expanded: boolean, theme: Theme): string[] {
	if (report.status === "running") {
		return [theme.fg("muted", "Still running · call with wait: true to wait for completion")];
	}
	if (report.status === "queued") return [theme.fg("muted", "Waiting for an execution slot")];
	if (report.status === "error") return [theme.fg("error", report.error ?? "Unknown error")];
	if (report.status === "aborted" || report.status === "stopped") {
		return [theme.fg("warning", report.error ?? firstResultLine(report))];
	}
	const result = expanded ? report.result?.trim() || "No output." : firstResultLine(report);
	return result.split("\n").map((line) => theme.fg(expanded ? "text" : "muted", line));
}

/** Render a compact summary by default and reveal durable details when expanded. */
export function renderGetResult(report: AgentReport, expanded: boolean, theme: Theme): string {
	const backend = theme.fg("dim", `(${report.backend})`);
	const model = formatCompactModel(report.model);
	const header = `${statusPresentation(report.status, theme)}  ${theme.bold(report.displayName)} ${backend}${model ? ` ${theme.fg("dim", `· ${model}`)}` : ""}`;
	const lines = [
		header,
		`${theme.fg("muted", report.description)} ${theme.fg("dim", "·")} ${compactStats(report, theme)}`,
		"",
		...resultBody(report, expanded, theme),
	];

	if (report.conversation && expanded) {
		lines.push("", theme.fg("accent", "Conversation"), ...report.conversation.split("\n"));
	}
	if (expanded) {
		const exactModel = formatExpandedModel(report.model);
		if (exactModel) lines.push("", theme.fg("dim", `model  ${exactModel}`));
	}
	if (report.transcriptPath) {
		const path = expanded ? report.transcriptPath : `…/tasks/${basename(report.transcriptPath)}`;
		lines.push("", theme.fg("dim", `transcript  ${path}`));
	}
	return lines.join("\n");
}

/** Compact call header; the result card carries the detailed state. */
export function renderGetResultCall(
	args: { agent_id?: string; wait?: boolean; verbose?: boolean },
	theme: Theme,
): string {
	const id = args.agent_id ? theme.fg("muted", args.agent_id) : theme.fg("dim", "unknown agent");
	const flags = [args.wait ? "wait" : undefined, args.verbose ? "verbose" : undefined].filter(Boolean);
	return `▸ ${theme.fg("toolTitle", theme.bold("Agent result"))}  ${id}${flags.length ? ` ${theme.fg("dim", `(${flags.join(", ")})`)}` : ""}`;
}
