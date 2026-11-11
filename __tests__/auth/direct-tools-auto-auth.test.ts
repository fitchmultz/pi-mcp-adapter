import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
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
import type * as initTypes from "../../init.ts";
import type * as authTypes from "../../mcp-auth-flow.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import { buildToolMetadata } from "../../tool-metadata.ts";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn<typeof initTypes.lazyConnect>(),
  getFailureAgeSeconds: vi.fn<typeof initTypes.getFailureAgeSeconds>(),
  clearFailure: vi.fn<typeof initTypes.clearFailure>(),
  authenticate: vi.fn<typeof authTypes.authenticate>(),
  supportsOAuth: vi.fn<typeof authTypes.supportsOAuth>(),
}));

vi.mock("../../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  clearFailure: mocks.clearFailure,
  updateStatusBar: vi.fn<typeof initTypes.updateStatusBar>(),
  markKeepAliveAfterConnect: vi.fn<typeof initTypes.markKeepAliveAfterConnect>(),
  recordFailure: vi.fn<typeof initTypes.recordFailure>(),
}));

vi.mock("../../mcp-auth-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof authTypes>()),
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

const definition = { url: "https://api.example.com/mcp", auth: "oauth" as const };
const searchMetadata = [{ name: "demo_search", originalName: "search", description: "Search" }];

function firstText(result: Pick<AgentToolResult<unknown>, "content">): string {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}

function needsAuthManager(): McpServerManager {
  const manager = new McpServerManager();
  const connection: ServerConnection = {
    client: new Client({ name: "auth-test", version: "1" }),
    transport: InMemoryTransport.createLinkedPair()[0],
    definition,
    tools: [],
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    status: "needs-auth",
  };
  vi.spyOn(manager, "getConnection").mockReturnValue(connection);
  onTestFinished(async () => manager.closeAll());
  return manager;
}

async function connectedFixture(
  toolName: string,
  call: () => CallToolResult | Promise<CallToolResult>,
  release?: () => void,
) {
  const server = new McpServer({ name: "direct-auth-test", version: "1" });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name: toolName, description: "Test tool", inputSchema: { type: "object" } }],
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
  assert.ok(connection, "expected connected server");
  return { manager, connection, callTool: vi.spyOn(connection.client, "callTool") };
}

