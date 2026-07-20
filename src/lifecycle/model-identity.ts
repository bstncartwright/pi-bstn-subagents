import type { SubagentBackend } from "#src/lifecycle/child-session";

/**
 * The model actually negotiated by a child session.
 *
 * `value` is deliberately backend-native: `provider/id` for Pi and ACP's
 * `currentValue` for Cursor. It is not a requested configuration value.
 */
export interface SubagentModelIdentity {
  backend: SubagentBackend;
  displayName: string;
  value: string;
}

/** Derive a durable Pi identity from the SDK session's effective model. */
export function piModelIdentity(model: unknown): SubagentModelIdentity | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
  return {
    backend: "pi",
    displayName: typeof candidate.name === "string" && candidate.name ? candidate.name : candidate.id,
    value: `${candidate.provider}/${candidate.id}`,
  };
}
