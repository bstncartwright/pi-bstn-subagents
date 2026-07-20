import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { CursorAcpClient, type CursorAcpClientOptions } from "#src/cursor/acp-client";
import { CursorAcpSubagentSession } from "#src/cursor/cursor-subagent-session";
import { resolveCursorPermission } from "#src/cursor/permission";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import type { ShellExec } from "#src/types";
import type { EnvInfo } from "#src/session/env";
import { assembleSessionConfig, type AssemblerIO } from "#src/session/session-config";

export interface CursorSubagentSessionDeps {
  exec: ShellExec;
  detectEnv(exec: ShellExec, cwd: string): Promise<EnvInfo>;
  deriveSessionDir(parentSessionFile: string | undefined, cwd: string): string;
  registry: AgentConfigLookup;
  assemblerIO: AssemblerIO;
  lifecycle: ChildLifecyclePublisher;
  createClient?(options: CursorAcpClientOptions): CursorAcpClient;
  onStderr?(text: string): void;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export async function createCursorSubagentSession(
  params: CreateSubagentSessionParams,
  deps: CursorSubagentSessionDeps,
): Promise<CursorAcpSubagentSession> {
  const parentSessionId = params.parentSession?.parentSessionId;
  deps.lifecycle.spawning({ agentName: params.type, parentSessionId, backend: "cursor" });

  const effectiveCwd = params.cwd ?? params.snapshot.cwd;
  const env = await deps.detectEnv(deps.exec, effectiveCwd);
  const config = assembleSessionConfig(
    params.type,
    {
      cwd: params.snapshot.cwd,
      parentSystemPrompt: params.snapshot.systemPrompt,
      parentModel: params.snapshot.model,
      modelRegistry: params.snapshot.modelRegistry,
    },
    { cwd: params.cwd },
    env,
    deps.registry,
    deps.assemblerIO,
  );

  const queuedUpdates: SessionNotification[] = [];
  let session: CursorAcpSubagentSession | undefined;
  const permissionMode = params.permissionMode ?? "deny";
  const client = (deps.createClient ?? ((options) => new CursorAcpClient(options)))({
    onStderr: deps.onStderr,
    onPermission: (request, signal) =>
      resolveCursorPermission(request, permissionMode, params.requestPermission, signal),
    onUpdate: (notification) => {
      if (session) session.handleNotification(notification);
      else queuedUpdates.push(notification);
    },
  });

  try {
    const started = await client.start({ cwd: config.effectiveCwd, model: params.cursorModel });
    const sessionDir = deps.deriveSessionDir(params.parentSession?.parentSessionFile, config.effectiveCwd);
    const transcriptPath = join(sessionDir, `cursor-${safeSessionId(started.sessionId)}.jsonl`);
    session = new CursorAcpSubagentSession({
      client,
      sessionId: started.sessionId,
      sessionDir,
      agentName: params.type,
      systemPrompt: config.systemPrompt,
      parentContext: params.snapshot.parentContext,
      transcriptPath,
      lifecycle: deps.lifecycle,
    });
    deps.lifecycle.sessionCreated({ sessionId: started.sessionId, parentSessionId, backend: "cursor" });
    for (const notification of queuedUpdates) session.handleNotification(notification);
    return session;
  } catch (error) {
    await client.close();
    throw error;
  }
}