describe("direct tools auto auth", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterAll(async () => {
    await host.dispose();
  });
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.clearFailure.mockReset();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-authenticates and retries direct tool execution once", async () => {
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const {
      manager,
      connection: connected,
      callTool,
    } = await connectedFixture("namespace.tool", () => ({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    }));
    const needsAuth: ServerConnection = { ...connected, status: "needs-auth" };
    let connection = needsAuth;
    mocks.lazyConnect.mockImplementation(async () => connection.status === "connected");
    vi.spyOn(manager, "getConnection").mockImplementation(() => connection);
    const close = vi.spyOn(manager, "close");
    const reconnect = vi.spyOn(manager, "reconnect").mockImplementation(async () => {
      connection = connected;
      return connected;
    });
    const requestOptions = vi
      .spyOn(manager, "getRequestOptions")
      .mockReturnValue({ timeout: 4321 });
    const state = createTestState({
      config: { settings: { autoAuth: true }, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
      ui: host.context.ui,
    });

    const { metadata } = buildToolMetadata({
      tools: connected.tools,
      resources: [],
      definition,
      serverName: "demo",
      prefix: "server",
    });
    const tool = metadata[0];
    assert.ok(tool);
    state.toolMetadata.set("demo", metadata);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: tool.originalName,
        prefixedName: tool.name,
        description: tool.description,
      },
    );
    const controller = new AbortController();
    const result = await executor(
      "id",
      { q: "hello" },
      controller.signal,
      undefined,
      host.runner.createToolContext("id", controller.signal),
    );

    const authCall = mocks.authenticate.mock.calls[0];
    assert.ok(authCall);
    expect(authCall.slice(0, 3)).toEqual(["demo", definition.url, definition]);
    const authSignal = authCall[3].signal;
    expect(authSignal).toBeInstanceOf(AbortSignal);
    expect(authCall[3]).toEqual({
      authStorageOptions: state.authStorageOptions,
      runtime: state.oauthRuntime,
      signal: authSignal,
    });
    expect(close).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledWith("demo", definition, needsAuth, expect.any(AbortSignal));
    expect(requestOptions).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
    const toolCall = callTool.mock.calls[0];
    assert.ok(toolCall);
    expect(toolCall[0]).toEqual({
      name: "namespace.tool",
      arguments: { q: "hello" },
      _meta: undefined,
    });
    const toolSignal = toolCall[1]?.signal;
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolCall[1]).toEqual({ timeout: 4321, signal: toolSignal });
    expect(firstText(result)).toContain("ok");
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    expect(authSignal?.reason).toBe(reason);
    expect(requestOptions.mock.calls[0]?.[1]?.reason).toBe(reason);
    expect(toolSignal?.reason).toBe(reason);
  });

  it("surfaces aborted direct tool calls via the forwarded AbortSignal", async () => {
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const controller = new AbortController();
    const response = Promise.withResolvers<CallToolResult>();
    const { manager, callTool } = await connectedFixture(
      "search",
      () => response.promise,
      () => {
        response.resolve({ content: [{ type: "text", text: "released" }] });
      },
    );
    const requestOptions = { signal: controller.signal, timeout: 4321 };
    const options = vi.spyOn(manager, "getRequestOptions").mockReturnValue(requestOptions);
    const state = createTestState({
      config: { settings: {}, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const inFlight = executor(
      "id",
      {},
      controller.signal,
      undefined,
      host.runner.createToolContext("id", controller.signal),
    );
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const reason = new Error("request aborted");
    controller.abort(reason);
    const result = await inFlight;

    expect(options).toHaveBeenCalledWith("demo", expect.any(AbortSignal));
    const toolCall = callTool.mock.calls[0];
    assert.ok(toolCall);
    expect(toolCall[0]).toEqual({ name: "search", arguments: {}, _meta: undefined });
    const toolSignal = toolCall[1]?.signal;
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolCall[1]).toEqual({ ...requestOptions, signal: toolSignal });
    expect(options.mock.calls[0]?.[1]?.reason).toBe(reason);
    expect(toolSignal?.reason).toBe(reason);
    expect(result.details).toMatchObject({ error: "aborted", server: "demo" });
    expect(firstText(result)).toContain("request aborted");
  });

  it("rethrows direct auto-auth cancellation", async () => {
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    reason.name = "AbortError";
    mocks.authenticate.mockRejectedValueOnce(reason);
    const state = createTestState({
      config: { settings: { autoAuth: true }, mcpServers: { demo: definition } },
      manager: needsAuthManager(),
      toolMetadata: new Map([["demo", searchMetadata]]),
      ui: host.context.ui,
    });
    mocks.lazyConnect.mockResolvedValue(false);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    await expect(
      executor(
        "id",
        {},
        controller.signal,
        undefined,
        host.runner.createToolContext("id", controller.signal),
      ),
    ).rejects.toBe(reason);
    const authCall = mocks.authenticate.mock.calls[0];
    assert.ok(authCall);
    expect(authCall.slice(0, 3)).toEqual(["demo", definition.url, definition]);
    const authSignal = authCall[3].signal;
    expect(authSignal).toBeInstanceOf(AbortSignal);
    expect(authCall[3]).toEqual({
      authStorageOptions: state.authStorageOptions,
      runtime: state.oauthRuntime,
      signal: authSignal,
    });
    controller.abort(reason);
    expect(authSignal?.reason).toBe(reason);
  });

  it("fails fast in non-ui context for browser-based OAuth", async () => {
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const state = createTestState({
      config: { settings: { autoAuth: true }, mcpServers: { demo: definition } },
      manager: needsAuthManager(),
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    mocks.lazyConnect.mockResolvedValue(false);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );
    const result = await executor(
      "id",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("id", state.owner.signal),
    );

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(firstText(result)).toContain("auth-start");
    expect(firstText(result)).toContain("/mcp-auth demo");
  });

  it("runs URL elicitations returned by a URL-required tool error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const error = new UrlElicitationRequiredError([
      {
        mode: "url",
        message: "Connect your account",
        elicitationId: "connect-1",
        url: "https://example.com/connect",
      },
    ]);
    const { manager, connection } = await connectedFixture("search", () => ({ content: [] }));
    vi.spyOn(connection.client, "callTool").mockRejectedValue(error);
    const handle = vi.spyOn(manager, "handleUrlElicitationRequired").mockResolvedValue("accept");
    const state = createTestState({
      config: { settings: {}, mcpServers: { demo: definition } },
      manager,
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    mocks.lazyConnect.mockResolvedValue(true);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );
    const result = await executor(
      "id",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("id", state.owner.signal),
    );

    expect(handle).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
    expect(firstText(result)).toContain("retry the tool");
  });

  it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {
    const { createDirectToolExecutor } = await import("../../direct-tools.ts");
    const state = createTestState({
      config: {
        settings: { autoAuth: true, authRequiredMessage: "Reconnect ${server} from the host app." },
        mcpServers: { demo: definition },
      },
      manager: needsAuthManager(),
      toolMetadata: new Map([["demo", searchMetadata]]),
    });
    mocks.lazyConnect.mockResolvedValue(false);
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );
    const result = await executor(
      "id",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("id", state.owner.signal),
    );

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(firstText(result)).toBe("Reconnect demo from the host app.");
  });
});
