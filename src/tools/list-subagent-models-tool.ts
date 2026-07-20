import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  discoverCursorModels,
  type DiscoverCursorModelsOptions,
  type DiscoveredCursorModel,
} from "#src/cursor/discover-cursor-models";
import type { ModelRegistry } from "#src/session/model-resolver";

type BackendFilter = "pi" | "cursor";
type CursorModelDiscoverer = (options: DiscoverCursorModelsOptions) => Promise<DiscoveredCursorModel[]>;

export interface ListSubagentModelsToolDeps {
  discoverCursorModels?: CursorModelDiscoverer;
}

/**
 * Parent-only discovery tool. Pi choices come from the current authenticated
 * registry; Cursor choices come from a newly negotiated, disposable ACP session.
 */
export class ListSubagentModelsTool {
  private readonly discoverCursorModels: CursorModelDiscoverer;

  constructor(private readonly deps: ListSubagentModelsToolDeps = {}) {
    this.discoverCursorModels = deps.discoverCursorModels ?? discoverCursorModels;
  }

  async execute(
    params: { backend?: BackendFilter },
    signal: AbortSignal | undefined,
    ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
  ) {
    const backend = params.backend;
    const includePi = backend !== "cursor";
    const includeCursor = backend !== "pi";
    const sections: string[] = [];

    if (includePi) sections.push(formatPiModels(ctx.modelRegistry as ModelRegistry | undefined));

    if (includeCursor) {
      try {
        const models = await this.discoverCursorModels({ cwd: ctx.cwd, signal });
        sections.push(formatCursorModels(models));
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        sections.push(`Warning: Cursor model discovery failed: ${errorMessage(error)}`);
      }
    }

    return {
      content: [{ type: "text" as const, text: sections.join("\n\n") }],
      details: undefined,
    };
  }

  toToolDefinition() {
    return defineTool({
      name: "list_subagent_models" as const,
      label: "List Subagent Models",
      promptSnippet: "list_subagent_models: Discover authenticated Pi models and live Cursor ACP model values before selecting a subagent model.",
      promptGuidelines: [
        "Use list_subagent_models before setting subagent model or cursor_model; do not guess Cursor model values.",
      ],
      description: `Discover models that can be used for subagents right now.

Use this before guessing a model name. With no backend, it lists both authenticated Pi models and values advertised by a disposable Cursor ACP session. Use backend: "pi" or backend: "cursor" to filter. Cursor values are live ACP values, not a package catalog.

For each Cursor model, copy its exact value into:
subagent({ backend: "cursor", cursor_model: "<advertised value>", subagent_type: "general-purpose", prompt: "...", description: "..." })

Do not include Pi-only model, thinking, or max_turns fields in that Cursor call.`,
      parameters: Type.Object({
        backend: Type.Optional(StringEnum(["pi", "cursor"] as const, {
          description: "Optional backend filter. Omit to list both Pi and Cursor models.",
        })),
      }),
      execute: (
        _toolCallId: string,
        params: { backend?: BackendFilter },
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) => this.execute(params, signal, ctx),
    });
  }
}

function formatPiModels(registry: ModelRegistry | undefined): string {
  if (!registry) return "Pi models (use subagent model: \"provider/id\"; authenticated/available):\n- unavailable: no model registry in the active session";
  const models = (registry.getAvailable?.() ?? registry.getAll())
    .map((model) => `${model.provider}/${model.id}`)
    .sort((left, right) => left.localeCompare(right));
  return models.length > 0
    ? `Pi models (use subagent model: \"provider/id\"; authenticated/available):\n${models.map((model) => `- ${model}`).join("\n")}`
    : "Pi models (use subagent model: \"provider/id\"; authenticated/available):\n- none";
}

function formatCursorModels(models: readonly DiscoveredCursorModel[]): string {
  if (models.length === 0) return "Cursor ACP models (use subagent backend: \"cursor\" and cursor_model: \"<value>\"; advertised live):\n- none";
  return `Cursor ACP models (use subagent backend: \"cursor\" and cursor_model: \"<value>\"; advertised live):\n${models.map((model) => {
    const group = model.group ? `\n  group: ${model.group.name} (${model.group.id})` : "";
    return `- name: ${model.name}\n  value: ${model.value}\n  current: ${model.current ? "yes" : "no"}${group}\n  spawn: subagent({ backend: "cursor", cursor_model: ${JSON.stringify(model.value)}, subagent_type: "general-purpose", prompt: "...", description: "..." })`;
  }).join("\n")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
