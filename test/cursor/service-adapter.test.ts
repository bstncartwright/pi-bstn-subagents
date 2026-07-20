import { describe, expect, it, vi } from "vitest";
import { SubagentsServiceAdapter } from "#src/service/service-adapter";

const snapshot = {
  cwd: "/project",
  systemPrompt: "parent",
  model: undefined,
  modelRegistry: { find: vi.fn() },
};

function fixture() {
  const manager = {
    spawn: vi.fn().mockReturnValue("cursor-agent-1"),
    getRecord: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    waitForAll: vi.fn(),
    hasRunning: vi.fn(),
    registerWorkspaceProvider: vi.fn(),
  };
  const resolveModel = vi.fn();
  const runtime = {
    currentCtx: { modelRegistry: { find: vi.fn() } },
    buildSnapshot: vi.fn().mockReturnValue(snapshot),
  };
  const service = new SubagentsServiceAdapter(manager, resolveModel, runtime as never);
  return { manager, resolveModel, service };
}

describe("SubagentsService Cursor backend", () => {
  it("spawns Cursor without touching the Pi model registry and defaults permissions to deny", () => {
    const { manager, resolveModel, service } = fixture();
    expect(service.spawn("reviewer", "review", {
      backend: "cursor",
      cursorModel: "Composer 2.5",
    })).toBe("cursor-agent-1");
    expect(resolveModel).not.toHaveBeenCalled();
    expect(manager.spawn).toHaveBeenCalledWith(snapshot, "reviewer", "review", expect.objectContaining({
      backend: "cursor",
      cursorModel: "Composer 2.5",
      permissionMode: "deny",
    }));
  });

  it("rejects cross-backend model parameters", () => {
    const { service } = fixture();
    expect(() => service.spawn("x", "x", { backend: "cursor", model: "openai/gpt" })).toThrow(/Pi-only/);
    expect(() => service.spawn("x", "x", { backend: "pi", cursorModel: "Auto" })).toThrow(/requires backend=cursor/);
  });
});
