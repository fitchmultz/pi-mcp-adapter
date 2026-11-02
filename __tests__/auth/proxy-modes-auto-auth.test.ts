import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type * as authTypes from "../../mcp-auth-flow.ts";
import type * as initTypes from "../../init.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import type { McpExtensionState } from "../../state.ts";
import type { McpTool, ServerDefinition } from "../../types.ts";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn<typeof authTypes.authenticate>(),
  supportsOAuth: vi.fn<typeof authTypes.supportsOAuth>(),
  lazyConnect: vi.fn<typeof initTypes.lazyConnect>(),
  updateServerMetadata: vi.fn<typeof initTypes.updateServerMetadata>(),
  updateMetadataCache: vi.fn<typeof initTypes.updateMetadataCache>(),
  notifyToolMetadataUpdated: vi.fn<typeof initTypes.notifyToolMetadataUpdated>(),
  markKeepAliveAfterConnect: vi.fn<typeof initTypes.markKeepAliveAfterConnect>(),
  getFailureAgeSeconds: vi.fn<typeof initTypes.getFailureAgeSeconds>(),
  updateStatusBar: vi.fn<typeof initTypes.updateStatusBar>(),
  clearFailure: vi.fn<typeof initTypes.clearFailure>(),
  recordFailure: vi.fn<typeof initTypes.recordFailure>(),
}));

vi.mock("../../mcp-auth-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof authTypes>()),
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));
vi.mock("../../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
  markKeepAliveAfterConnect: mocks.markKeepAliveAfterConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
  clearFailure: mocks.clearFailure,
  recordFailure: mocks.recordFailure,
}));

const definition = { url: "https://api.example.com/mcp", auth: "oauth" as const };
const searchMetadata = [
  {
    name: "demo_search",
    originalName: "search",
    description: "Search",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

function firstText(result: Pick<AgentToolResult<unknown>, "content">): string {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}

function makeConnection(
  status: ServerConnection["status"],
  tools: McpTool[] = [],
  server: ServerDefinition = definition,
): ServerConnection {
  return {
    client: new Client({ name: "proxy-auth-test", version: "1" }),
    transport: InMemoryTransport.createLinkedPair()[0],
    definition: server,
    tools,
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status,
  };
}

function managedConnection(connection: ServerConnection): McpServerManager {
  const manager = new McpServerManager();
  vi.spyOn(manager, "getConnection").mockReturnValue(connection);
  onTestFinished(async () => manager.closeAll());
  return manager;
}

function expectAuthentication(state: McpExtensionState): AbortSignal {
  const call = mocks.authenticate.mock.calls[0];
  assert.ok(call);
  expect(call.slice(0, 3)).toEqual(["demo", definition.url, definition]);
  const signal = call[3]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(call[3]).toEqual({
    authStorageOptions: state.authStorageOptions,
    runtime: state.oauthRuntime,
    signal,
  });
  assert.ok(signal);
  return signal;
}

async function connectedFixture(
  call: () => CallToolResult | Promise<CallToolResult>,
  release?: () => void,
) {
  const server = new McpServer({ name: "proxy-auth-test", version: "1" });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
  }));
  server.server.setRequestHandler("tools/call", call);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const manager = new McpServerManager();
  onTestFinished(async () => {
    release?.();
    await manager.closeAll();
    await server.close();
  });
  await server.connect(serverTransport);
  const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (
    this: Client,
    _transport,
    options,
  ) {
    connect.mockRestore();
    return this.connect(clientTransport, options);
  });
  try {
    await manager.connect("demo", definition);
  } finally {
    connect.mockRestore();
  }
  const connection = manager.getConnection("demo");
  assert.ok(connection);
  return { manager, connection, callTool: vi.spyOn(connection.client, "callTool") };
}

