import { expect, it } from "vitest";
import { CursorAcpClient, findCursorModelOption } from "#src/cursor/acp-client";

const live = process.env.CURSOR_ACP_LIVE === "1" ? it : it.skip;

live("prompts the installed Cursor CLI over ACP", { timeout: 120_000 }, async () => {
  let output = "";
  const client = new CursorAcpClient({
    requestTimeoutMs: 30_000,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onUpdate(notification) {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        output += update.content.text;
      }
    },
  });
  try {
    const started = await client.start({
      cwd: process.cwd(),
      model: process.env.CURSOR_ACP_MODEL,
    });
    expect(findCursorModelOption(started.configOptions)).toBeDefined();
    const result = await client.prompt("Reply exactly CURSOR_ACP_SMOKE_OK. Do not use tools.");
    expect(result.stopReason).toBe("end_turn");
    expect(output).toContain("CURSOR_ACP_SMOKE_OK");
  } finally {
    await client.close();
  }
});
