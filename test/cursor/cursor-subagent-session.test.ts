import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { CursorAcpClient } from "#src/cursor/acp-client";
import { CursorAcpSubagentSession } from "#src/cursor/cursor-subagent-session";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { subscribeSubagentObserver } from "#src/observation/record-observer";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(promptResponse: PromptResponse = { stopReason: "end_turn" }) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-session-test-"));
  dirs.push(dir);
  const client = {
    prompt: vi.fn().mockResolvedValue(promptResponse),
    cancel: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as CursorAcpClient;
  const lifecycle = {
    spawning: vi.fn(),
    sessionCreated: vi.fn(),
    completed: vi.fn(),
    disposed: vi.fn(),
  };
  const session = new CursorAcpSubagentSession({
    client,
    sessionId: "cursor-1",
    sessionDir: dir,
    agentName: "reviewer",
    systemPrompt: "Review carefully.",
    parentContext: "Parent context.",
    transcriptPath: join(dir, "cursor.jsonl"),
    lifecycle,
  });
  return { client, lifecycle, session, dir };
}

describe("CursorAcpSubagentSession", () => {
	it("exposes the ACP-negotiated model identity", () => {
		const { session } = fixture();
		expect(session.modelIdentity).toBeUndefined();
		const identified = new CursorAcpSubagentSession({
			client: fixture().client,
			sessionId: "cursor-model", sessionDir: "/tmp", agentName: "reviewer", systemPrompt: "x", transcriptPath: "/tmp/cursor-model.jsonl",
			lifecycle: fixture().lifecycle,
			modelIdentity: { backend: "cursor", displayName: "Auto", value: "auto" },
		});
		expect(identified.modelIdentity).toEqual({ backend: "cursor", displayName: "Auto", value: "auto" });
	});
  it("normalizes message, tool, usage, and context events", async () => {
    const { client, session } = fixture({
      stopReason: "end_turn",
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    });
    const state = new SubagentState();
    subscribeSubagentObserver(session, state);
    vi.mocked(client.prompt).mockImplementation(async () => {
      session.handleNotification({ sessionId: "cursor-1", update: {
        sessionUpdate: "tool_call", toolCallId: "t1", title: "Search", status: "in_progress",
      } });
      session.handleNotification({ sessionId: "cursor-1", update: {
        sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed",
      } });
      session.handleNotification({ sessionId: "cursor-1", update: {
        sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Found it." },
      } });
      session.handleNotification({ sessionId: "cursor-1", update: {
        sessionUpdate: "usage_update", used: 500, size: 10_000,
      } });
      return { stopReason: "end_turn", usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 } };
    });

    const result = await session.runTurnLoop("Find it", {});
    expect(result).toEqual({ responseText: "Found it.", aborted: false, steered: false });
    expect(state.toolUses).toBe(1);
    expect(state.lifetimeUsage).toEqual({ input: 10, output: 5, cacheWrite: 0 });
    expect(session.getContextPercent()).toBe(5);
    expect(session.getTranscript().kind).toBe("text");
    expect(readFileSync(session.outputFile!, "utf8")).toContain("Found it.");
    expect(vi.mocked(client.prompt).mock.calls[0]?.[0]).toContain("<system_instructions>");
  });

  it("maps a cancelled prompt to an aborted result", async () => {
    const { session } = fixture({ stopReason: "cancelled" });
    expect(await session.runTurnLoop("stop", {})).toEqual({ responseText: "", aborted: true, steered: false });
  });

  it("rejects steering honestly instead of implementing cancel-and-reprompt", async () => {
    const { session } = fixture();
    expect(session.supportsSteer).toBe(false);
    await expect(session.steer("change direction")).rejects.toThrow(/does not advertise native/);
  });

  it("closes the ACP process and publishes disposal", async () => {
    const { client, lifecycle, session } = fixture();
    await session.dispose();
    expect(client.close).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "cursor-1", backend: "cursor" });
  });
});
