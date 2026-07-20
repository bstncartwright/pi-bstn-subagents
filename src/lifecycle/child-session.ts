import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "#src/types";

export type SubagentBackend = "pi" | "cursor";
export type CursorPermissionMode = "prompt" | "allow-once" | "deny";

export interface TurnLoopResult {
  responseText: string;
  /** True when execution was cancelled or hard-aborted. */
  aborted: boolean;
  /** Pi-only soft turn-limit completion. Cursor never fabricates this state. */
  steered: boolean;
}

export interface TurnLoopOptions {
  maxTurns?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  signal?: AbortSignal;
}

export type ChildSessionEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; failed: boolean }
  | { type: "response_start" }
  | { type: "response_delta"; text: string }
  | { type: "usage"; input: number; output: number; cacheWrite: number }
  | { type: "turn_end" }
  | { type: "context_usage"; used: number; size: number }
  | {
      type: "compaction";
      reason: "manual" | "threshold" | "overflow";
      tokensBefore: number;
    };

export interface TextTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "thought" | "tool" | "system";
  text: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  status?: string;
}

export type ChildTranscript =
  | {
      kind: "pi";
      messages: readonly SessionMessage[];
      getToolDefinition(name: string): ToolDefinition | undefined;
    }
  | { kind: "text"; entries: readonly TextTranscriptEntry[] };

/** Backend-neutral session contract consumed by Subagent. */
export interface ChildSession {
  readonly backend: SubagentBackend;
  readonly sessionId: string;
  readonly outputFile: string | undefined;
  readonly supportsResume: boolean;
  readonly supportsSteer: boolean;
  /** Pi-only compatibility handle. Cursor intentionally leaves this absent. */
  readonly session?: unknown;

  runTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult>;
  resumeTurnLoop(prompt: string, signal?: AbortSignal): Promise<TurnLoopResult | string>;
  steer(message: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): Promise<void> | void;

  subscribe(fn: (event: ChildSessionEvent) => void): () => void;
  getConversation(): string;
  getContextPercent(): number | null;
  getTranscript(): ChildTranscript;
}
