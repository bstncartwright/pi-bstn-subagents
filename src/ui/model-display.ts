import type { SubagentModelIdentity } from "#src/lifecycle/model-identity";

/** Short label for compact UI surfaces that already show the backend. */
export function formatCompactModel(model: SubagentModelIdentity | undefined): string | undefined {
  return model?.displayName;
}

/** Durable label that keeps the backend-native value when it adds information. */
export function formatExpandedModel(model: SubagentModelIdentity | undefined): string | undefined {
  if (!model) return undefined;
  return model.displayName === model.value
    ? model.displayName
    : `${model.displayName} (${model.value})`;
}
