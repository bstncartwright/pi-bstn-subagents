import { describe, expect, it, vi } from "vitest";
import { discoverCursorModels } from "#src/cursor/discover-cursor-models";

const started = {
  sessionId: "discovery-session",
  capabilities: {},
  loaded: false,
  configOptions: [{
    type: "select" as const,
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "auto",
    options: [{
      group: "recommended",
      name: "Recommended",
      options: [
        { value: "auto", name: "Auto" },
        { value: "composer-2.5", name: "Composer 2.5" },
      ],
    }],
  }],
};

describe("discoverCursorModels", () => {
  it("uses one disposable session and preserves advertised value, name, current choice, and group", async () => {
    const client = { start: vi.fn().mockResolvedValue(started), close: vi.fn() };
    const controller = new AbortController();

    await expect(discoverCursorModels({
      cwd: "/project",
      signal: controller.signal,
      createClient: () => client,
    })).resolves.toEqual([
      { value: "auto", name: "Auto", current: true, group: { id: "recommended", name: "Recommended" } },
      { value: "composer-2.5", name: "Composer 2.5", current: false, group: { id: "recommended", name: "Recommended" } },
    ]);
    expect(client.start).toHaveBeenCalledWith({ cwd: "/project", signal: controller.signal });
    expect(client.close).toHaveBeenCalledWith({ graceful: true });
  });

  it("propagates abort after closing the disposable client", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const client = {
      start: vi.fn(async () => {
        controller.abort(reason);
        return started;
      }),
      close: vi.fn(),
    };

    await expect(discoverCursorModels({
      cwd: "/project",
      signal: controller.signal,
      createClient: () => client,
    })).rejects.toBe(reason);
    expect(client.close).toHaveBeenCalledWith({ graceful: false });
  });
});
