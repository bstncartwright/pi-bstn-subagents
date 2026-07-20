import type { AgentConfig, CursorPermissionMode, SubagentBackend, ThinkingLevel } from "#src/types";

interface AgentInvocationParams {
  model?: string;
  backend?: string;
  cursor_model?: string;
  permission_mode?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  backend: SubagentBackend;
  cursorModel?: string;
  permissionMode: CursorPermissionMode;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  return {
    backend: (params.backend ?? agentConfig?.backend ?? "pi") as SubagentBackend,
    modelInput: agentConfig?.model ?? params.model,
    cursorModel: params.cursor_model ?? agentConfig?.cursorModel,
    permissionMode: (params.permission_mode ?? agentConfig?.permissionMode ?? "prompt") as CursorPermissionMode,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}
