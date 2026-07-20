import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { CursorPermissionMode } from "#src/lifecycle/child-session";

export type CursorPermissionPrompt = (
  request: RequestPermissionRequest,
  signal?: AbortSignal,
) => Promise<string | undefined>;

function optionByKind(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}

export function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

/** Resolve a permission request without ever inventing or escalating an option. */
export async function resolveCursorPermission(
  request: RequestPermissionRequest,
  mode: CursorPermissionMode,
  prompt?: CursorPermissionPrompt,
  signal?: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (signal?.aborted) return cancelledPermission();

  let option: PermissionOption | undefined;
  if (mode === "allow-once") {
    option = optionByKind(request.options, ["allow_once"]);
  } else if (mode === "deny") {
    option = optionByKind(request.options, ["reject_once", "reject_always"]);
  } else if (prompt) {
    const selected = await prompt(request, signal);
    if (signal?.aborted) return cancelledPermission();
    option = request.options.find((candidate) => candidate.optionId === selected);
  }

  if (!option) return cancelledPermission();
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

export function permissionOptionLabel(option: PermissionOption): string {
  const suffix = option.kind.replaceAll("_", " ");
  return `${option.name} (${suffix})`;
}
