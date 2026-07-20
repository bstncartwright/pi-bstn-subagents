import { describe, expect, it, vi } from "vitest";
import { ListSubagentModelsTool, type ListSubagentModelsToolDeps } from "#src/tools/list-subagent-models-tool";
import { makeModel } from "#test/helpers/make-model";

function createTool(overrides: Partial<ListSubagentModelsToolDeps> = {}) {
  return new ListSubagentModelsTool({
    discoverCursorModels: vi.fn(async () => [
      { value: "auto", name: "Auto", current: true },
      { value: "composer-2.5", name: "Composer 2.5", current: false },
    ]),
    ...overrides,
  });
}

function context() {
  return {
    cwd: "/project",
    modelRegistry: {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => [
        makeModel({ provider: "zeta", id: "last" }),
        makeModel({ provider: "anthropic", id: "first" }),
      ]),
    },
  };
}

async function text(
  tool: ListSubagentModelsTool,
  backend?: "pi" | "cursor",
  signal?: AbortSignal,
  ctx = context(),
) {
  const result = await tool.execute({ backend }, signal, ctx as never);
  return result.content[0]?.text ?? "";
}

describe("ListSubagentModelsTool", () => {
  it("lists sorted available Pi models and live Cursor values, names, current selection, and spawn syntax by default", async () => {
    const output = await text(createTool());

    expect(output).toContain("Pi models (use subagent model: \"provider/id\"");
    expect(output).toContain("- anthropic/first\n- zeta/last");
    expect(output).toContain("Cursor ACP models (use subagent backend: \"cursor\" and cursor_model: \"<value>\"");
    expect(output).toContain("name: Auto\n  value: auto\n  current: yes");
    expect(output).toContain("name: Composer 2.5\n  value: composer-2.5\n  current: no");
    expect(output).toContain('subagent({ backend: "cursor", cursor_model: "auto"');
  });

  it("filters Pi and Cursor discovery independently", async () => {
    const discoverCursorModels = vi.fn(async () => []);
    const tool = createTool({ discoverCursorModels });

    const piOnly = await text(tool, "pi");
    expect(piOnly).toContain("Pi models");
    expect(piOnly).not.toContain("Cursor ACP");
    expect(discoverCursorModels).not.toHaveBeenCalled();

    const cursorOnly = await text(tool, "cursor");
    expect(cursorOnly).toContain("Cursor ACP models");
    expect(cursorOnly).not.toContain("Pi models");
    expect(discoverCursorModels).toHaveBeenCalledWith({ cwd: "/project", signal: undefined });
  });

  it("uses the active context model registry rather than construction-time state", async () => {
    const ctx = context();
    ctx.modelRegistry.getAvailable.mockReturnValue([makeModel({ provider: "active", id: "model" })]);

    const output = await text(createTool(), "pi", undefined, ctx);

    expect(output).toContain("active/model");
    expect(output).not.toContain("anthropic/first");
  });

  it("keeps Pi models and returns a clear warning when default Cursor discovery fails", async () => {
    const output = await text(createTool({
      discoverCursorModels: vi.fn().mockRejectedValue(new Error("Cursor CLI unavailable")),
    }));

    expect(output).toContain("Pi models (use subagent model");
    expect(output).toContain("Warning: Cursor model discovery failed: Cursor CLI unavailable");
  });

  it("returns a warning for a Cursor-only discovery failure", async () => {
    const output = await text(createTool({
      discoverCursorModels: vi.fn().mockRejectedValue(new Error("not authenticated")),
    }), "cursor");

    expect(output).toBe("Warning: Cursor model discovery failed: not authenticated");
  });

  it("propagates abort instead of turning it into a Cursor warning", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const tool = createTool({
      discoverCursorModels: vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      }),
    });

    await expect(text(tool, undefined, controller.signal)).rejects.toBe(reason);
  });
});
