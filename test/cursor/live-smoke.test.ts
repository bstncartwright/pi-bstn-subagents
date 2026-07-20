import { expect, it } from "vitest";
import { CursorAcpClient, findCursorModelOption } from "#src/cursor/acp-client";
import { discoverCursorModels } from "#src/cursor/discover-cursor-models";

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
    });
    expect(findCursorModelOption(started.configOptions)).toBeDefined();
		const option = findCursorModelOption(started.configOptions);
		expect(option?.type).toBe("select");
		if (option?.type === "select") expect(started.modelIdentity?.value).toBe(option.currentValue);
    const result = await client.prompt("Reply exactly CURSOR_ACP_SMOKE_OK. Do not use tools.");
    expect(result.stopReason).toBe("end_turn");
    expect(output).toContain("CURSOR_ACP_SMOKE_OK");
  } finally {
    await client.close();
  }
});

live("discovers live Cursor ACP model values without prompting", { timeout: 60_000 }, async () => {
  const models = await discoverCursorModels({ cwd: process.cwd() });

  expect(models.length).toBeGreaterThan(0);
  expect(models.some((model) => model.value.length > 0 && model.name.length > 0)).toBe(true);
});
