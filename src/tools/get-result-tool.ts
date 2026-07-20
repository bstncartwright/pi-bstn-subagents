import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { type AgentReport, formatAgentReport } from "#src/tools/get-result-report";
import { renderGetResult, renderGetResultCall } from "#src/tools/get-result-renderer";
import { formatLifetimeTokens } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { formatDuration, getDisplayName, type Theme } from "#src/ui/display";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly registry: AgentConfigLookup,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean },
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return {
				content: [{
					type: "text" as const,
					text: `Agent not found: "${params.agent_id}". Records are cleared at session start/switch, so it may be from a previous session.`,
				}],
				details: undefined as AgentReport | undefined,
			};
		}

		// Wait for completion if requested.
		if (params.wait && record.status === "running" && record.promise) {
			await record.promise;
		}

		// Pull-delivery edge: the parent is collecting the settled outcome here, so
		// mark it consumed. The completion nudge scheduled by onSubagentCompleted
		// re-reads record.consumed at fire time and suppresses itself.
		if (record.status !== "running" && record.status !== "queued") {
			record.markConsumed();
		}

		const report = this.buildReport(record, params.verbose);
		return {
			content: [{ type: "text" as const, text: formatAgentReport(report) }],
			details: report,
		};
	}

	private buildReport(record: Subagent, verbose?: boolean): AgentReport {
		return {
			id: record.id,
			backend: record.backend,
			displayName: getDisplayName(record.type, this.registry),
			status: record.status,
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			description: record.description,
			result: record.result,
			error: record.error,
			conversation: verbose ? record.getConversation() : undefined,
			// Transcript pointer: lets the parent read the full session from disk,
			// and covers verbose after the live session was released (no conversation).
			transcriptPath: record.outputFile,
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"get_subagent_result: Check status and retrieve results from a background agent.",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			renderCall(
				args: { agent_id?: string; wait?: boolean; verbose?: boolean },
				theme: Theme,
			) {
				return new Text(renderGetResultCall(args, theme), 0, 0);
			},
			renderResult(
				result: AgentToolResult<AgentReport | undefined>,
				{ expanded }: ToolRenderResultOptions,
				theme: Theme,
			) {
				if (!result.details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					return new Text(theme.fg("error", text), 0, 0);
				}
				return new Text(renderGetResult(result.details, expanded, theme), 0, 0);
			},
			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean },
				signal: AbortSignal | undefined,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
