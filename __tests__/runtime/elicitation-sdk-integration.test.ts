import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import type open from "open";
import { createDirectToolExecutor } from "../../direct-tools.ts";
import { executeCall } from "../../proxy-modes.ts";
import { McpServerManager } from "../../server-manager.ts";
import type { McpExtensionState } from "../../state.ts";
import type { ToolMetadata } from "../../types.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";
import { createElicitationUi } from "./fixtures/elicitation-ui.ts";

const mocks = vi.hoisted(() => ({ open: vi.fn<typeof open>() }));
vi.mock("open", () => ({ default: mocks.open }));

const fixture = fileURLToPath(new URL("./fixtures/elicitation-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];
const states: McpExtensionState[] = [];
let native: Awaited<ReturnType<typeof createTestExtensionContext>>;

async function createConnectedManager(
  mode: ExtensionContext["mode"],
  answers: readonly string[] = [],
) {
  const ui = createElicitationUi(answers, ["stock-pi-user"]);
  const manager = new McpServerManager();
  manager.setElicitationConfig({ ui, allowUrl: mode === "tui" });
  managers.push(manager);
  await manager.connect("real", definition);
  return { manager, ui };
}

function createState(
  manager: McpServerManager,
  metadata: readonly ToolMetadata[],
): McpExtensionState {
  const state = createTestState({
    manager,
    config: { settings: {}, mcpServers: { real: definition } },
    toolMetadata: new Map([["real", [...metadata]]]),
  });
  states.push(state);
  return state;
}

function resultValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  const value: unknown = JSON.parse(text);
  return value;
}

describe("elicitation with the real MCP SDK", () => {
  beforeEach(async () => {
    mocks.open.mockReset().mockResolvedValue(new ChildProcess());
    native = await createTestExtensionContext();
  });

  afterEach(async () => {
    await Promise.all(states.splice(0).map((state) => state.owner.stop()));
    await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
    await native.dispose();
  });

  it.each([
    ["tui", { form: {}, url: {} }],
    ["rpc", { form: {} }],
  ] as const)(
    "advertises stock Pi %s capabilities and completes form elicitation",
    async (mode, capabilities) => {
      const { manager } = await createConnectedManager(mode, ["Continue", "Enter value", "Submit"]);
      const connection = requireValue(manager.getConnection("real"));
      const capabilityResult = await connection.client.callTool({
        name: "capabilities",
        arguments: {},
      });
      expect(resultValue(capabilityResult)).toEqual(capabilities);

      const formResult = await connection.client.callTool({ name: "form", arguments: {} });
      expect(resultValue(formResult)).toEqual({
        action: "accept",
        content: { name: "stock-pi-user" },
      });
    },
  );

  it("rejects URL elicitation over real SDK dispatch in stock Pi RPC mode", async () => {
    const { manager } = await createConnectedManager("rpc");
    const connection = requireValue(manager.getConnection("real"));

    await expect(connection.client.callTool({ name: "url", arguments: {} })).rejects.toThrow(
      /does not support (?:URL-mode|url) elicitation/,
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("dispatches URL elicitation and its completion notification over the real SDK", async () => {
    const { manager, ui } = await createConnectedManager("tui", ["Open"]);
    const connection = requireValue(manager.getConnection("real"));
    const result = await connection.client.callTool({ name: "url", arguments: {} });

    expect(resultValue(result)).toEqual({ action: "accept" });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/authorize");
    expect(ui.notify).toHaveBeenCalledWith(
      "MCP browser interaction for real completed. You can retry the tool now.",
      "info",
    );
    expect(ui.notify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["proxy tool", { originalName: "url-required" }, "proxy"],
    ["direct tool", { originalName: "url-required" }, "direct"],
    [
      "proxy resource",
      { originalName: "read_url_required_resource", resourceUri: "test://url-required" },
      "proxy",
    ],
    [
      "direct resource",
      { originalName: "read_url_required_resource", resourceUri: "test://url-required" },
      "direct",
    ],
    ["proxy UI resource", { originalName: "app", uiResourceUri: "ui://url-required" }, "proxy"],
    ["direct UI resource", { originalName: "app", uiResourceUri: "ui://url-required" }, "direct"],
  ] as const)("handles real -32042 errors from a %s", async (_label, spec, adapter) => {
    const { manager } = await createConnectedManager("tui", ["Open"]);
    const metadata: ToolMetadata = {
      name: `real_${spec.originalName}`,
      description: "integration test",
      ...spec,
    };
    const state = createState(manager, [metadata]);

    const result =
      adapter === "proxy"
        ? await executeCall(state, { toolName: metadata.name, args: {}, serverOverride: "real" })
        : await createDirectToolExecutor(
            () => state,
            () => null,
            {
              serverName: "real",
              prefixedName: metadata.name,
              description: metadata.description,
              ...spec,
            },
          )(
            "id",
            {},
            undefined,
            undefined,
            native.runner.createToolContext("id", state.owner.signal),
          );

    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
    const retryMessage: unknown = expect.stringContaining("retry the tool");
    expect(result.content[0]).toMatchObject({ type: "text", text: retryMessage });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/connect");
  });
});
