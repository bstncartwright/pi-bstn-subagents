import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	CURSOR_MODEL_IDS,
	CURSOR_MODEL_PRESETS,
	DEFAULT_CURSOR_MODEL,
	isCursorModel,
} from "../extensions/acp.ts";
import {
	CURSOR_SUBAGENT_MODEL_ADAPTER,
	DEFAULT_SUBAGENT_MODEL_LIMIT,
	DEFAULT_SUBAGENT_MODEL_OFFSET,
	listSubagentModels,
	subagentModelToolResult,
	type SubagentModelAdapter,
	type SubagentModelCatalogContext,
	type SubagentModelRow,
} from "../extensions/model-catalog.ts";

function model(input: {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Model<Api> {
	return {
		provider: input.provider,
		id: input.id,
		name: input.name ?? input.id,
		reasoning: input.reasoning ?? false,
		thinkingLevelMap: input.thinkingLevelMap,
	} as Model<Api>;
}

function context(models: Model<Api>[] = [], error?: string): SubagentModelCatalogContext & { availableCalls: number } {
	const ctx = {
		availableCalls: 0,
		modelRegistry: {
			getAvailable() {
				ctx.availableCalls++;
				return models;
			},
			getError() { return error; },
		},
	};
	return ctx;
}

function row(backend: string, modelId: string, displayName = modelId): SubagentModelRow {
	return {
		backend,
		model: modelId,
		display_name: displayName,
		spawn_parameter: `${backend}_model`,
		thinking_parameter: null,
		supported_thinking_levels: [],
		fixed_thinking_level: null,
		current_parent: false,
		availability_source: "test",
	};
}

function adapter(backend: string, models: SubagentModelRow[]): SubagentModelAdapter {
	return { backend, list: () => ({ models }) };
}

test("Pi catalog uses live getAvailable models with exact provider/id and thinking metadata", async () => {
	const available = [
		model({
			provider: "openrouter",
			id: "anthropic/claude:beta",
			name: "Claude Beta",
			reasoning: true,
			thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
		}),
		model({ provider: "plain", id: "chat", name: "Plain Chat" }),
	];
	const ctx = context(available);
	ctx.model = available[0];
	const result = await listSubagentModels(ctx, { backend: "pi" });

	assert.equal(ctx.availableCalls, 1);
	assert.deepEqual(result.models, [
		{
			backend: "pi",
			model: "openrouter/anthropic/claude:beta",
			display_name: "Claude Beta",
			spawn_parameter: "pi_model",
			thinking_parameter: "pi_thinking",
			supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
			fixed_thinking_level: null,
			current_parent: true,
			availability_source: "configured_auth",
		},
		{
			backend: "pi",
			model: "plain/chat",
			display_name: "Plain Chat",
			spawn_parameter: "pi_model",
			thinking_parameter: "pi_thinking",
			supported_thinking_levels: ["off"],
			fixed_thinking_level: null,
			current_parent: false,
			availability_source: "configured_auth",
		},
	]);
	assert.deepEqual(Object.keys(result), [
		"models", "total", "offset", "limit", "has_more", "next_offset", "supported_backends", "warnings",
	]);
	assert.equal(result.offset, DEFAULT_SUBAGENT_MODEL_OFFSET);
	assert.equal(result.limit, DEFAULT_SUBAGENT_MODEL_LIMIT);
});

test("tool output is pretty JSON and details are the exact catalog envelope", async () => {
	const catalog = await listSubagentModels(context(), { backend: "cursor", limit: 1 });
	const output = subagentModelToolResult(catalog);
	assert.equal(output.content[0].text, JSON.stringify(catalog, null, 2));
	assert.deepEqual(JSON.parse(output.content[0].text), output.details);
	assert.strictEqual(output.details, catalog);
});

test("Cursor model IDs, presets, default, and static catalog rows share one definition", async () => {
	assert.deepEqual(CURSOR_MODEL_IDS, ["Auto", "Grok 4.5 High"]);
	assert.equal(DEFAULT_CURSOR_MODEL, "Auto");
	assert.equal(isCursorModel("Auto"), true);
	assert.equal(isCursorModel("Grok 4.5 High"), true);
	assert.equal(isCursorModel("Grok 4.5"), false);
	assert.equal(CURSOR_MODEL_PRESETS.Auto.verifyApplied, false);
	assert.equal(CURSOR_MODEL_PRESETS["Grok 4.5 High"].verifyApplied, true);
	assert.deepEqual(CURSOR_MODEL_PRESETS.Auto.config, [{ id: "model", value: "default" }]);
	assert.deepEqual(CURSOR_MODEL_PRESETS["Grok 4.5 High"].config, [
		{ id: "model", value: "grok-4.5" },
		{ id: "effort", value: "high" },
		{ id: "fast", value: "false" },
	]);

	const result = await listSubagentModels(context(), { backend: "cursor" });
	assert.deepEqual(result.models, [
		{
			backend: "cursor",
			model: "Auto",
			display_name: "Auto",
			spawn_parameter: "cursor_model",
			thinking_parameter: null,
			supported_thinking_levels: [],
			fixed_thinking_level: null,
			current_parent: false,
			availability_source: "static_preset",
		},
		{
			backend: "cursor",
			model: "Grok 4.5 High",
			display_name: "Grok 4.5 High",
			spawn_parameter: "cursor_model",
			thinking_parameter: null,
			supported_thinking_levels: [],
			fixed_thinking_level: "high",
			current_parent: false,
			availability_source: "static_preset",
		},
	]);
	assert.equal(result.warnings.length, 0);
	assert.equal(result.supported_backends.includes(CURSOR_SUBAGENT_MODEL_ADAPTER.backend), true);
});

test("catalog filters, codepoint-sorts, and paginates after filtering", async () => {
	const adapters = [
		adapter("zeta", [row("zeta", "ignored", "Needle")]),
		adapter("alpha", [
			row("alpha", "a-model", "Needle lower"),
			row("alpha", "Z-model", "Needle upper"),
			row("alpha", "other", "No match"),
		]),
	];
	const result = await listSubagentModels(context(), { search: "  NeEdLe ", offset: 1, limit: 1 }, adapters);
	assert.deepEqual(result.models.map((entry) => `${entry.backend}/${entry.model}`), ["alpha/a-model"]);
	assert.equal(result.total, 3);
	assert.equal(result.offset, 1);
	assert.equal(result.limit, 1);
	assert.equal(result.has_more, true);
	assert.equal(result.next_offset, 2);
	assert.deepEqual(result.supported_backends, ["zeta", "alpha"]);
});

test("catalog returns an exact empty page for no matches", async () => {
	const result = await listSubagentModels(context(), { search: "missing" }, [adapter("test", [row("test", "one")])]);
	assert.deepEqual(result, {
		models: [],
		total: 0,
		offset: 0,
		limit: 50,
		has_more: false,
		next_offset: null,
		supported_backends: ["test"],
		warnings: [],
	});
});

test("Pi registry errors become warnings without hiding available models", async () => {
	const result = await listSubagentModels(context([model({ provider: "p", id: "m" })], "invalid models.json"), { backend: "pi" });
	assert.equal(result.models.length, 1);
	assert.deepEqual(result.warnings, ["Pi model registry warning: invalid models.json"]);
});

test("unknown backends report all supported adapter IDs before gathering", async () => {
	let gathered = false;
	const adapters: SubagentModelAdapter[] = [{
		backend: "future",
		list() { gathered = true; return { models: [] }; },
	}];
	await assert.rejects(
		() => listSubagentModels(context(), { backend: "missing" }, adapters),
		/Unknown subagent model backend "missing"\. Supported backends: future/,
	);
	await assert.rejects(
		() => listSubagentModels(context(), { backend: " future " }, adapters),
		/Unknown subagent model backend " future "\. Supported backends: future/,
	);
	assert.equal(gathered, false);
});

test("adapter failures are wrapped with backend context", async () => {
	const broken: SubagentModelAdapter = {
		backend: "broken",
		list() { throw new Error("catalog unavailable"); },
	};
	await assert.rejects(
		() => listSubagentModels(context(), {}, [broken]),
		/Failed to list subagent models for backend broken: catalog unavailable/,
	);
});

test("catalog code enforces integer pagination bounds", async () => {
	for (const offset of [-1, 0.5]) {
		await assert.rejects(() => listSubagentModels(context(), { offset }), /offset must be an integer/);
	}
	for (const limit of [0, 101, 1.5]) {
		await assert.rejects(() => listSubagentModels(context(), { limit }), /limit must be an integer/);
	}
});
