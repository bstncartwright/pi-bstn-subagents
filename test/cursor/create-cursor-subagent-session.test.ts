import { describe, expect, it, vi } from "vitest";
import type { CursorAcpClient } from "#src/cursor/acp-client";
import { createCursorSubagentSession } from "#src/cursor/create-cursor-subagent-session";
import { createAgentLookup, createChildLifecycleMock } from "#test/helpers/subagent-session-io";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

describe("createCursorSubagentSession", () => {
  it("forwards the owning subagent signal into ACP startup and force-closes after abort", async () => {
    const controller = new AbortController();
    const reason = new Error("stop startup");
    const client = {
      start: vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as CursorAcpClient;

    await expect(createCursorSubagentSession({
      snapshot: STUB_SNAPSHOT,
      type: "Explore",
      signal: controller.signal,
    }, {
      exec: vi.fn(),
      detectEnv: vi.fn().mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" }),
      deriveSessionDir: vi.fn(),
      registry: createAgentLookup(),
      assemblerIO: { buildAgentPrompt: vi.fn(() => "system") },
      lifecycle: createChildLifecycleMock(),
      createClient: () => client,
    })).rejects.toBe(reason);

    expect(client.start).toHaveBeenCalledWith({
      cwd: "/test",
      model: undefined,
      signal: controller.signal,
    });
    expect(client.close).toHaveBeenCalledWith({ graceful: false });
  });
});
