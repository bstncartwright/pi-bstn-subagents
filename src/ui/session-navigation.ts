/**
 * session-navigation.ts — Pure selection and transcript-sourcing for native session navigation.
 *
 * Splits the unit-testable core of the `/subagents:sessions` command from its TUI
 * wiring (`session-navigator.ts`): which subagents are navigable and how a picked
 * agent's transcript is sourced (live, in this slice).
 *
 * The `TranscriptSource` seam decouples *how messages are sourced* (live record
 * here; a file snapshot in a follow-up) from *how they render* — the renderer
 * (`session-navigator.ts`, which mounts Pi's per-entry components) talks only to
 * this seam. Rendering lives in the SDK/TUI module because the per-entry
 * components require a `TUI`, `cwd`, and markdown theme.
 */

import { buildSessionContext, parseSessionEntries, type SessionEntry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { ChildSessionEvent, SessionMessage, SubagentBackend, SubagentType } from "#src/types";
import type { ChildTranscript, TextTranscriptEntry } from "#src/lifecycle/child-session";
import { formatDuration, getDisplayName } from "#src/ui/display";

// ─────────────────────────────────────────────────────────────────────────────

/** The record fields the navigator reads to label and live-source a transcript. */
export interface NavigableSubagent {
  readonly id: string;
  readonly backend: SubagentBackend;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  /** Pi compatibility fields retained for consumers built against the upstream interface. */
  readonly agentMessages: readonly SessionMessage[];
  /** Persisted transcript path, retained after the live session is released. */
  readonly outputFile: string | undefined;
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: ChildSessionEvent) => void): (() => void) | undefined;
  getTranscript?(): ChildTranscript | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/**
 * A navigable entry plus the label shown in the picker.
 *
 * A `live` entry sources its transcript from the in-memory record; a `snapshot`
 * entry sources it from the persisted session file (the session was released by
 * the retention sweep, but the record and its transcript pointer survive).
 */
export type NavigationEntry =
  | { readonly kind: "live"; readonly label: string; readonly record: NavigableSubagent }
  | { readonly kind: "snapshot"; readonly label: string; readonly outputFile: string; readonly backend: SubagentBackend };

/** The fields `buildLabel` reads — shared by the live and snapshot (released-session) label paths. */
interface LabelFields {
  readonly backend: SubagentBackend;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
}

/** Running-agent streaming state, surfaced by a live source. */
export interface StreamingState {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
}

/** Liveness-agnostic transcript source consumed by the renderer. */
export interface TranscriptSource {
  /** Backend that produced this transcript. */
  readonly backend: SubagentBackend;
  readonly kind: "pi" | "text";
  /** Current message history. */
  getMessages(): readonly SessionMessage[];
  getTextEntries(): readonly TextTranscriptEntry[];
  /** Subscribe to changes; returns an unsubscribe, or undefined for a static snapshot. */
  subscribe(onChange: () => void): (() => void) | undefined;
  /** Running-agent streaming state, or undefined when not streaming. */
  streaming(): StreamingState | undefined;
  /** Resolve a registered tool definition by name, for Pi's tool-execution components. */
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/**
 * Label every navigable subagent for the picker: records with a live session
 * source their transcript in-memory (`live`); records whose session the
 * retention sweep released but which retain a transcript pointer source it from
 * disk (`snapshot`). Records with neither are not navigable. Live entries first.
 */
export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  registry: AgentConfigLookup,
): NavigationEntry[] {
  const live: NavigationEntry[] = [];
  const snapshots: NavigationEntry[] = [];
  for (const record of agents) {
    if (record.isSessionReady()) {
      live.push({ kind: "live", record, label: buildLabel(record, registry) });
    } else if (record.outputFile) {
      snapshots.push({ kind: "snapshot", outputFile: record.outputFile, backend: record.backend, label: buildLabel(record, registry, true) });
    }
  }
  return [...live, ...snapshots];
}

/**
 * Source a transcript from a persisted child-session JSONL snapshot.
 *
 * For an agent whose live session the retention sweep released: the in-memory
 * message history is gone, but the session file survives on disk (and the
 * record retains its path). Reads the file, drops the `SessionHeader`, and resolves the
 * message list via Pi's own parser. A static snapshot — no subscription, no
 * streaming, no live tool registry. `readFile` is injected so this module makes
 * no `fs` calls.
 */
export function fileSnapshotSource(
  outputFile: string,
  readFile: (path: string) => string,
  backend: SubagentBackend = "pi",
): TranscriptSource {
  if (backend === "cursor") {
    const entries = readFile(outputFile)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TextTranscriptEntry);
    return {
      backend,
      kind: "text",
      getMessages: () => [],
      getTextEntries: () => entries,
      subscribe: () => undefined,
      streaming: () => undefined,
      getToolDefinition: () => undefined,
    };
  }
  const entries = parseSessionEntries(readFile(outputFile));
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const { messages } = buildSessionContext(sessionEntries);
  return {
    backend,
    kind: "pi",
    getMessages: () => messages,
    getTextEntries: () => [],
    subscribe: () => undefined,
    streaming: () => undefined,
    getToolDefinition: () => undefined,
  };
}

/** Source a transcript live from an in-memory record (this slice's only source). */
export function liveSource(record: NavigableSubagent): TranscriptSource {
  const transcript = () => record.getTranscript?.() ?? {
    kind: "pi" as const,
    messages: record.agentMessages,
    getToolDefinition: (name: string) => record.getToolDefinition(name),
  };
  const initial = transcript();
  return {
    backend: record.backend,
    kind: initial?.kind ?? (record.backend === "cursor" ? "text" : "pi"),
    getMessages: () => {
      const current = transcript();
      return current?.kind === "pi" ? current.messages : [];
    },
    getTextEntries: () => {
      const current = transcript();
      return current?.kind === "text" ? current.entries : [];
    },
    subscribe: (onChange) => record.subscribeToUpdates(() => onChange()),
    streaming: () =>
      record.status === "running"
        ? { activeTools: record.activeTools, responseText: record.responseText }
        : undefined,
    getToolDefinition: (name) => {
      const current = transcript();
      return current?.kind === "pi" ? current.getToolDefinition(name) : undefined;
    },
  };
}

function buildLabel(fields: LabelFields, registry: AgentConfigLookup, released = false): string {
  const name = getDisplayName(fields.type, registry);
  const duration = formatDuration(fields.startedAt, fields.completedAt);
  const marker = released ? " · session released (snapshot)" : "";
  return `${name} (${fields.backend}) · ${fields.description} · ${fields.toolUses} tools · ${fields.status} · ${duration}${marker}`;
}
