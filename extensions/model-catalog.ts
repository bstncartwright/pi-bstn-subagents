import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CURSOR_MODEL_IDS, CURSOR_MODEL_PRESETS } from "./acp.ts";

export interface SubagentModelRow {
	backend: string;
	model: string;
	display_name: string;
	spawn_parameter: string;
	thinking_parameter: string | null;
	supported_thinking_levels: ModelThinkingLevel[];
	fixed_thinking_level: ModelThinkingLevel | null;
	current_parent: boolean;
	availability_source: string;
}

export interface SubagentModelCatalogResult {
	models: SubagentModelRow[];
	total: number;
	offset: number;
	limit: number;
	has_more: boolean;
	next_offset: number | null;
	supported_backends: string[];
	warnings: string[];
}

export interface SubagentModelCatalogParams {
	backend?: string;
	search?: string;
	offset?: number;
	limit?: number;
}

export interface SubagentModelCatalogContext {
	modelRegistry: {
		getAvailable(): Model<Api>[];
		getError(): string | undefined;
	};
	model?: Pick<Model<Api>, "provider" | "id">;
}

export interface SubagentModelAdapterResult {
	models: SubagentModelRow[];
	warnings?: string[];
}

/** Backend IDs intentionally remain open strings so adapters can be added without changing a union. */
export interface SubagentModelAdapter {
	backend: string;
	list(ctx: SubagentModelCatalogContext): SubagentModelAdapterResult | Promise<SubagentModelAdapterResult>;
}

export const DEFAULT_SUBAGENT_MODEL_OFFSET = 0;
export const DEFAULT_SUBAGENT_MODEL_LIMIT = 50;
export const MAX_SUBAGENT_MODEL_LIMIT = 100;

export const PI_SUBAGENT_MODEL_ADAPTER: SubagentModelAdapter = {
	backend: "pi",
	list(ctx) {
		// getAvailable() means auth is configured. It does not make a remote credential check.
		const available = ctx.modelRegistry.getAvailable();
		const loadError = ctx.modelRegistry.getError();
		return {
			models: available.map((model) => ({
				backend: "pi",
				model: `${model.provider}/${model.id}`,
				display_name: model.name,
				spawn_parameter: "pi_model",
				thinking_parameter: "pi_thinking",
				supported_thinking_levels: [...getSupportedThinkingLevels(model)],
				fixed_thinking_level: null,
				current_parent: ctx.model?.provider === model.provider && ctx.model.id === model.id,
				availability_source: "configured_auth",
			})),
			warnings: loadError === undefined ? [] : [`Pi model registry warning: ${loadError}`],
		};
	},
};

export const CURSOR_SUBAGENT_MODEL_ADAPTER: SubagentModelAdapter = {
	backend: "cursor",
	list() {
		// Static presets describe supported configuration only; no ACP process or auth probe runs here.
		return {
			models: CURSOR_MODEL_IDS.map((model) => {
				const preset = CURSOR_MODEL_PRESETS[model];
				return {
					backend: "cursor",
					model,
					display_name: preset.displayName,
					spawn_parameter: "cursor_model",
					thinking_parameter: null,
					supported_thinking_levels: [],
					fixed_thinking_level: preset.fixedThinkingLevel,
					current_parent: false,
					availability_source: "static_preset",
				};
			}),
			warnings: [],
		};
	},
};

export const SUBAGENT_MODEL_ADAPTERS: readonly SubagentModelAdapter[] = [
	PI_SUBAGENT_MODEL_ADAPTER,
	CURSOR_SUBAGENT_MODEL_ADAPTER,
];

function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function validatePagination(offset: number, limit: number): void {
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error("offset must be an integer greater than or equal to 0.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUBAGENT_MODEL_LIMIT) {
		throw new Error(`limit must be an integer from 1 through ${MAX_SUBAGENT_MODEL_LIMIT}.`);
	}
}

export function subagentModelToolResult(catalog: SubagentModelCatalogResult) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }],
		details: catalog,
	};
}

export async function listSubagentModels(
	ctx: SubagentModelCatalogContext,
	params: SubagentModelCatalogParams = {},
	adapters: readonly SubagentModelAdapter[] = SUBAGENT_MODEL_ADAPTERS,
): Promise<SubagentModelCatalogResult> {
	const offset = params.offset ?? DEFAULT_SUBAGENT_MODEL_OFFSET;
	const limit = params.limit ?? DEFAULT_SUBAGENT_MODEL_LIMIT;
	validatePagination(offset, limit);

	const supportedBackends = adapters.map((adapter) => adapter.backend);
	const requestedBackend = params.backend;
	const selected = requestedBackend === undefined
		? adapters
		: adapters.filter((adapter) => adapter.backend === requestedBackend);
	if (selected.length === 0) {
		throw new Error(
			`Unknown subagent model backend ${JSON.stringify(requestedBackend)}. Supported backends: ${supportedBackends.join(", ")}`,
		);
	}

	const models: SubagentModelRow[] = [];
	const warnings: string[] = [];
	for (const adapter of selected) {
		let result: SubagentModelAdapterResult;
		try {
			result = await adapter.list(ctx);
		} catch (error) {
			throw new Error(
				`Failed to list subagent models for backend ${adapter.backend}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		models.push(...result.models);
		warnings.push(...(result.warnings ?? []));
	}

	const search = params.search?.trim().toLowerCase() ?? "";
	const filtered = search
		? models.filter((row) => [row.backend, row.model, row.display_name].some((value) => value.toLowerCase().includes(search)))
		: models;
	filtered.sort((left, right) => compareCodepoints(left.backend, right.backend) || compareCodepoints(left.model, right.model));

	const total = filtered.length;
	const page = filtered.slice(offset, offset + limit);
	const hasMore = offset + page.length < total;
	return {
		models: page,
		total,
		offset,
		limit,
		has_more: hasMore,
		next_offset: hasMore ? offset + limit : null,
		supported_backends: [...supportedBackends],
		warnings,
	};
}
