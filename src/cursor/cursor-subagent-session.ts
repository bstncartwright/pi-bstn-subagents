import { randomUUID } from "node:crypto";
import type { PromptResponse, SessionNotification, ToolCallStatus, Usage } from "@agentclientprotocol/sdk";
import type { CursorAcpClient } from "#src/cursor/acp-client";
import { CursorTranscript } from "#src/cursor/transcript";
import type {
  ChildSession,
  ChildSessionEvent,
  ChildTranscript,
  TextTranscriptEntry,
  TurnLoopOptions,
  TurnLoopResult,
} from "#src/lifecycle/child-session";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import type { SubagentModelIdentity } from "#src/lifecycle/model-identity";

export interface CursorSubagentSessionOptions {
  client: CursorAcpClient;
  sessionId: string;
  sessionDir: string;
  agentName: string;
  systemPrompt: string;
  parentContext?: string;
  transcriptPath: string;
  lifecycle: ChildLifecyclePublisher;
  modelIdentity?: SubagentModelIdentity;
}

interface ToolState {
  name: string;
  status?: ToolCallStatus | null;
  ended: boolean;
}

function contentText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: string; text?: unknown };
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

function cumulativeUsageDelta(previous: Usage | undefined, next: Usage): ChildSessionEvent {
  return {
    type: "usage",
    input: Math.max(0, next.inputTokens - (previous?.inputTokens ?? 0)),
    output: Math.max(0, next.outputTokens - (previous?.outputTokens ?? 0)),
    cacheWrite: Math.max(0, (next.cachedWriteTokens ?? 0) - (previous?.cachedWriteTokens ?? 0)),
  };
}

export class CursorAcpSubagentSession implements ChildSession {
  readonly backend = "cursor" as const;
  readonly supportsResume = true;
  readonly supportsSteer = false;
  readonly outputFile: string;
  readonly sessionId: string;
  readonly modelIdentity: SubagentModelIdentity | undefined;

  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  private readonly transcript: CursorTranscript;
  private readonly tools = new Map<string, ToolState>();
  private currentAssistantId?: string;
  private currentThoughtId?: string;
  private contextPercent: number | null = null;
  private previousUsage?: Usage;
  private disposed = false;

  constructor(private readonly options: CursorSubagentSessionOptions) {
    this.sessionId = options.sessionId;
    this.outputFile = options.transcriptPath;
    this.modelIdentity = options.modelIdentity;
    this.transcript = new CursorTranscript(options.transcriptPath);
  }

