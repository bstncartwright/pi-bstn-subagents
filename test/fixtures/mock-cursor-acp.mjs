import readline from "node:readline";
import { appendFileSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin });
const sessionId = "cursor-session-1";
let model = process.env.MOCK_INITIAL_MODEL ?? "auto";
let pendingPrompt;

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function configOptions(currentModel = model) {
  return [{
    type: "select",
    id: "cursor-model",
    name: "Model",
    category: "model",
    currentValue: currentModel,
    options: [
      { value: "auto", name: "Auto" },
      { value: "composer-2.5[fast=true]", name: "Composer 2.5" },
    ],
  }];
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const response = { id, result: {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login", description: "test" }],
    } };
    const delay = Number(process.env.MOCK_DELAY_INITIALIZE_MS ?? 0);
    if (delay > 0) setTimeout(() => write(response), delay);
    else write(response);
    return;
  }
  if (method === "authenticate") {
    write({ id, result: {} });
    return;
  }
  if (method === "session/new") {
    write({ id, result: { sessionId, configOptions: configOptions() } });
    return;
  }
  if (method === "session/resume" || method === "session/load") {
    write({ id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === "session/set_config_option") {
    model = params.value;
    if (process.env.MOCK_SET_CONFIG_LOG) appendFileSync(process.env.MOCK_SET_CONFIG_LOG, `${params.value}\n`);
    const response = {
      id,
      result: { configOptions: configOptions(process.env.MOCK_RETURN_CONFIG_MODEL ?? model) },
    };
    const delay = Number(process.env.MOCK_DELAY_SET_CONFIG_MS ?? 0);
    if (delay > 0) setTimeout(() => write(response), delay);
    else write(response);
    return;
  }
  if (method === "session/prompt") {
    const text = params.prompt?.[0]?.text ?? "";
    if (text.includes("wait-for-cancel")) {
      pendingPrompt = id;
      return;
    }
    write({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", kind: "read", status: "in_progress" },
    } });
    write({ id: "permission-1", method: "session/request_permission", params: {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "tool-1", title: "Read file", kind: "read", status: "pending" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
      ],
    } });
    write({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
    } });
    write({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "cursor says done" } },
    } });
    write({ method: "session/update", params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: "usage_update", used: 500, size: 10000 },
    } });
    write({ id, result: { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } });
    return;
  }
  if (method === "session/cancel") {
    if (pendingPrompt !== undefined) {
      write({ id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = undefined;
    }
    return;
  }
  if (method === "session/close") {
    if (process.env.MOCK_HANG_SESSION_CLOSE === "1") return;
    write({ id, result: {} });
    return;
  }
  if (method === "$/cancel_request") return;
  if (id !== undefined) write({ id, error: { code: -32601, message: `unknown method ${method}` } });
}

rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
