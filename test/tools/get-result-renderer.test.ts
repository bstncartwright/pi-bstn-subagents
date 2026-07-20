import { describe, expect, it } from "vitest";
import type { AgentReport } from "#src/tools/get-result-report";
import { renderGetResult, renderGetResultCall } from "#src/tools/get-result-renderer";
import type { Theme } from "#src/ui/display";

const theme: Theme = {
	fg: (color, text) => `[${color}:${text}]`,
	bold: (text) => `**${text}**`,
};

function report(overrides: Partial<AgentReport> = {}): AgentReport {
	return {
		id: "agent-1",
		backend: "pi",
		displayName: "Explore",
		status: "running",
		toolUses: 82,
		tokens: "224.1k token",
		contextPercent: 77,
		compactionCount: 0,
		duration: "298.9s",
		description: "Trace automation tool",
		result: undefined,
		error: undefined,
		transcriptPath: "/long/session/tasks/agent-1.jsonl",
		...overrides,
	};
}

describe("renderGetResult", () => {
	it("renders a compact running card with backend and shortened transcript", () => {
		const text = renderGetResult(report(), false, theme);
		expect(text).toContain("[accent:● running]  **Explore** [dim:(pi)]");
		expect(text).toContain("82 tools");
		expect(text).toContain("[warning:context 77%]");
		expect(text).toContain("Still running");
		expect(text).toContain("…/tasks/agent-1.jsonl");
		expect(text).not.toContain("/long/session/tasks");
	});

	it("shows one-line output when collapsed and full output/path when expanded", () => {
		const completed = report({
			backend: "cursor",
			status: "completed",
			result: "First line\nSecond line",
		});
		expect(renderGetResult(completed, false, theme)).not.toContain("Second line");
		const expanded = renderGetResult(completed, true, theme);
		expect(expanded).toContain("[text:First line]\n[text:Second line]");
		expect(expanded).toContain("/long/session/tasks/agent-1.jsonl");
		expect(expanded).toContain("[dim:(cursor)]");
	});

	it("shows errors without presenting them as successful output", () => {
		const text = renderGetResult(report({ status: "error", error: "timeout" }), false, theme);
		expect(text).toContain("[error:✗ error]");
		expect(text).toContain("[error:timeout]");
	});
});

describe("renderGetResultCall", () => {
	it("renders the ID and requested modes", () => {
		expect(renderGetResultCall({ agent_id: "agent-1", wait: true, verbose: true }, theme))
			.toContain("[toolTitle:**Agent result**]  [muted:agent-1] [dim:(wait, verbose)]");
	});
});
