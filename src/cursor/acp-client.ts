import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ClientConnection,
  ClientContext,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  AuthenticateResponse,
  NewSessionResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";

export interface CursorAcpClientOptions {
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onUpdate?: (notification: SessionNotification) => void;
  onPermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  onStderr?: (text: string) => void;
}

export interface CursorAcpStartOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  /** Cancels startup requests immediately instead of waiting for their timeout. */
  signal?: AbortSignal;
}

export interface CursorAcpStarted {
  sessionId: string;
  capabilities: AgentCapabilities;
  configOptions: SessionConfigOption[];
  model?: string;
  loaded: boolean;
}

/** `graceful: false` skips ACP session requests and tears down the process directly. */
export interface CursorAcpCloseOptions {
  graceful?: boolean;
}

const HERDR_ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
] as const;

export function cursorChildEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of HERDR_ENV_KEYS) delete env[key];
  return env;
}

function parser<T>(value: unknown): T {
  return value as T;
}

/** One advertised Cursor model choice, retaining its ACP option group when present. */
export interface CursorModelChoice {
  value: string;
  name: string;
  group?: { id: string; name: string };
}

/**
 * Extract model choices from an ACP select option without losing grouped options.
 * Resolution and discovery share this so their view of live ACP values cannot drift.
 */
export function extractCursorModelChoices(option: SessionConfigOption): CursorModelChoice[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((candidate) => {
    if ("group" in candidate) {
      return candidate.options.map((choice) => ({
        value: choice.value,
        name: choice.name,
        group: { id: candidate.group, name: candidate.name },
      }));
    }
    return [{ value: candidate.value, name: candidate.name }];
  });
}

export function findCursorModelOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((option) => option.category === "model")
    ?? options.find((option) => option.id.toLowerCase() === "model")
    ?? options.find((option) => option.name.toLowerCase().includes("model"));
}

export function resolveCursorModelValue(
  option: SessionConfigOption,
  requested: string,
): { value: string; name: string } | undefined {
  const normalized = requested.trim().toLowerCase();
  const choices = extractCursorModelChoices(option);
  const exact = choices.find(
    (candidate) => candidate.value.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
  );
  if (exact) return { value: exact.value, name: exact.name };
  const fuzzyKey = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
  const key = fuzzyKey(requested);
  const fuzzy = choices.filter(
    (candidate) => fuzzyKey(candidate.value) === key || fuzzyKey(candidate.name) === key,
  );
  return fuzzy.length === 1 ? { value: fuzzy[0]!.value, name: fuzzy[0]!.name } : undefined;
}

export class CursorAcpClient {
  private readonly options: Required<Pick<CursorAcpClientOptions, "command" | "args" | "requestTimeoutMs">>
    & Omit<CursorAcpClientOptions, "command" | "args" | "requestTimeoutMs">;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private context?: ClientContext;
  private sessionId?: string;
  private capabilities: AgentCapabilities = {};
  private cancelled = false;
  private closed = false;
  private readonly permissionControllers = new Set<AbortController>();

  constructor(options: CursorAcpClientOptions = {}) {
    this.options = {
      command: options.command ?? process.env.CURSOR_AGENT_BIN ?? "agent",
      args: options.args ?? ["acp"],
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      env: options.env,
      onUpdate: options.onUpdate,
      onPermission: options.onPermission,
      onStderr: options.onStderr,
    };
  }

  get pid(): number | undefined { return this.child?.pid; }
  get activeSessionId(): string | undefined { return this.sessionId; }
  get agentCapabilities(): AgentCapabilities { return this.capabilities; }
  get isAlive(): boolean {
    return !!this.child && this.child.exitCode == null && !this.closed && !this.connection?.signal.aborted;
  }

