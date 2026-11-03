import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { initializeMcp } from "../../init.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";

describe("adapter messages through native Pi history", () => {
  it.each([
    { display: "UI Context submitted", expected: true },
    { display: "", expected: false },
    { display: undefined, expected: false },
  ])("converts display=$display to the native boolean $expected", async ({ display, expected }) => {
    const host = await createTestExtensionContext();
    const state = await initializeMcp(host.api, host.context, undefined, {
      config: { mcpServers: {} },
    });
    try {
      assert(state.sendMessage !== undefined);
      const content = [{ type: "text" as const, text: "Preserved UI context: café 🧭" }];
      const details = { server: "demo", context: { intent: "inspect" } };
      const message = {
        customType: "mcp-ui-context",
        content,
        details,
        ...(display !== undefined ? { display } : {}),
      };
      state.sendMessage(message, { triggerTurn: false });
      await nextTurn();
      const entries = host.context.sessionManager.getEntries();
      const messages = entries.filter((entry) => entry.type === "custom_message");
      expect(messages).toHaveLength(1);
      const [entry] = messages;
      assert(entry?.type === "custom_message");
      expect(entry.customType).toBe(message.customType);
      expect(entry.display).toBe(expected);
      expect(entry.content).toEqual(content);
      expect(entry.details).toEqual(details);

      await state.owner.stop("session ended");
      state.sendMessage(message, { triggerTurn: false });
      await nextTurn();
      expect(host.context.sessionManager.getEntries()).toEqual(entries);
    } finally {
      await state.owner.stop();
      await host.dispose();
    }
  });
});