describe("proxy auto auth", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterAll(async () => {
    await host.dispose();
  });
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.lazyConnect.mockReset().mockResolvedValue(false);
    mocks.updateServerMetadata.mockReset();
    mocks.updateMetadataCache.mockReset();
    mocks.notifyToolMetadataUpdated.mockReset();
    mocks.markKeepAliveAfterConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.updateStatusBar.mockReset();
    mocks.clearFailure.mockReset();
    mocks.recordFailure.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes an already connected server instead of reusing stale metadata", async () => {
    const { executeConnect } = await import("../../proxy-modes.ts");
    const server = { command: "node", args: ["server.js"] };
    const stale = makeConnection(
      "connected",
      [{ name: "old", description: "Old tool", inputSchema: { type: "object" } }],
      server,
    );
    const fresh = makeConnection(
      "connected",
      Array.from({ length: 13 }, (_, index) => ({
        name: index === 0 ? "fresh" : `fresh_${index}`,
        description: `Fresh tool ${index}`,
        inputSchema: { type: "object" as const },
      })),
      server,
    );
    const manager = managedConnection(fresh);
    vi.spyOn(manager, "getConnection").mockReturnValueOnce(stale);
    const connect = vi.spyOn(manager, "connect").mockImplementation(async () => {
      throw new Error("connect should not reuse the stale connection");
    });
    const reconnect = vi.spyOn(manager, "reconnect").mockResolvedValue(fresh);
    const state = createTestState({ config: { mcpServers: { demo: server } }, manager });

    const result = await executeConnect(state, "demo");
    expect(reconnect).toHaveBeenCalledWith("demo", server, stale, expect.any(AbortSignal));
    expect(connect).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ mode: "list", server: "demo", count: 13 });
    expect(firstText(result)).toContain("demo_fresh");
    expect(firstText(result)).toContain(
      'mcp({ action: "list", server: "demo", limit: 12, offset: 12 })',
    );
    expect(state.toolMetadata.get("demo")?.[0]).toMatchObject({ originalName: "fresh" });
  });

  it("auto-authenticates and retries executeConnect once", async () => {
    const { executeConnect } = await import("../../proxy-modes.ts");
    const needsAuth = makeConnection("needs-auth");
    const connected = makeConnection("connected", [
      { name: "search", description: "Search", inputSchema: { type: "object" } },
    ]);
    let current: ServerConnection | undefined;
    const manager = new McpServerManager();
    onTestFinished(async () => manager.closeAll());
    const connect = vi.spyOn(manager, "connect").mockImplementation(async () => {
      current = needsAuth;
      return needsAuth;
    });
    const reconnect = vi.spyOn(manager, "reconnect").mockImplementation(async () => {
      current = connected;
      return connected;
    });
    const close = vi.spyOn(manager, "close");
    vi.spyOn(manager, "getConnection").mockImplementation(() => current);
    const statuses: string[] = [];
    vi.spyOn(host.context.ui, "setStatus").mockImplementation((_key, value) => {
      if (value !== undefined) {
        statuses.push(value);
      }
    });
    const state = createTestState({
      config: {
        settings: { autoAuth: true, toolPrefix: "mcp", showStatusIcon: false },
        mcpServers: { demo: definition },
      },
      manager,
      ui: host.context.ui,
    });
    const result = await executeConnect(state, "demo");

    expect(statuses).toContain("MCP: connecting to demo...");
    expectAuthentication(state);
    expect(close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith("demo", definition, needsAuth, expect.any(AbortSignal));
    expect(state.toolMetadata.get("demo")?.[0]).toMatchObject({
      name: "mcp__demo_search",
      originalName: "search",
    });
    expect(firstText(result)).toContain("demo (1 tools)");
  });

  it("fails fast for non-ui browser auth when autoAuth is enabled", async () => {
    const { executeConnect } = await import("../../proxy-modes.ts");
    const needsAuth = makeConnection("needs-auth");
    const manager = managedConnection(needsAuth);
    vi.spyOn(manager, "connect").mockResolvedValue(needsAuth);
    const state = createTestState({
      config: { settings: { autoAuth: true }, mcpServers: { demo: definition } },
      manager,
    });
    const result = await executeConnect(state, "demo");
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(firstText(result)).toContain("auth-start");
    expect(firstText(result)).toContain("/mcp-auth demo");
  });

  it("uses custom authRequiredMessage for non-ui autoAuth failures", async () => {
    const { executeConnect } = await import("../../proxy-modes.ts");
    const needsAuth = makeConnection("needs-auth");
    const manager = managedConnection(needsAuth);
    vi.spyOn(manager, "connect").mockResolvedValue(needsAuth);
    const state = createTestState({
      config: {
        settings: { autoAuth: true, authRequiredMessage: "Reconnect ${server} from the host app." },
        mcpServers: { demo: definition },
      },
      manager,
    });
    const result = await executeConnect(state, "demo");
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(firstText(result)).toBe("Reconnect demo from the host app.");
  });

  it("runs URL elicitations returned by proxy tool calls", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
    const { executeCall } = await import("../../proxy-modes.ts");
    const error = new UrlElicitationRequiredError([
      {
        mode: "url",
        message: "Connect your account",
        elicitationId: "connect-1",
        url: "https://example.com/connect",
      },
    ]);
    const connection = makeConnection("connected", [
      { name: "search", description: "Search", inputSchema: { type: "object" } },
    ]);
    vi.spyOn(connection.client, "callTool").mockRejectedValue(error);
    const manager = managedConnection(connection);
    const handle = vi.spyOn(manager, "handleUrlElicitationRequired").mockResolvedValue("accept");
    const state = createTestState({
      config: { settings: {}, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    const result = await executeCall(state, "demo_search", {}, "demo");
    expect(handle).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
  });

  it("auto-authenticates and retries executeCall once", async () => {
    const { executeCall } = await import("../../proxy-modes.ts");
    const {
      manager,
      connection: connected,
      callTool,
    } = await connectedFixture(() => ({ isError: false, content: [{ type: "text", text: "ok" }] }));
    const needsAuth: ServerConnection = { ...connected, status: "needs-auth" };
    let current = needsAuth;
    vi.spyOn(manager, "getConnection").mockImplementation(() => current);
    const connect = vi.spyOn(manager, "connect");
    const reconnect = vi.spyOn(manager, "reconnect").mockImplementation(async () => {
      current = connected;
      return connected;
    });
    const close = vi.spyOn(manager, "close");
    const options = vi.spyOn(manager, "getRequestOptions").mockReturnValue({ timeout: 1234 });
    const statuses: string[] = [];
    vi.spyOn(host.context.ui, "setStatus").mockImplementation((_key, value) => {
      if (value !== undefined) {
        statuses.push(value);
      }
    });
    const state = createTestState({
      config: {
        settings: { autoAuth: true, toolPrefix: "server", showStatusIcon: false },
        mcpServers: { demo: definition },
      },
      manager,
      ui: host.context.ui,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    const controller = new AbortController();
    const result = await executeCall(
      state,
      "demo_search",
      { q: "hello" },
      "demo",
      undefined,
      controller.signal,
    );

    expect(statuses).toContain("MCP: connecting to demo...");
    const authSignal = expectAuthentication(state);
    expect(connect).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledWith("demo", definition, needsAuth, expect.any(AbortSignal));
    expect(close).not.toHaveBeenCalled();
    expect(options).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
    const toolCall = callTool.mock.calls[0];
    assert.ok(toolCall);
    expect(toolCall[0]).toEqual({ name: "search", arguments: { q: "hello" }, _meta: undefined });
    const signal = toolCall[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(toolCall[1]).toEqual({ timeout: 1234, signal });
    expect(firstText(result)).toContain("ok");
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    expect(authSignal.reason).toBe(reason);
    expect(options.mock.calls[0]?.[1]?.reason).toBe(reason);
    expect(signal?.reason).toBe(reason);
  });

  it("rethrows proxy auto-auth cancellation", async () => {
    const { executeCall } = await import("../../proxy-modes.ts");
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    reason.name = "AbortError";
    mocks.authenticate.mockRejectedValueOnce(reason);
    const manager = managedConnection(makeConnection("needs-auth"));
    const state = createTestState({
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: { demo: definition },
      },
      manager,
      ui: host.context.ui,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    await expect(
      executeCall(state, "demo_search", {}, "demo", undefined, controller.signal),
    ).rejects.toBe(reason);
    const authSignal = expectAuthentication(state);
    controller.abort(reason);
    expect(authSignal.reason).toBe(reason);
  });

  it("surfaces aborted proxy tool calls via the forwarded AbortSignal", async () => {
    const { executeCall } = await import("../../proxy-modes.ts");
    const controller = new AbortController();
    const response = Promise.withResolvers<CallToolResult>();
    const { manager, callTool } = await connectedFixture(
      () => response.promise,
      () => {
        response.resolve({ content: [] });
      },
    );
    const requestOptions = { signal: controller.signal, timeout: 1234 };
    const options = vi.spyOn(manager, "getRequestOptions").mockReturnValue(requestOptions);
    const state = createTestState({
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    const inFlight = executeCall(state, "demo_search", {}, "demo", undefined, controller.signal);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const reason = new Error("request aborted");
    controller.abort(reason);
    const result = await inFlight;
    expect(options).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
    const toolCall = callTool.mock.calls[0];
    assert.ok(toolCall);
    expect(toolCall[0]).toEqual({ name: "search", arguments: {}, _meta: undefined });
    const signal = toolCall[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(toolCall[1]).toEqual({ ...requestOptions, signal });
    expect(options.mock.calls[0]?.[1]?.reason).toBe(reason);
    expect(signal?.reason).toBe(reason);
    expect(result.details).toMatchObject({ error: "aborted", message: "request aborted" });
    expect(firstText(result)).toContain("request aborted");
  });

  it("preserves owner cancellation during a proxy tool call", async () => {
    const { executeCall } = await import("../../proxy-modes.ts");
    const response = Promise.withResolvers<CallToolResult>();
    const started = Promise.withResolvers<boolean>();
    const { manager, callTool } = await connectedFixture(
      () => {
        started.resolve(true);
        return response.promise;
      },
      () => {
        response.resolve({ content: [] });
      },
    );
    const state = createTestState({
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    const inFlight = executeCall(state, "demo_search", {}, "demo");
    await started.promise;
    expect(callTool).toHaveBeenCalledOnce();
    await state.owner.stop("owner stopped");
    const result = await inFlight;
    expect(result.details).toMatchObject({ error: "aborted", message: "owner stopped" });
  });

  it("shares one cold connect across concurrent proxy calls and applies timeout during bootstrap", async () => {
    const { executeCall } = await import("../../proxy-modes.ts");
    const directory = await mkdtemp(join(tmpdir(), "pi-mcp-proxy-cold-"));
    const eventsPath = join(directory, "events.jsonl");
    const serverFixture = fileURLToPath(
      new URL("../fixtures/lazy-startup-mcp-server.mjs", import.meta.url),
    );
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);
    onTestFinished(async () => {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    });
    const connect = vi.spyOn(Client.prototype, "connect");
    const listTools = vi.spyOn(Client.prototype, "listTools");
    const listResources = vi.spyOn(Client.prototype, "listResources");
    const callTool = vi.spyOn(Client.prototype, "callTool");
    mocks.lazyConnect.mockImplementation(async (state, serverName) => {
      const configured = state.config.mcpServers[serverName];
      assert.ok(configured);
      const connection = await state.manager.connect(serverName, configured);
      if (connection.status !== "connected") {
        return false;
      }
      state.toolMetadata.set(serverName, [
        { name: "mcp__demo_echo", originalName: "echo", description: "Echo a local argument" },
      ]);
      return true;
    });
    const state = createTestState({
      config: {
        settings: { toolPrefix: "mcp" },
        mcpServers: {
          demo: {
            command: process.execPath,
            args: [serverFixture],
            env: { MCP_STARTUP_FIXTURE_EVENTS: eventsPath, MCP_STARTUP_FIXTURE_NAME: "demo" },
            requestTimeoutMs: 5000,
          },
        },
      },
      manager,
    });
    const [first, second] = await Promise.all([
      executeCall(state, "mcp__demo_echo", { text: "one" }),
      executeCall(state, "mcp__demo_echo", { text: "two" }),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    const connectCall = connect.mock.calls[0];
    assert.ok(connectCall);
    expect(connectCall[0]).toBeInstanceOf(StdioClientTransport);
    expect(connectCall[1]).toEqual({ timeout: 5000 });
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(listResources).toHaveBeenCalledTimes(1);
    for (const request of [listTools.mock.calls[0], listResources.mock.calls[0]]) {
      assert.ok(request);
      expect(request[0]).toBeUndefined();
      const signal = request[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(request[1]).toEqual({ timeout: 5000, cacheMode: "refresh", signal });
    }
    expect(callTool).toHaveBeenCalledTimes(2);
    const argumentsSent = callTool.mock.calls.map(([params]) => params);
    expect(argumentsSent).toContainEqual({
      name: "echo",
      arguments: { text: "one" },
      _meta: undefined,
    });
    expect(argumentsSent).toContainEqual({
      name: "echo",
      arguments: { text: "two" },
      _meta: undefined,
    });
    for (const [, options] of callTool.mock.calls) {
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(options).toEqual({ timeout: 5000, signal });
    }
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ event: "spawn", server: "demo" });
    expect(events.slice(1)).toContainEqual({ event: "call", server: "demo", text: "one" });
    expect(events.slice(1)).toContainEqual({ event: "call", server: "demo", text: "two" });
    expect(firstText(first)).toContain("demo: one");
    expect(firstText(second)).toContain("demo: two");
  });
});
