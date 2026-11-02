import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDirectToolExecutor } from "../../direct-tools.ts";
import { executeCall } from "../../proxy-modes.ts";
import { McpServerManager } from "../../server-manager.ts";
import type { McpExtensionState } from "../../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../../types.ts";

const fixture = fileURLToPath(new URL("../fixtures/output-schema-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

function createState(manager: McpServerManager, names: string[]): McpExtensionState {
  const metadata = names.map((name): ToolMetadata => ({
    name: `real_${name}`,
    originalName: name,
    description: "integration test",
    inputSchema: { type: "object" },
  }));
  return createTestState({
    manager,
    config: { settings: {}, mcpServers: { real: definition } },
    toolMetadata: new Map([["real", metadata]]),
  });
}

function directSpec(originalName: string): DirectToolSpec {
  return {
    serverName: "real",
    originalName,
    prefixedName: `real_${originalName}`,
    description: "integration test",
    inputSchema: { type: "object" },
  };
}

describe("MCP output schema validation", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterAll(async () => {
    await host.dispose();
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  });

  it.each([
    ["draft07-valid", "proxy"],
    ["draft2020-valid", "proxy"],
    ["draft07-valid", "direct"],
    ["draft2020-valid", "direct"],
  ] as const)("accepts valid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result =
      path === "proxy"
        ? await executeCall(state, `real_${name}`, {})
        : await createDirectToolExecutor(
            () => state,
            () => null,
            directSpec(name),
          )("id", {}, undefined, undefined, host.context);

    expect(result.details).not.toMatchObject({ error: "call_failed" });
    expect(result.content[0]).toEqual({ type: "text", text: name });
    expect(result.content[1]).toEqual({
      type: "text",
      text: JSON.stringify({ values: ["ok", 1] }, null, 2),
    });
    const ref = result.details.resultRef;
    const block = result.content[2];
    assert.ok(typeof ref === "string");
    assert.ok(block?.type === "text");
    expect(block.text).toContain(ref);
  });

  it.each([
    ["draft07-invalid", "proxy"],
    ["draft2020-invalid", "proxy"],
    ["draft07-invalid", "direct"],
    ["draft2020-invalid", "direct"],
  ] as const)("rejects invalid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result =
      path === "proxy"
        ? await executeCall(state, `real_${name}`, {})
        : await createDirectToolExecutor(
            () => state,
            () => null,
            directSpec(name),
          )("id", {}, undefined, undefined, host.context);

    expect(result.details).toMatchObject({ error: "call_failed" });
    const block = result.content[0];
    assert.ok(block?.type === "text");
    expect(block.text).toContain("Structured content does not match the tool's output schema");
  });
});
