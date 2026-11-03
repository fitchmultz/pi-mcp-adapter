import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import type * as Auth from "../mcp-auth-flow.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createTestState } from "./test-state.ts";
import { firstText, proxyRuntimeState } from "./fixtures/proxy-runtime.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  machineResult,
  readMachineBody,
} from "./fixtures/oauth-machine-wire.ts";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn<typeof Auth.authenticate>() }));
vi.mock("../mcp-auth-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Auth>()),
  authenticate: mocks.authenticate,
}));

const MCP_RESULT: CallToolResult = {
  isError: false,
  content: [{ type: "text", text: "hello" }],
  structuredContent: { greeting: "hello" },
};
let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

async function expiredState() {
  const http = new MachineHttpServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === "tools/call") {
      machineJson(response, { error: "expired" }, 404);
      return;
    }
    if (message.method === "initialize") {
      response.setHeader("Mcp-Session-Id", "expired");
    }
    machineJson(response, {
      jsonrpc: "2.0",
      id: message.id,
      result: machineResult(message.method, "expiry", "hello"),
    });
  });
  const origin = await http.listen();
  const definition = {
    url: `${origin}/mcp`,
    auth: false as const,
    protocolVersion: "legacy" as const,
    requestTimeoutMs: 2000,
  };
  const state = createTestState({
    config: { settings: { autoAuth: true }, mcpServers: { demo: definition } },
  });
  onTestFinished(async () => {
    await state.owner.stop();
    await state.manager.closeAll();
    await http.close();
    vi.restoreAllMocks();
  });
  const stale = await state.manager.connect("demo", definition);
  const needsAuth = { ...stale, status: "needs-auth" as const };
  let current = stale;
  vi.spyOn(state.manager, "getConnection").mockImplementation(() => current);
  vi.spyOn(state.manager, "getRequestOptions").mockReturnValue({ timeout: 30 });
  const reconnect = vi.spyOn(state.manager, "reconnect").mockImplementation(async () => {
    current = needsAuth;
    return current;
  });
  const connect = vi.spyOn(state.manager, "connect");
  const callTool = vi.spyOn(stale.client, "callTool");
  state.config.mcpServers.demo = {
    ...definition,
    auth: "oauth",
    oauth: { grantType: "client_credentials" },
  };
  return { state, reconnect, connect, callTool };
}

describe("proxy and direct tool call parity", () => {
  it.each(["direct", "proxy"])(
    "bounds post-expiry auth and prevents late reconnect through %s",
    async (entry) => {
      const { state, connect, reconnect, callTool } = await expiredState();
      const authentication = Promise.withResolvers<Awaited<ReturnType<typeof Auth.authenticate>>>();
      onTestFinished(() => {
        authentication.resolve("authenticated");
      });
      let authSignal: AbortSignal | undefined;
      mocks.authenticate.mockImplementation((_name, _url, _definition, options) => {
        authSignal = options?.signal;
        return authentication.promise;
      });
      const output =
        entry === "direct"
          ? await createDirectToolExecutor(
              () => state,
              () => null,
              {
                serverName: "demo",
                originalName: "echo",
                prefixedName: "demo_echo",
                description: "Echo",
              },
            )(
              "call-id",
              {},
              undefined,
              undefined,
              host.runner.createToolContext("call-id", state.owner.signal),
            )
          : await executeCall(state, { toolName: "demo_echo", args: {} });
      expect(output.details.error).toBe("call_failed");
      expect(authSignal?.aborted).toBe(true);
      authentication.resolve("authenticated");
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(connect).not.toHaveBeenCalled();
      expect(reconnect).toHaveBeenCalledOnce();
      expect(callTool).toHaveBeenCalledOnce();
    },
  );

  it("returns the same details from both paths, including details.mcpResult", async () => {
    const proxyFixture = await proxyRuntimeState({ name: "echo", result: MCP_RESULT });
    const directFixture = await proxyRuntimeState({ name: "echo", result: MCP_RESULT });
    const proxy = await executeCall(proxyFixture.state, { toolName: "demo_echo", args: { x: 1 } });
    const direct = await createDirectToolExecutor(
      () => directFixture.state,
      () => null,
      {
        serverName: "demo",
        originalName: "echo",
        prefixedName: "demo_echo",
        description: "Echo tool",
      },
    )(
      "call-1",
      { x: 1 },
      undefined,
      undefined,
      host.runner.createToolContext("call-1", directFixture.state.owner.signal),
    );
    expect(direct.details.mcpResult).toEqual(MCP_RESULT);
    expect(proxy.details.mcpResult).toEqual(MCP_RESULT);
    const resultRef: unknown = expect.any(String);
    expect(proxy.details).toEqual({ mode: "call", ...direct.details, resultRef });
    expect(direct.content.slice(0, 2)).toEqual(proxy.content.slice(0, 2));
    expect(firstText({ content: direct.content.slice(-1) })).toContain(direct.details.resultRef);
    expect(firstText({ content: proxy.content.slice(-1) })).toContain(proxy.details.resultRef);
  });

  it("does not format the input schema on the success path", async () => {
    const { state, connection } = await proxyRuntimeState({ name: "echo", result: MCP_RESULT });
    const tool = state.toolMetadata.get("demo")?.[0];
    const live = connection.tools[0];
    assert.ok(tool && live);
    const schema = { type: "object" as const };
    tool.inputSchema = schema;
    live.inputSchema = schema;
    Object.defineProperty(schema, "properties", {
      enumerable: true,
      get() {
        throw new Error("input schema formatted on the success path");
      },
    });
    const result = await executeCall(state, { toolName: "demo_echo", args: { x: 1 } });
    expect(result.details.error).toBeUndefined();
    expect(result.details.mcpResult).toEqual(MCP_RESULT);
  });
});