  async start(options: CursorAcpStartOptions): Promise<CursorAcpStarted> {
    if (this.child) throw new Error("Cursor ACP client is already started.");
    this.child = spawn(this.options.command, [...this.options.args], {
      cwd: options.cwd,
      env: cursorChildEnvironment(this.options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => this.options.onStderr?.(chunk.toString()));
    this.child.on("error", (error) => this.connection?.close(error));

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );
    const app = acp.client({ name: "pi-bstn-subagents" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const controller = new AbortController();
        this.permissionControllers.add(controller);
        if (this.cancelled) controller.abort();
        try {
          return await this.options.onPermission?.(params, controller.signal)
            ?? { outcome: { outcome: "cancelled" } };
        } finally {
          this.permissionControllers.delete(controller);
        }
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (!this.sessionId || params.sessionId === this.sessionId) this.options.onUpdate?.(params);
      })
      .onRequest("cursor/create_plan", parser, () => ({ outcome: { outcome: "accepted" } }))
      .onRequest("cursor/ask_question", parser, () => ({
        outcome: { outcome: "skipped", reason: "Subagents do not fabricate answers to interactive questions." },
      }));

    this.connection = app.connect(stream);
    this.context = this.connection.agent;

    const detachAbort = this.forwardAbort(options.signal);
    try {
      throwIfAborted(options.signal);
      const initialized = await this.request<InitializeResponse>(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "pi-bstn-subagents", title: "Pi BSTN Subagents", version: "1.0.0" },
      }, undefined, options.signal);
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unsupported Cursor ACP protocol version ${initialized.protocolVersion}.`);
      }
      this.capabilities = initialized.agentCapabilities ?? {};

      const cursorLogin = initialized.authMethods?.find((method) => method.id === "cursor_login");
      if (cursorLogin) {
        await this.request<AuthenticateResponse>(acp.methods.agent.authenticate, { methodId: cursorLogin.id }, undefined, options.signal);
      }

      const loaded = !!options.sessionId;
      let configOptions: SessionConfigOption[];
      if (options.sessionId) {
        if (this.capabilities.sessionCapabilities?.resume) {
          const response = await this.request<ResumeSessionResponse>(acp.methods.agent.session.resume, {
            cwd: options.cwd,
            mcpServers: [],
            sessionId: options.sessionId,
          }, undefined, options.signal);
          configOptions = response.configOptions ?? [];
        } else if (this.capabilities.loadSession) {
          const response = await this.request<LoadSessionResponse>(acp.methods.agent.session.load, {
            cwd: options.cwd,
            mcpServers: [],
            sessionId: options.sessionId,
          }, undefined, options.signal);
          configOptions = response.configOptions ?? [];
        } else {
          throw new Error("Cursor ACP does not advertise session resume or load support.");
        }
        this.sessionId = options.sessionId;
      } else {
        const response = await this.request<NewSessionResponse>(acp.methods.agent.session.new, {
          cwd: options.cwd,
          mcpServers: [],
        }, undefined, options.signal);
        this.sessionId = response.sessionId;
        configOptions = response.configOptions ?? [];
      }

      let selectedModel: string | undefined;
      if (options.model) {
        const modelOption = findCursorModelOption(configOptions);
        if (!modelOption) throw new Error("Cursor ACP did not advertise a model configuration option.");
        const selected = resolveCursorModelValue(modelOption, options.model);
        if (!selected) {
          const available = extractCursorModelChoices(modelOption).map((candidate) => candidate.name).join(", ");
          throw new Error(`Unknown Cursor model ${JSON.stringify(options.model)}. Available: ${available || "none"}.`);
        }
        const response = await this.request<SetSessionConfigOptionResponse>(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: modelOption.id,
          value: selected.value,
        }, undefined, options.signal);
        configOptions = response.configOptions;
        const applied = findCursorModelOption(configOptions);
        if (!applied || applied.type !== "select" || applied.currentValue !== selected.value) {
          throw new Error(`Cursor ACP did not apply model ${JSON.stringify(options.model)}.`);
        }
        selectedModel = selected.name;
      }

      return {
        sessionId: this.sessionId!,
        capabilities: this.capabilities,
        configOptions,
        model: selectedModel,
        loaded,
      };
    } catch (error) {
      await this.close({ graceful: !options.signal?.aborted });
      throw error;
    } finally {
      detachAbort();
    }
  }

  async prompt(text: string, signal?: AbortSignal): Promise<PromptResponse> {
    if (!this.sessionId) throw new Error("Cursor ACP session is not initialized.");
    this.cancelled = false;
    if (signal?.aborted) {
      this.cancel();
      return { stopReason: "cancelled" };
    }
    const detach = this.forwardAbort(signal);
    try {
      return await this.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      }, 0, signal);
    } finally {
      detach();
    }
  }

  cancel(): void {
    if (!this.sessionId || !this.context || this.closed) return;
    this.cancelled = true;
    for (const controller of this.permissionControllers) controller.abort();
    void this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {});
  }

  async close(options: CursorAcpCloseOptions = {}): Promise<void> {
    if (this.closed) return;
    const graceful = options.graceful ?? true;
    if (graceful) this.cancel();
    if (graceful && this.sessionId && this.context && this.capabilities.sessionCapabilities?.close) {
      try {
        await this.request(acp.methods.agent.session.close, { sessionId: this.sessionId }, 2_000);
      } catch {
        // Best-effort protocol cleanup; process teardown below is authoritative.
      }
    }
    this.closed = true;
    this.connection?.close();
    this.child?.stdin.end();
    const child = this.child;
    if (!child || child.exitCode != null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 1_500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number | undefined = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.context || this.closed) throw new Error("Cursor ACP process is not running.");
    throwIfAborted(signal);
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs;
    const timeoutController = effectiveTimeout > 0 ? new AbortController() : undefined;
    const timeout = timeoutController
      ? setTimeout(() => timeoutController.abort(), effectiveTimeout)
      : undefined;
    timeout?.unref?.();
    const timeoutSignal = timeoutController?.signal;
    const requestSignal = signal && timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : signal ?? timeoutSignal;
    const request = this.context.request<T, unknown>(
      method,
      params,
      requestSignal ? { cancellationSignal: requestSignal } : undefined,
    );
    let detachAbort = () => {};
    const interrupted = requestSignal
      ? new Promise<never>((_resolve, reject) => {
        const rejectRequest = () => {
          reject(signal?.aborted
            ? abortError(signal)
            : new Error(`Timed out waiting for Cursor ACP ${method}.`));
        };
        requestSignal.addEventListener("abort", rejectRequest, { once: true });
        detachAbort = () => requestSignal.removeEventListener("abort", rejectRequest);
      })
      : undefined;
    try {
      return await Promise.race(interrupted ? [request, interrupted] : [request]);
    } finally {
      clearTimeout(timeout);
      detachAbort();
    }
  }

  private forwardAbort(signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const cancel = () => this.cancel();
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    return () => signal.removeEventListener("abort", cancel);
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
