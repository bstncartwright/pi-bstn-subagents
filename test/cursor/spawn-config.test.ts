import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveSpawnConfig } from "#src/tools/spawn-config";

const registry = new AgentTypeRegistry(() => new Map());
const modelInfo = { parentModel: undefined, modelRegistry: undefined };
const settings = { defaultMaxTurns: undefined };

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveSpawnConfig({
    prompt: "review",
    description: "Review code",
    subagent_type: "general-purpose",
    backend: "cursor",
    ...overrides,
  }, registry, modelInfo, settings);
}

describe("Cursor spawn config", () => {
  it("resolves explicit Cursor backend fields without consulting Pi models", () => {
    const result = resolve({ cursor_model: "Composer 2.5", permission_mode: "deny" });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.execution).toMatchObject({
      backend: "cursor",
      cursorModel: "Composer 2.5",
      permissionMode: "deny",
      model: undefined,
      thinking: undefined,
      effectiveMaxTurns: undefined,
    });
    expect(result.execution.agentInvocation.backend).toBe("cursor");
  });

  it.each([
    [{ model: "openai/gpt" }, /model is Pi-only/],
    [{ thinking: "high" }, /thinking is Pi-only/],
    [{ max_turns: 4 }, /max_turns is unavailable/],
  ])("rejects Pi-only Cursor parameters", (overrides, expected) => {
    expect(resolve(overrides)).toEqual({ error: expect.stringMatching(expected) });
  });

  it("rejects cursor_model on the Pi backend", () => {
    expect(resolve({ backend: "pi", cursor_model: "Auto" })).toEqual({
      error: "cursor_model requires backend=cursor.",
    });
  });
});
