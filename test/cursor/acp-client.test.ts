import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CursorAcpClient,
  extractCursorModelChoices,
  findCursorModelOption,
  resolveCursorModelValue,
} from "#src/cursor/acp-client";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mock-cursor-acp.mjs");

function client(overrides: ConstructorParameters<typeof CursorAcpClient>[0] = {}) {
  return new CursorAcpClient({
    command: process.execPath,
    args: [mockAgent],
    requestTimeoutMs: 5_000,
    env: { PATH: process.env.PATH ?? "" },
    ...overrides,
  });
}

describe("CursorAcpClient", () => {
  it("initializes, authenticates, discovers a model option, and streams a prompt", async () => {
    const updates = vi.fn();
    const permissions = vi.fn().mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const acp = client({ onUpdate: updates, onPermission: permissions });
    try {
      const started = await acp.start({ cwd: process.cwd(), model: "Composer 2.5" });
      expect(started.sessionId).toBe("cursor-session-1");
      expect(started.model).toBe("Composer 2.5");
      expect(findCursorModelOption(started.configOptions)?.type).toBe("select");
      const result = await acp.prompt("do work");
      expect(result.stopReason).toBe("end_turn");
      expect(updates).toHaveBeenCalled();
      expect(permissions).toHaveBeenCalledOnce();
    } finally {
      await acp.close();
    }
  });

  it("cancels an active prompt and keeps the protocol process alive", async () => {
    const acp = client();
    try {
      await acp.start({ cwd: process.cwd() });
      const prompt = acp.prompt("wait-for-cancel");
      acp.cancel();
      expect((await prompt).stopReason).toBe("cancelled");
      expect(acp.isAlive).toBe(true);
    } finally {
      await acp.close();
    }
  });

  it("uses capability-gated session resume", async () => {
    const acp = client();
    try {
      const started = await acp.start({ cwd: process.cwd(), sessionId: "existing-session" });
      expect(started.loaded).toBe(true);
      expect(started.sessionId).toBe("existing-session");
    } finally {
      await acp.close();
    }
  });

  it("reports advertised model choices on invalid selection and cleans up", async () => {
    const acp = client();
    await expect(acp.start({ cwd: process.cwd(), model: "Imaginary" }))
      .rejects.toThrow(/Available: Auto, Composer 2.5/);
    expect(acp.isAlive).toBe(false);
  });

  it("propagates startup cancellation without waiting for the request timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("stop discovery");
    const acp = client({ requestTimeoutMs: 10_000, env: { PATH: process.env.PATH ?? "", MOCK_DELAY_INITIALIZE_MS: "5000" } });
    const startedAt = Date.now();
    const starting = acp.start({ cwd: process.cwd(), signal: controller.signal });
    setTimeout(() => controller.abort(reason), 10);

    await expect(starting).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(acp.isAlive).toBe(false);
  });

  it("skips graceful ACP close and tears down promptly when aborted after session creation", async () => {
    const controller = new AbortController();
    const reason = new Error("stop after session");
    const acp = client({
      requestTimeoutMs: 10_000,
      env: {
        PATH: process.env.PATH ?? "",
        MOCK_DELAY_SET_CONFIG_MS: "5000",
        MOCK_HANG_SESSION_CLOSE: "1",
      },
    });
    const starting = acp.start({ cwd: process.cwd(), model: "Composer 2.5", signal: controller.signal });
    await waitFor(() => acp.activeSessionId !== undefined);

    const abortedAt = Date.now();
    controller.abort(reason);

    await expect(starting).rejects.toBe(reason);
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(acp.isAlive).toBe(false);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for mock ACP session creation.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("model option helpers", () => {
  const option = {
    type: "select" as const,
    id: "m",
    name: "Runtime model",
    category: "model",
    currentValue: "auto",
    options: [{ value: "auto", name: "Auto" }],
  };

  it("prefers the standard model category and matches names case-insensitively", () => {
    expect(findCursorModelOption([option])).toBe(option);
    expect(resolveCursorModelValue(option, "AUTO")).toEqual({ value: "auto", name: "Auto" });
  });

  it("matches harmless separator differences without a static model catalog", () => {
    const composer = { ...option, options: [{ value: "composer-2.5", name: "composer-2.5" }] };
    expect(resolveCursorModelValue(composer, "Composer 2.5")).toEqual({
      value: "composer-2.5",
      name: "composer-2.5",
    });
  });

  it("extracts grouped choices without changing existing resolution semantics", () => {
    const grouped = {
      ...option,
      options: [{
        group: "premium",
        name: "Premium",
        options: [{ value: "composer-2.5", name: "Composer 2.5" }],
      }],
    };
    expect(extractCursorModelChoices(grouped)).toEqual([{
      value: "composer-2.5",
      name: "Composer 2.5",
      group: { id: "premium", name: "Premium" },
    }]);
    expect(resolveCursorModelValue(grouped, "Composer 2.5")).toEqual({
      value: "composer-2.5",
      name: "Composer 2.5",
    });
  });
});
