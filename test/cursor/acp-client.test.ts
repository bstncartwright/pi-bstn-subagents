import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CursorAcpClient, findCursorModelOption, resolveCursorModelValue } from "#src/cursor/acp-client";

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
});

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
});
