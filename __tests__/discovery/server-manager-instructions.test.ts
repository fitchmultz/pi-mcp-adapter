import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpServerManager } from "../../server-manager.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-code-server.mjs", import.meta.url));

describe("McpServerManager instructions", () => {
  it.each([
    {
      instructions: "Use read_skill to load a skill before answering.",
      expected: "Use read_skill to load a skill before answering.",
    },
    { instructions: "", expected: undefined },
  ])(
    "captures instructions from the server initialize result",
    async ({ instructions, expected }) => {
      const manager = new McpServerManager();
      try {
        const connection = await manager.connect("demo", {
          command: process.execPath,
          args: [fixture],
          env: { MCP_TEST_INSTRUCTIONS: instructions },
        });
        expect(connection.instructions).toBe(expected);
      } finally {
        await manager.closeAll();
      }
    },
  );
});
