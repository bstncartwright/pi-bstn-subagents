/**
 * record-observer.ts — Subscribes to session events and accumulates SubagentState stats.
 *
 * Replaces the scattered callback-wrapping logic in SubagentManager's startAgent()
 * and resume() with a single direct subscription. The observer targets the
 * SubagentState value object directly, so it carries no dependency on Subagent;
 * the caller forwards itself to its own lifecycle observer via onCompact.
 */

import type { SubagentState } from "#src/lifecycle/subagent-state";
import type { CompactionInfo, SubscribableSession } from "#src/types";

export interface SubagentObserverOptions {
  onCompact?: (info: CompactionInfo) => void;
}

/**
 * Subscribe to session events and accumulate stats on the subagent state.
 *
 * Consumes the normalized event surface implemented by every child backend.
 *
 * @returns An unsubscribe function.
 */
export function subscribeSubagentObserver(
  session: SubscribableSession,
  state: SubagentState,
  options?: SubagentObserverOptions,
): () => void {
  return session.subscribe((event) => {
    const legacy = event as unknown as {
      type: string;
      toolName?: string;
      toolCallId?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
      message?: { role?: string; usage?: { input: number; output: number; cacheWrite: number } };
      aborted?: boolean;
      reason?: "manual" | "threshold" | "overflow";
      result?: { tokensBefore: number };
    };
    if (legacy.type === "tool_execution_start" && legacy.toolName) {
      state.addActiveTool(legacy.toolName, legacy.toolCallId);
    }
    if (legacy.type === "tool_execution_end" && legacy.toolName) {
      state.removeActiveTool(legacy.toolName, legacy.toolCallId);
      state.incrementToolUses();
    }
    if (legacy.type === "message_start") state.resetResponseText();
    if (legacy.type === "message_update" && legacy.assistantMessageEvent?.type === "text_delta") {
      state.appendResponseText(legacy.assistantMessageEvent.delta ?? "");
    }
    if (legacy.type === "message_end" && legacy.message?.role === "assistant" && legacy.message.usage) {
      state.addUsage(legacy.message.usage);
    }
    if (legacy.type === "compaction_end" && !legacy.aborted && legacy.result && legacy.reason) {
      state.incrementCompactions();
      options?.onCompact?.({ reason: legacy.reason, tokensBefore: legacy.result.tokensBefore });
    }

    if (event.type === "tool_start") {
      state.addActiveTool(event.toolName, event.toolCallId);
    }

    if (event.type === "tool_end") {
      state.removeActiveTool(event.toolName, event.toolCallId);
      state.incrementToolUses();
    }

    if (event.type === "response_start") {
      state.resetResponseText();
    }

    if (event.type === "response_delta") {
      state.appendResponseText(event.text);
    }

    if (event.type === "turn_end") {
      state.incrementTurnCount();
    }

    if (event.type === "usage") {
      state.addUsage(event);
    }

    if (event.type === "context_usage") {
      state.setContextUsage(event.used, event.size);
    }

    if (event.type === "compaction") {
      state.incrementCompactions();
      options?.onCompact?.({
        reason: event.reason,
        tokensBefore: event.tokensBefore,
      });
    }
  });
}
