/**
 * spawn-config.ts — Pure config resolution for the Agent tool.
 *
 * Extracts all config resolution logic from execute: type resolution,
 * invocation config merge, model resolution, max-turns normalization,
 * tag building, and detail-base construction.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveInvocationModel } from "#src/session/model-resolver";
import type { AgentInvocation, CursorPermissionMode, SubagentBackend, SubagentType, ThinkingLevel } from "#src/types";
import {
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
  getPromptModeLabel,
} from "#src/ui/display";

/** Model info extracted from the parent session context. */
export interface ModelInfo {
  parentModel: Model<any> | undefined;
  modelRegistry: ModelRegistry | undefined;
}

/** Identity: who is being spawned. */
export interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  fellBack: boolean;
  displayName: string;
}

/** Execution: how the agent will run. */
export interface SpawnExecution {
  backend: SubagentBackend;
  prompt: string;
  description: string;
  model: Model<any> | undefined;
  cursorModel: string | undefined;
  permissionMode: CursorPermissionMode;
  effectiveMaxTurns: number | undefined;
  thinking: ThinkingLevel | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
  agentInvocation: AgentInvocation;
}

/** Presentation: display/UI values derived from identity and execution. */
export interface SpawnPresentation {
  modelName: string | undefined;
  agentTags: string[];
  detailBase: Pick<AgentDetails, "backend" | "displayName" | "description" | "subagentType" | "modelName" | "tags">;
}

/** Fully resolved config for spawning an agent — composed of domain-aligned sub-interfaces. */
export interface ResolvedSpawnConfig {
  identity: SpawnIdentity;
  execution: SpawnExecution;
  presentation: SpawnPresentation;
}

/** Error result when model resolution fails. */
export interface SpawnConfigError {
  error: string;
}

/**
 * Resolve all config for an Agent tool invocation.
 *
 * Pure function — no SDK types, no side effects.
 * Returns either a fully resolved config or an error.
 */
export function resolveSpawnConfig(
  params: Record<string, unknown>,
  registry: AgentTypeRegistry,
  modelInfo: ModelInfo,
  settings: { readonly defaultMaxTurns: number | undefined },
): ResolvedSpawnConfig | SpawnConfigError {
  const rawType = params.subagent_type as SubagentType;
  const resolved = registry.resolveType(rawType);

  // A known-but-disabled type is an explicit error, not a silent unknown-type fallback.
  if (resolved !== undefined && !registry.isValidType(resolved)) {
    return { error: `Agent type "${resolved}" is disabled` };
  }

  const subagentType = resolved ?? "general-purpose";
  const fellBack = resolved === undefined;

  const displayName = getDisplayName(subagentType, registry);

  // Merge agent config defaults with tool-call params
  const customConfig = registry.resolveAgentConfig(subagentType);
  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

  if (resolvedConfig.backend !== "pi" && resolvedConfig.backend !== "cursor") {
    return { error: `Unknown subagent backend ${JSON.stringify(resolvedConfig.backend)}. Use "pi" or "cursor".` };
  }
  if (!(["prompt", "allow-once", "deny"] as const).includes(resolvedConfig.permissionMode)) {
    return { error: `Unknown Cursor permission mode ${JSON.stringify(resolvedConfig.permissionMode)}.` };
  }
  if (resolvedConfig.backend === "cursor" && params.model != null) {
    return { error: "model is Pi-only when backend=cursor; use cursor_model." };
  }
  if (resolvedConfig.backend === "cursor" && params.thinking != null) {
    return { error: "thinking is Pi-only when backend=cursor; configure an advertised Cursor model instead." };
  }
  if (resolvedConfig.backend === "cursor" && params.max_turns != null) {
    return { error: "max_turns is unavailable for Cursor because ACP does not expose Pi turn boundaries." };
  }
  if (resolvedConfig.backend === "pi" && params.cursor_model != null) {
    return { error: "cursor_model requires backend=cursor." };
  }

  // Resolve model
  const resolution = resolvedConfig.backend === "pi"
    ? resolveInvocationModel(
      modelInfo.parentModel,
      resolvedConfig.modelInput,
      resolvedConfig.modelFromParams,
      modelInfo.modelRegistry,
    )
    : { model: undefined, error: undefined };
  if (resolution.error) return { error: resolution.error };
  const model = resolution.model;

  const thinking = resolvedConfig.backend === "pi" ? resolvedConfig.thinking : undefined;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;

  // Compute display model name (only shown when different from parent)
  const parentModelId = modelInfo.parentModel?.id;
  const effectiveModelId = model?.id;
  const modelName = resolvedConfig.backend === "cursor"
    ? resolvedConfig.cursorModel
    : effectiveModelId && effectiveModelId !== parentModelId
      ? model?.name.replace(/^Claude\s+/i, "").toLowerCase()
      : undefined;

  const effectiveMaxTurns = resolvedConfig.backend === "pi"
    ? normalizeMaxTurns(resolvedConfig.maxTurns ?? settings.defaultMaxTurns)
    : undefined;

  const agentInvocation: AgentInvocation = {
    modelName,
    thinking,
    maxTurns: resolvedConfig.backend === "pi" ? normalizeMaxTurns(resolvedConfig.maxTurns) : undefined,
    inheritContext,
    runInBackground,
  };
  if (resolvedConfig.backend === "cursor") {
    agentInvocation.backend = "cursor";
    agentInvocation.cursorModel = resolvedConfig.cursorModel;
  }

  const modeLabel = getPromptModeLabel(subagentType, registry);
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;

  const detailBase = {
    backend: resolvedConfig.backend,
    displayName,
    description: params.description as string,
    subagentType,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
  };

  return {
    identity: { subagentType, rawType, fellBack, displayName },
    execution: {
      backend: resolvedConfig.backend,
      prompt: params.prompt as string,
      description: params.description as string,
      model,
      cursorModel: resolvedConfig.cursorModel,
      permissionMode: resolvedConfig.permissionMode,
      effectiveMaxTurns,
      thinking,
      inheritContext,
      runInBackground,
      agentInvocation,
    },
    presentation: { modelName, agentTags, detailBase },
  };
}
