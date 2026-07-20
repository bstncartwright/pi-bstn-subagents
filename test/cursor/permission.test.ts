import { describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { resolveCursorPermission } from "#src/cursor/permission";

const request: RequestPermissionRequest = {
  sessionId: "s1",
  toolCall: { toolCallId: "t1", title: "Edit file" },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

describe("resolveCursorPermission", () => {
  it("selects only an offered allow-once option", async () => {
    expect(await resolveCursorPermission(request, "allow-once")).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
  });

  it("never escalates allow-once to allow-always", async () => {
    const onlyAlways = { ...request, options: [request.options[0]!] };
    expect(await resolveCursorPermission(onlyAlways, "allow-once")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("uses a rejection option for deny", async () => {
    expect(await resolveCursorPermission(request, "deny")).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("validates prompted selections against offered IDs", async () => {
    const prompt = vi.fn().mockResolvedValue("invented");
    expect(await resolveCursorPermission(request, "prompt", prompt)).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels immediately after turn cancellation", async () => {
    const prompt = vi.fn().mockResolvedValue("once");
    const controller = new AbortController();
    controller.abort();
    expect(await resolveCursorPermission(request, "prompt", prompt, controller.signal)).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompt).not.toHaveBeenCalled();
  });
});
