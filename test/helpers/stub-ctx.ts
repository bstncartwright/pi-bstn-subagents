/**
 * Stub ExtensionContext for tool.execute() calls in tests.
 *
 * Most tool implementations receive ctx from the Pi framework but rely on
 * injected deps. This typed empty stub remains for tests that do not inspect it.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";

export const STUB_CTX = {} as unknown as ExtensionContext;

export const STUB_SNAPSHOT: ParentSnapshot = {
  cwd: "/test",
  systemPrompt: "test prompt",
  model: undefined,
  modelRegistry: { find: () => undefined },
};
