import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CursorAcpClient,
  cursorModelFastSetting,
  cursorModelWithFastDisabled,
  extractCursorModelChoices,
  findCursorModelOption,
  resolveCursorModelValue,
} from "#src/cursor/acp-client";

const mockAgent = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mock-cursor-acp.mjs");

function client(overrides: ConstructorParameters<typeof CursorAcpClient>[0] = {}) {
  const { env, ...rest } = overrides;
  return new CursorAcpClient({
    command: process.execPath,
    args: [mockAgent],
    requestTimeoutMs: 5_000,
    env: { PATH: process.env.PATH ?? "", ...env },
    ...rest,
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
    expect(started.modelIdentity).toEqual({ backend: "cursor", displayName: "Composer 2.5", value: "composer-2.5[fast=false]" });
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

	it("captures Cursor's negotiated current model when no model was requested", async () => {
		const acp = client();
		try {
			const started = await acp.start({ cwd: process.cwd() });
			expect(started.model).toBeUndefined(); // legacy requested-model field
			expect(started.modelIdentity).toEqual({ backend: "cursor", displayName: "Auto", value: "auto" });
		} finally {
			await acp.close();
		}
	});

  it("defaults an omitted non-Auto fast current model to fast=false", async () => {
    const acp = client({ env: { MOCK_INITIAL_MODEL: "composer-2.5[fast=true]" } });
    try {
      const started = await acp.start({ cwd: process.cwd() });
      expect(started.modelIdentity).toEqual({
        backend: "cursor",
        displayName: "Composer 2.5",
        value: "composer-2.5[fast=false]",
      });
    } finally {
      await acp.close();
    }
  });

  it("defaults an unparameterized model request resolved from a fast choice to fast=false", async () => {
    const acp = client();
    try {
      await expect(acp.start({ cwd: process.cwd(), model: "composer-2.5" }))
        .resolves.toMatchObject({
          modelIdentity: { displayName: "Composer 2.5", value: "composer-2.5[fast=false]" },
        });
    } finally {
      await acp.close();
    }
  });

  it("keeps explicitly requested fast=true and fast=false values", async () => {
    const fast = client();
    const nonFast = client();
    try {
      await expect(fast.start({ cwd: process.cwd(), model: "composer-2.5[fast=true]" }))
        .resolves.toMatchObject({ modelIdentity: { value: "composer-2.5[fast=true]" } });
      await expect(nonFast.start({ cwd: process.cwd(), model: "composer-2.5[fast=false]" }))
        .resolves.toMatchObject({
          modelIdentity: { displayName: "Composer 2.5", value: "composer-2.5[fast=false]" },
        });
    } finally {
      await Promise.all([fast.close(), nonFast.close()]);
    }
  });

  it("leaves Auto untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-subagents-acp-"));
    const log = join(directory, "set-config.log");
    writeFileSync(log, "");
    const acp = client({ env: { MOCK_SET_CONFIG_LOG: log } });
    try {
      await expect(acp.start({ cwd: process.cwd(), model: "Auto" }))
        .resolves.toMatchObject({ modelIdentity: { value: "auto" } });
      expect(readFileSync(log, "utf8")).toBe("");
    } finally {
      await acp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a model update when ACP does not return the exact current value", async () => {
    const acp = client({ env: { MOCK_RETURN_CONFIG_MODEL: "composer-2.5[fast=true]" } });
    await expect(acp.start({ cwd: process.cwd(), model: "Composer 2.5" }))
      .rejects.toThrow(/did not apply model/);
    expect(acp.isAlive).toBe(false);
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

  it("reads and changes only Cursor's generic fast parameter", () => {
    const value = "grok-4.5[effort=high,fast=true]";
    expect(cursorModelFastSetting(value)).toBe(true);
    expect(cursorModelWithFastDisabled(value)).toBe("grok-4.5[effort=high,fast=false]");
    expect(cursorModelWithFastDisabled("auto")).toBeUndefined();
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