  handleNotification(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId || this.disposed) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (!text) return;
        const id = update.messageId ?? this.currentAssistantId ?? randomUUID();
        if (id !== this.currentAssistantId) {
          this.currentAssistantId = id;
          this.transcript.append(this.entry(id, "assistant", ""));
          this.emit({ type: "response_start" });
        }
        this.transcript.appendText(id, text);
        this.emit({ type: "response_delta", text });
        return;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (!text) return;
        const id = update.messageId ?? this.currentThoughtId ?? randomUUID();
        if (id !== this.currentThoughtId) {
          this.currentThoughtId = id;
          this.transcript.append(this.entry(id, "thought", ""));
        }
        this.transcript.appendText(id, text);
        return;
      }
      case "user_message_chunk": {
        const text = contentText(update.content);
        if (text) this.transcript.append(this.entry(update.messageId ?? randomUUID(), "user", text));
        return;
      }
      case "tool_call": {
        const name = update.title || update.kind || "tool";
        const known = this.tools.get(update.toolCallId);
        if (!known) {
          this.tools.set(update.toolCallId, { name, status: update.status, ended: false });
          this.transcript.append({
            ...this.entry(randomUUID(), "tool", name),
            toolCallId: update.toolCallId,
            toolName: name,
            status: update.status ?? "pending",
          });
          this.emit({ type: "tool_start", toolCallId: update.toolCallId, toolName: name });
        }
        this.finishToolIfTerminal(update.toolCallId, update.status);
        return;
      }
      case "tool_call_update": {
        const known = this.tools.get(update.toolCallId);
        const name = update.title ?? known?.name ?? update.kind ?? "tool";
        if (!known) {
          this.tools.set(update.toolCallId, { name, status: update.status, ended: false });
          this.transcript.append({
            ...this.entry(randomUUID(), "tool", name),
            toolCallId: update.toolCallId,
            toolName: name,
            status: update.status ?? "in_progress",
          });
          this.emit({ type: "tool_start", toolCallId: update.toolCallId, toolName: name });
        } else {
          known.name = name;
          known.status = update.status;
          this.transcript.updateTool(update.toolCallId, { toolName: name, status: update.status ?? undefined });
        }
        this.finishToolIfTerminal(update.toolCallId, update.status);
        return;
      }
      case "usage_update":
        this.contextPercent = update.size > 0 ? (update.used / update.size) * 100 : null;
        this.emit({ type: "context_usage", used: update.used, size: update.size });
        return;
      default:
        return;
    }
  }

  async runTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult> {
    const effective = [
      "<system_instructions>",
      this.options.systemPrompt,
      "</system_instructions>",
      this.options.parentContext,
      prompt,
    ].filter(Boolean).join("\n\n");
    return this.runPrompt(prompt, effective, opts.signal);
  }

  async resumeTurnLoop(prompt: string, signal?: AbortSignal): Promise<TurnLoopResult> {
    return this.runPrompt(prompt, prompt, signal);
  }

  async steer(_message: string): Promise<void> {
    throw new Error("Cursor ACP does not advertise native mid-turn steering.");
  }

  abort(): void {
    this.options.client.cancel();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.transcript.dispose();
    try {
      await this.options.client.close();
    } finally {
      this.options.lifecycle.disposed({ sessionId: this.sessionId, backend: "cursor" });
    }
  }

  subscribe(fn: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getConversation(): string {
    return this.transcript.snapshot()
      .map((entry) => `[${entry.role}${entry.toolName ? `:${entry.toolName}` : ""}]: ${entry.text}`)
      .join("\n\n");
  }

  getContextPercent(): number | null {
    return this.contextPercent;
  }

  getTranscript(): ChildTranscript {
    return { kind: "text", entries: this.transcript.snapshot() };
  }

  private async runPrompt(displayPrompt: string, effectivePrompt: string, signal?: AbortSignal): Promise<TurnLoopResult> {
    this.currentAssistantId = undefined;
    this.currentThoughtId = undefined;
    this.transcript.append(this.entry(randomUUID(), "user", displayPrompt));
    this.emit({ type: "response_start" });
    const response = await this.options.client.prompt(effectivePrompt, signal);
    this.recordUsage(response);
    this.finishOpenTools(response.stopReason === "cancelled");
    this.emit({ type: "turn_end" });
    this.transcript.flush();
    const responseText = this.latestAssistantText();
    const aborted = response.stopReason === "cancelled";
    this.options.lifecycle.completed({
      sessionDir: this.options.sessionDir,
      agentName: this.options.agentName,
      aborted,
      steered: false,
      backend: "cursor",
    });
    if (response.stopReason === "refusal") {
      throw new Error(responseText || "Cursor refused the request.");
    }
    const suffix = response.stopReason === "end_turn" || aborted
      ? ""
      : `\n\n[Cursor stopped: ${response.stopReason}]`;
    return { responseText: responseText + suffix, aborted, steered: false };
  }

  private recordUsage(response: PromptResponse): void {
    if (!response.usage) return;
    this.emit(cumulativeUsageDelta(this.previousUsage, response.usage));
    this.previousUsage = response.usage;
  }

  private finishToolIfTerminal(toolCallId: string, status?: ToolCallStatus | null): void {
    if (status !== "completed" && status !== "failed") return;
    const tool = this.tools.get(toolCallId);
    if (!tool || tool.ended) return;
    tool.ended = true;
    tool.status = status;
    this.transcript.updateTool(toolCallId, { status });
    this.emit({ type: "tool_end", toolCallId, toolName: tool.name, failed: status === "failed" });
  }

  private finishOpenTools(failed: boolean): void {
    for (const [toolCallId, tool] of this.tools) {
      if (tool.ended) continue;
      tool.ended = true;
      const status = failed ? "failed" : "completed";
      this.transcript.updateTool(toolCallId, { status });
      this.emit({ type: "tool_end", toolCallId, toolName: tool.name, failed });
    }
  }

  private latestAssistantText(): string {
    const entries = this.transcript.snapshot();
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.role === "assistant") return entries[index]!.text.trim();
    }
    return "";
  }

  private entry(id: string, role: TextTranscriptEntry["role"], text: string): TextTranscriptEntry {
    return { id, role, text, timestamp: Date.now() };
  }

  private emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
