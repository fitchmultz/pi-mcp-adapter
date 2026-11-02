import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { McpAdapterOptions, McpConfig, ToolMetadata } from "../types.ts";
import { startUiServer } from "../ui-server.ts";
import type { McpExtensionState } from "../state.ts";
import type * as Init from "../init.ts";
import type * as OAuth from "../mcp-oauth-runtime.ts";
import type * as Config from "../config.ts";
import type * as Cache from "../metadata-cache.ts";
import type * as Direct from "../direct-tools.ts";
import type * as Commands from "../commands.ts";
import type * as Proxy from "../proxy-modes.ts";
import type * as Utils from "../utils.ts";
import { createTestState } from "./test-state.ts";
import { createLifecycleHost, requireValue } from "./fixtures/extension-lifecycle.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn<typeof Init.initializeMcp>(),
  updateStatusBar: vi.fn<typeof Init.updateStatusBar>(),
  flushMetadataCache: vi.fn<typeof Init.flushMetadataCache>(),
  notifyToolMetadataUpdated: vi.fn<typeof Init.notifyToolMetadataUpdated>(),
  createOAuthRuntime: vi.fn<typeof OAuth.createOAuthRuntime>(),
  shutdownOAuth: vi.fn<typeof OAuth.shutdownOAuth>(),
  loadMcpConfig: vi.fn<typeof Config.loadMcpConfig>(),
  cloneMcpConfig: vi.fn<typeof Config.cloneMcpConfig>(),
  isPathInsideProject: vi.fn<typeof Config.isPathInsideProject>(),
  getMetadataCachePath: vi.fn<typeof Cache.getMetadataCachePath>(),
  loadMetadataCache: vi.fn<typeof Cache.loadMetadataCache>(),
  buildProxyDescription: vi.fn<typeof Direct.buildProxyDescription>(),
  createDirectToolExecutor: vi.fn<typeof Direct.createDirectToolExecutor>(),
  getMissingConfiguredDirectToolServers:
    vi.fn<typeof Direct.getMissingConfiguredDirectToolServers>(),
  showStatus: vi.fn<typeof Commands.showStatus>(),
  showTools: vi.fn<typeof Commands.showTools>(),
  showPrompts: vi.fn<typeof Commands.showPrompts>(),
  reconnectServer: vi.fn<typeof Commands.reconnectServer>(),
  reconnectServers: vi.fn<typeof Commands.reconnectServers>(),
  authenticateServer: vi.fn<typeof Commands.authenticateServer>(),
  logoutServer: vi.fn<typeof Commands.logoutServer>(),
  openMcpAuthPanel: vi.fn<typeof Commands.openMcpAuthPanel>(),
  openMcpPanel: vi.fn<typeof Commands.openMcpPanel>(),
  openMcpSetup: vi.fn<typeof Commands.openMcpSetup>(),
  writeProjectServerDisabledOverride: vi.fn<typeof Config.writeProjectServerDisabledOverride>(),
  executeAuthComplete: vi.fn<typeof Proxy.executeAuthComplete>(),
  executeAuthStart: vi.fn<typeof Proxy.executeAuthStart>(),
  executeCall: vi.fn<typeof Proxy.executeCall>(),
  executeConnect: vi.fn<typeof Proxy.executeConnect>(),
  executeDescribe: vi.fn<typeof Proxy.executeDescribe>(),
  executeList: vi.fn<typeof Proxy.executeList>(),
  executeSearch: vi.fn<typeof Proxy.executeSearch>(),
  executeStatus: vi.fn<typeof Proxy.executeStatus>(),
  executeUiMessages: vi.fn<typeof Proxy.executeUiMessages>(),
  normalizeDirectToolInputSchema: vi.fn<typeof Utils.normalizeDirectToolInputSchema>(),
  truncateAtWord: vi.fn<typeof Utils.truncateAtWord>(),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
}));

vi.mock("../mcp-oauth-runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof OAuth>()),
  createOAuthRuntime: mocks.createOAuthRuntime,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: mocks.cloneMcpConfig,
  isPathInsideProject: mocks.isPathInsideProject,
  writeProjectServerDisabledOverride: mocks.writeProjectServerDisabledOverride,
}));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Cache>()),
  getMetadataCachePath: mocks.getMetadataCachePath,
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Direct>()),
  buildProxyDescription: mocks.buildProxyDescription,
  createDirectToolExecutor: mocks.createDirectToolExecutor,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
}));

vi.mock("../commands.ts", () => ({
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  showPrompts: mocks.showPrompts,
  reconnectServer: mocks.reconnectServer,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  logoutServer: mocks.logoutServer,
  openMcpAuthPanel: mocks.openMcpAuthPanel,
  openMcpPanel: mocks.openMcpPanel,
  openMcpSetup: mocks.openMcpSetup,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeAuthComplete: mocks.executeAuthComplete,
  executeAuthStart: mocks.executeAuthStart,
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

vi.mock("../utils.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Utils>()),
  formatTerminalError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createState() {
  const state = createTestState();
  state.owner.addCleanup(() => state.lifecycle.gracefulShutdown());
  return state;
}

const hosts: Awaited<ReturnType<typeof createLifecycleHost>>[] = [];
async function createPi() {
  const host = await createLifecycleHost();
  hosts.push(host);
  return host;
}

describe("mcpAdapter session lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(async () => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    vi.doUnmock("typebox");
    for (const value of Object.values(mocks)) {
      value.mockReset();
    }

    const oauth = await vi.importActual<typeof OAuth>("../mcp-oauth-runtime.ts");
    const direct = await vi.importActual<typeof Direct>("../direct-tools.ts");
    const utils = await vi.importActual<typeof Utils>("../utils.ts");
    mocks.createOAuthRuntime.mockImplementation(oauth.createOAuthRuntime);
    mocks.shutdownOAuth.mockResolvedValue();
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockImplementation((config) => structuredClone(config));
    mocks.isPathInsideProject.mockReturnValue(false);
    mocks.getMetadataCachePath.mockReturnValue("/global/mcp-cache.json");
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockImplementation(direct.createDirectToolExecutor);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.normalizeDirectToolInputSchema.mockImplementation(utils.normalizeDirectToolInputSchema);
    mocks.truncateAtWord.mockImplementation((text) => text);
    mocks.writeProjectServerDisabledOverride.mockReturnValue({
      path: "/tmp/project/.pi/fitch-mcp-adapter/mcp.json",
      changed: true,
    });
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) {
      await host.dispose();
      assert.deepEqual(host.errors, []);
    }
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  it("keeps the gateway loadable while pinned tools are undiscovered", async () => {
    const config = {
      mcpServers: { demo: { command: "demo", directTools: true } },
      settings: { disableProxyTool: true },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    const { default: adapter } = await import("../index.ts");
    const { api, spies, handlers, tool: registeredTool } = await createPi();
    adapter(api);
    await handlers.get("session_start")({}, {});
    expect(api.getActiveTools()).not.toContain("mcp");
    const search = registeredTool("mcp_search");
    expect(await search.execute("enable", { enable: ["gateway"] })).toHaveProperty("tools", [
      { name: "mcp" },
    ]);
    expect(api.getActiveTools()).toContain("mcp");
    expect(spies.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "demo_search" }),
    );
  }, 15_000);

  it("waits for env-selected cold-cache tools and registers their exact schemas", async () => {
    process.env.MCP_DIRECT_TOOLS = "demo/search";
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    const schema: NonNullable<ToolMetadata["inputSchema"]> = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { query: { type: "string", description: "Query" } },
      additionalProperties: false,
    };
    const initialization = Promise.withResolvers<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.initializeMcp.mockReturnValue(initialization.promise);
    const { default: adapter } = await import("../index.ts");
    const { api, spies, handlers, tool: registeredTool } = await createPi();
    adapter(api);
    let started = false;
    const start = handlers
      .get("session_start")({}, {})
      .finally(() => {
        started = true;
      });
    await nextTurn();
    expect(started).toBe(false);
    expect(spies.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "demo_search" }),
    );
    state.toolMetadata.set("demo", [
      { name: "demo_search", originalName: "search", description: "Search", inputSchema: schema },
    ]);
    initialization.resolve(state);
    await start;
    const definition = registeredTool("demo_search");
    expect(definition.parameters).toEqual(schema);
    expect(definition).not.toHaveProperty("promptSnippet");
    expect(api.getActiveTools()).toContain("demo_search");
  });

  it.each([false, true])(
    "refreshes pins and gateway while preserving a manual deactivation (%s)",
    async (manuallyDisabled) => {
      const config = {
        mcpServers: { demo: { command: "demo", directTools: true } },
        settings: { disableProxyTool: true },
      };
      const state = createState();
      state.config = config;
      const tool = { name: "demo_search", originalName: "search", description: "Search" };
      state.toolMetadata.set("demo", [tool]);
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.initializeMcp.mockResolvedValue(state);
      const { default: adapter } = await import("../index.ts");
      const { api, spies, handlers, tool: registeredTool } = await createPi();
      adapter(api);
      await handlers.get("session_start")({}, {});
      await Promise.resolve();
      expect(api.getActiveTools()).toContain("demo_search");
      expect(api.getActiveTools()).not.toContain("mcp");
      if (manuallyDisabled) {
        api.setActiveTools(api.getActiveTools().filter((name) => name !== "demo_search"));
      }
      state.toolMetadata.set("demo", []);
      mocks.buildProxyDescription.mockReturnValue("MCP gateway refreshed");
      await requireValue(state.onToolMetadataUpdated)("demo", "tools-list-changed");
      expect(api.getActiveTools()).not.toContain("demo_search");
      expect(api.getActiveTools()).not.toContain("mcp");
      const search = registeredTool("mcp_search");
      expect(await search.execute("enable", { enable: ["gateway"] })).toHaveProperty("tools", [
        { name: "mcp" },
      ]);
      expect(spies.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "mcp", description: "MCP gateway refreshed" }),
      );
      state.toolMetadata.set("demo", [{ ...tool, description: "Search v2" }]);
      await requireValue(state.onToolMetadataUpdated)("demo", "tools-list-changed");
      expect(spies.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "demo_search", description: "Search v2" }),
      );
      expect(api.getActiveTools().includes("demo_search")).toBe(!manuallyDisabled);
      expect(await search.execute("disabled", { enable: ["gateway"] })).toHaveProperty(
        "details.unavailable",
        ["gateway"],
      );
      expect(api.getActiveTools()).not.toContain("mcp");
    },
  );

  it("keeps the gateway for legacy resource pins without registering fake functions", async () => {
    const config = {
      mcpServers: { demo: { command: "demo", directTools: true } },
      settings: { disableProxyTool: true },
    };
    const state = createState();
    state.config = config;
    state.toolMetadata.set("demo", [
      { name: "demo_search", originalName: "search", description: "Search" },
      {
        name: "demo_read_doc",
        originalName: "read_doc",
        description: "Doc",
        resourceUri: "docs://doc",
      },
    ]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: adapter } = await import("../index.ts");
    const { api, spies, handlers } = await createPi();
    adapter(api);
    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    expect(api.getActiveTools()).toContain("demo_search");
    expect(api.getActiveTools()).toContain("mcp");
    expect(spies.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "demo_read_doc" }),
    );
  });

  it("keeps cached unselected tools inactive after the gateway's config refresh on official Pi", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const { computeServerHash } = await import("../metadata-cache.ts");
    const state = createState();
    state.config = config;
    const init = Promise.withResolvers<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockReturnValue(init.promise);
    mocks.loadMetadataCache.mockReturnValue({
      version: 2,
      servers: {
        demo: {
          configHash: computeServerHash(config.mcpServers.demo),
          cachedAt: Date.now(),
          resources: [],
          tools: [{ name: "search" }],
        },
      },
    });
    mocks.buildProxyDescription.mockImplementation(
      (currentConfig) => `Servers: ${Object.keys(currentConfig.mcpServers).join(",")}`,
    );
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = await createPi();
    adapter(api);
    try {
      await handlers.get("session_start")({}, {});
      expect(api.getAllTools().some((tool) => tool.name === "demo_search")).toBe(true);
      expect(api.getActiveTools()).not.toContain("demo_search");
    } finally {
      init.resolve(state);
      await Promise.resolve();
      await handlers.get("session_shutdown")();
    }
  });

  it("loads an initially inactive schema when discovery selects it", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    state.toolMetadata.set("demo", [
      { name: "demo_search", originalName: "search", description: "Search" },
    ]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeSearch.mockReturnValue({
      content: [{ type: "text", text: "Search" }],
      details: {},
    });
    const { default: adapter } = await import("../index.ts");
    const { api, spies, handlers, tool: registeredTool } = await createPi();
    adapter(api);
    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    expect(api.getActiveTools()).not.toContain("demo_search");
    const search = registeredTool("mcp_search");
    const result = await search.execute("search-1", { query: "search", server: "demo" });
    expect(result).toHaveProperty("tools", [{ name: "demo_search" }]);
    expect(api.getActiveTools()).toContain("demo_search");
    expect(spies.appendEntry).toHaveBeenCalledWith(
      "mcp-tool-selection",
      expect.objectContaining({ selected: [{ server: "demo", tool: "search" }] }),
    );
  });

  it("loads front doors without waiting for startup and retains transformed restrictions on a branch change", async () => {
    const config: McpConfig = {
      mcpServers: { demo: { command: "unused", lifecycle: "lazy" } },
      settings: { scriptMode: false },
    };
    const state = createState();
    state.config = config;
    const initialization = Promise.withResolvers<typeof state>();
    mocks.initializeMcp.mockReturnValue(initialization.promise);
    const beforeExecute = vi
      .fn<NonNullable<McpAdapterOptions["beforeExecute"]>>()
      .mockResolvedValue();
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    createMcpAdapter({ transformConfig: () => config, beforeExecute })(api);
    await handlers.get("session_start")({}, {});
    try {
      const search = registeredTool("mcp_search");
      const loaded = await search.execute("enable", {
        enable: ["gateway", "script"],
        server: "demo",
      });
      expect(loaded.details).toEqual({ loaded: [{ name: "mcp" }], unavailable: ["script"] });
      expect(beforeExecute).toHaveBeenCalledTimes(1);
      expect(mocks.executeConnect).not.toHaveBeenCalled();
      expect(mocks.executeSearch).not.toHaveBeenCalled();
      await handlers.get("session_tree")({}, {});
      expect(api.getActiveTools()).toEqual(["bash", "mcp_search", "mcp"]);
      expect(api.getAllTools().some((tool) => tool.name === "mcp_script")).toBe(false);
    } finally {
      initialization.resolve(state);
      await Promise.resolve();
      await handlers.get("session_shutdown")();
    }
  });

  it("loads the advertised next page and retry through public tool names", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    state.toolMetadata.set(
      "demo",
      ["alpha", "beta"].map((name) => ({
        name: `demo_${name}`,
        originalName: name,
        description: "Find records",
      })),
    );
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    const realProxy = await vi.importActual<typeof Proxy>("../proxy-modes.ts");
    mocks.executeSearch.mockImplementation(realProxy.executeSearch);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    adapter(api);
    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    const search = registeredTool("mcp_search");
    const gateway = registeredTool("mcp");
    const active = () => api.getActiveTools().map((name) => ({ name }));
    const beta = { name: "demo_beta" };
    const params = { query: "records", server: "demo", limit: 1 };
    const page = await search.execute("page-1", params);
    expect(active()).not.toContainEqual(beta);
    // Dispatch the operation printed in the result, rather than constructing page two ourselves.
    const follow = (result: Awaited<ReturnType<typeof search.execute>>) => {
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const call = requireValue(text.match(/(mcp_search|mcp)\((\{[^\n]+\})\)/));
      expect(call).not.toBeNull();
      const parsed: unknown = JSON.parse(requireValue(call[2]).replace(/(\w+):/g, '"$1":'));
      const args = z.record(z.string(), z.unknown()).parse(parsed);
      return (call[1] === "mcp_search" ? search : gateway).execute("follow", args);
    };
    const before = active();
    const metadataPage = await gateway.execute("metadata-page", { action: "search", ...params });
    const firstBlock = requireValue(metadataPage.content[0]);
    assert.equal(firstBlock.type, "text");
    expect(firstBlock.text).toContain('mcp({ action: "search"');
    await follow(metadataPage);
    expect(active()).toEqual(before);
    expect(active()).not.toContainEqual(beta);
    const next = await follow(page);
    expect(next).toHaveProperty("tools", [beta]);
    expect(active()).toContainEqual(beta);
    expect(next).toMatchObject({ details: { matches: [{ tool: "demo_beta" }] } });
    expect(next).toHaveProperty("details.query", params.query);
    const retry = await search.execute("out-of-range", { ...params, offset: 99 });
    expect(await follow(retry)).toMatchObject({ details: { matches: [{ tool: "demo_alpha" }] } });
    expect(mocks.executeConnect).not.toHaveBeenCalled();
  });

  it("advertises object args and explicit actions while preparing legacy JSON strings", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, tool: registeredTool } = await createPi();
    mcpAdapter(api);

    const proxyTool = registeredTool("mcp");
    expect(proxyTool).toBeDefined();

    const schema = z
      .object({
        properties: z.object({ args: z.unknown() }),
        required: z.array(z.string()),
      })
      .parse(proxyTool.parameters);
    const argsSchema = schema.properties.args;
    expect(argsSchema).toMatchObject({ type: "object", additionalProperties: true });
    expect(schema.required).toContain("action");
    expect(
      requireValue(proxyTool.prepareArguments)({ tool: "demo_search", args: '{"q":"hello"}' }),
    ).toEqual({
      action: "call",
      tool: "demo_search",
      args: { q: "hello" },
    });
    expect(JSON.stringify(argsSchema)).not.toContain("patternProperties");
  });

  it("forwards native object proxy args into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }], details: {} });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = registeredTool("mcp");
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { tool: "demo_search", args: { q: "hello", limit: 10 } });

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello", limit: 10 },
      undefined,
      expect.any(Function),
      undefined,
      { toolCallId: "call-1" },
      undefined,
    );
  });

  it("forwards pagination into server listings", async () => {
    const state = createState();
    state.toolMetadata.set("demo", []);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeList.mockReturnValue({ content: [{ type: "text", text: "ok" }], details: {} });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);

    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = registeredTool("mcp");
    await proxyTool.execute("call-1", { server: "demo", limit: 5, offset: 10 });

    expect(mocks.executeList).toHaveBeenCalledWith(state, "demo", 5, 10);
  });

  it("routes manual auth actions through the proxy tool", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeAuthStart.mockResolvedValue({
      content: [{ type: "text", text: "auth url" }],
      details: {},
    });
    mocks.executeAuthComplete.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = registeredTool("mcp");
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { action: "auth-start", server: "demo" });
    await proxyTool.execute("call-2", {
      action: "auth-complete",
      server: "demo",
      args: '{"redirectUrl":"http://localhost:19876/callback?code=abc&state=state"}',
    });

    expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo", undefined);
    expect(mocks.executeAuthComplete).toHaveBeenCalledWith(
      state,
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
      undefined,
    );

    const signal = new AbortController().signal;
    await proxyTool.execute("call-3", { action: "auth-complete", server: "demo" }, signal);
    expect(mocks.executeAuthComplete).toHaveBeenLastCalledWith(state, "demo", undefined, signal);
    for (const args of [{}, "{}", { code: "raw-code" }, { input: "raw-code" }]) {
      await proxyTool.execute("call-4", { action: "auth-complete", server: "demo", args });
      expect(requireValue(mocks.executeAuthComplete.mock.calls.at(-1))).toEqual([
        state,
        "demo",
        typeof args === "object" && Object.keys(args).length > 0 ? "raw-code" : undefined,
        undefined,
      ]);
    }
    const calls = mocks.executeAuthComplete.mock.calls.length;
    for (const args of [{ code: "" }, { redirectUrl: 42 }, { input: "  " }]) {
      await expect(
        proxyTool.execute("call-5", { action: "auth-complete", server: "demo", args }),
      ).rejects.toThrow("non-empty");
    }
    expect(mocks.executeAuthComplete).toHaveBeenCalledTimes(calls);
  });

  it("forwards the proxy tool AbortSignal into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }], details: {} });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = registeredTool("mcp");
    expect(proxyTool).toBeDefined();

    const controller = new AbortController();
    await proxyTool.execute(
      "call-1",
      { tool: "demo_search", args: '{"q":"hello"}' },
      controller.signal,
    );

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello" },
      undefined,
      expect.any(Function),
      controller.signal,
      { toolCallId: "call-1" },
      undefined,
    );
  });

  it("exports createMcpAdapter while retaining the default adapter export", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const adapterModule = await import("../index.ts");
    expect(adapterModule.createMcpAdapter).toBeTypeOf("function");
    expect(adapterModule.default).toBeTypeOf("function");

    const { api, handlers } = await createPi();
    adapterModule.default(api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_start")({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(undefined, process.cwd(), {
      includeProject: true,
    });
  });

  it("uses only the supplied config after session startup", async () => {
    const config = {
      mcpServers: { memory: { url: "https://memory.example.com/mcp", directTools: true } },
      settings: { disableProxyTool: true },
    };
    const state = createState();
    state.config = structuredClone(config);
    state.toolMetadata.set("memory", [
      { name: "memory_search", originalName: "search", description: "Search" },
    ]);
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, spies, handlers } = await createPi();
    createMcpAdapter({ config })(api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(spies.registerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory_search" }),
    );
    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    expect(spies.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory_search" }),
    );
    expect(api.getActiveTools()).not.toContain("mcp");
    expect(mocks.initializeMcp).toHaveBeenCalledWith(
      api,
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
    const supplied = requireValue(mocks.initializeMcp.mock.calls[0]?.[3]).config;
    expect(supplied).toMatchObject({ mcpServers: config.mcpServers });
    expect(supplied).not.toBe(config);
  });

  it.each([false, true])(
    "transforms each session's resolved config before registration and initialization (snapshot=%s)",
    async (snapshot) => {
      const source: McpConfig = {
        mcpServers: { docs: { command: "docs-server", env: { ORIGINAL: "yes" } } },
        settings: { autoAuth: true, scriptMode: true },
      };
      const original = structuredClone(source);
      const sharedSettings = { autoAuth: false, scriptMode: false };
      const inputs: McpConfig[] = [];
      const states: ReturnType<typeof createState>[] = [];
      const transformConfig = vi.fn<NonNullable<McpAdapterOptions["transformConfig"]>>(
        function transformsSuppliedConfig(config, ctx) {
          inputs.push(structuredClone(config));
          // Hosts may modify their input clone and return objects shared with their own config.
          assert(config.mcpServers.docs?.env !== undefined);
          // oxlint-disable-next-line eslint/no-param-reassign -- QX-012: exercise the adapter-owned input snapshot.
          config.mcpServers.docs.env.ORIGINAL = "transformed";
          return {
            ...config,
            settings: sharedSettings,
            mcpServers: {
              ...config.mcpServers,
              ephemeral: {
                command: "session-server",
                lifecycle: "lazy",
                env: { SESSION: ctx.sessionManager.getSessionId() },
              },
            },
          };
        },
      );
      mocks.loadMcpConfig.mockReturnValue(source);
      const { buildProxyDescription } = await vi.importActual<typeof Direct>("../direct-tools.ts");
      mocks.buildProxyDescription.mockImplementation(buildProxyDescription);
      mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => {
        const tools = spies.registerTool.mock.calls.map(([tool]) => tool);
        expect(tools.map((tool) => tool.name)).toEqual(["mcp_search", "mcp"]);
        expect(requireValue(tools.find((tool) => tool.name === "mcp")).description).toContain(
          "ephemeral",
        );
        const state = createState();
        state.config = requireValue(options?.config ?? options?.resolvedConfig);
        states.push(state);
        return state;
      });

      const { createMcpAdapter } = await import("../index.ts");
      const { api, spies, handlers, tool: registeredTool } = await createPi();
      createMcpAdapter({ ...(snapshot ? { config: source } : {}), transformConfig })(api);
      expect(spies.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["mcp_search"]);
      expect(transformConfig).not.toHaveBeenCalled();

      const reasons: SessionStartEvent["reason"][] = ["startup", "reload", "new"];
      for (const [index, reason] of reasons.entries()) {
        const sessionManager = SessionManager.inMemory(process.cwd());
        const sessionId = sessionManager.getSessionId();
        await handlers.get("session_start")({ reason }, { sessionManager });
        await Promise.resolve();
        const initialization = requireValue(mocks.initializeMcp.mock.calls[index]);
        const options = requireValue(initialization[3]);
        const runtimeConfig = snapshot ? options.config : options.resolvedConfig;
        expect(options).not.toHaveProperty(snapshot ? "resolvedConfig" : "config");
        expect(runtimeConfig).toEqual({
          mcpServers: {
            docs: { command: "docs-server", env: { ORIGINAL: "transformed" } },
            ephemeral: {
              command: "session-server",
              lifecycle: "lazy",
              env: { SESSION: sessionId },
            },
          },
          settings: { autoAuth: false, scriptMode: false },
        });
        const transform = requireValue(transformConfig.mock.calls[index]);
        expect(transform[1]).toBe(initialization[1]);
        expect(transform[1].sessionManager).toBe(sessionManager);
        expect(
          mocks.buildProxyDescription.mock.calls.some(([config]) => config === runtimeConfig),
        ).toBe(true);
        const proxy = registeredTool("mcp");
        expect(proxy.description).toContain("ephemeral");
        expect(proxy.description).toContain("docs");
        expect(spies.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
          "mcp_search",
          "mcp",
        ]);
        expect(transformConfig).toHaveBeenCalledTimes(index + 1);

        // Runtime edits must not leak into a retained hook result or the next session.
        const runtime = requireValue(states[index]).config;
        requireValue(runtime.settings).scriptMode = true;
        requireValue(requireValue(runtime.mcpServers.ephemeral).env).SESSION = "runtime-edit";
        const result = requireValue(transformConfig.mock.results[index]);
        assert.equal(result.type, "return");
        expect(requireValue(result.value.settings).scriptMode).toBe(false);
        expect(requireValue(requireValue(result.value.mcpServers.ephemeral).env).SESSION).toBe(
          sessionId,
        );
      }
      expect(inputs).toEqual([original, original, original]);
      expect(source).toEqual(original);
      expect(sharedSettings).toEqual({ autoAuth: false, scriptMode: false });
      expect(mocks.loadMcpConfig).toHaveBeenCalledTimes(snapshot ? 0 : reasons.length);
      await handlers.get("session_shutdown")();
    },
  );

  it("keeps ambient trust resolution and configuration panels when transforming config", async () => {
    const globalConfig: McpConfig = { mcpServers: { global: { command: "global-server" } } };
    const trustedConfig: McpConfig = {
      mcpServers: { ...globalConfig.mcpServers, project: { command: "project-server" } },
    };
    mocks.loadMcpConfig.mockImplementation((_path, _cwd, options) =>
      options?.includeProject === true ? trustedConfig : globalConfig,
    );
    mocks.writeProjectServerDisabledOverride.mockReturnValue({
      path: "/project/.pi/fitch-mcp-adapter/mcp.json",
      changed: true,
    });
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => ({
      ...createState(),
      config: requireValue(options?.resolvedConfig),
    }));
    const transformConfig = vi.fn<NonNullable<McpAdapterOptions["transformConfig"]>>(
      (config) => config,
    );
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    createMcpAdapter({ configPath: "/host/mcp.json", transformConfig })(api);
    const command = registeredCommand("mcp");
    const auth = registeredCommand("mcp-auth");
    const ctx = {
      cwd: "/project",
      hasUI: true,
      ui: { notify: vi.fn<() => void>() },
      isProjectTrusted: () => false,
    };
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await command.handler("disable global", ctx);
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(requireValue(transformConfig.mock.calls[0])[0]).toEqual(globalConfig);
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/host/mcp.json", "/project", {
      includeProject: false,
    });

    ctx.isProjectTrusted = () => true;
    await handlers.get("session_start")({ reason: "reload" }, ctx);
    expect(requireValue(transformConfig.mock.calls[1])[0]).toEqual(trustedConfig);
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/host/mcp.json", "/project", {
      includeProject: true,
    });
    await command.handler("status", ctx);
    await command.handler("setup", ctx);
    await command.handler("disable project", ctx);
    await auth.handler("", ctx);
    expect(mocks.openMcpPanel).toHaveBeenCalledWith(
      expect.any(Object),
      api,
      expect.any(Object),
      "/host/mcp.json",
      expect.any(Function),
    );
    expect(mocks.openMcpSetup).toHaveBeenCalledWith(
      expect.any(Object),
      api,
      expect.any(Object),
      "/host/mcp.json",
      "setup",
    );
    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "/host/mcp.json",
    );
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith(
      "/host/mcp.json",
      "/project",
      "project",
      true,
    );
    await handlers.get("session_shutdown")();
  });

  it("loads gateways without direct registration with MCP_DIRECT_TOOLS=__none__ through metadata updates", async () => {
    process.env.MCP_DIRECT_TOOLS = "__none__";
    const config: McpConfig = {
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "lazy", directTools: true },
        other: { command: "other-server", lifecycle: "lazy", directTools: true },
      },
      settings: { directTools: true, disableProxyTool: true },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    for (const server of ["demo", "other"]) {
      state.toolMetadata.set(server, [
        { name: `${server}_search`, originalName: "search", description: "Search" },
      ]);
    }
    mocks.executeConnect.mockImplementation(async (currentState, server) => {
      await requireValue(currentState.onToolMetadataUpdated)(server, "lazy-connect");
      return { content: [{ type: "text", text: `Connected ${server}` }], details: {} };
    });
    mocks.executeCall.mockResolvedValue({
      content: [{ type: "text", text: "Search result" }],
      details: {},
    });
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, spies, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);
    await handlers.get("session_start")({}, {});
    expect(api.getActiveTools()).toEqual(["bash", "mcp_search"]);
    const search = registeredTool("mcp_search");
    expect(await search.execute("enable", { enable: ["gateway", "script"] })).toHaveProperty(
      "tools",
      [{ name: "mcp" }, { name: "mcp_script" }],
    );
    const proxy = registeredTool("mcp");
    for (const server of ["demo", "other"]) {
      expect(await proxy.execute(`connect-${server}`, { connect: server })).toEqual({
        content: [{ type: "text", text: `Connected ${server}` }],
        details: {},
      });
      await requireValue(state.onToolMetadataUpdated)(server, "tools-list-changed");
      expect(await proxy.execute(`call-${server}`, { tool: `${server}_search`, server })).toEqual({
        content: [{ type: "text", text: "Search result" }],
        details: {},
      });
      const invocation = requireValue(mocks.executeCall.mock.calls.at(-1));
      expect(invocation.slice(0, 4)).toEqual([state, `${server}_search`, undefined, server]);
      expect(invocation[4]).toBeTypeOf("function");
      expect(invocation.slice(5)).toEqual([undefined, { toolCallId: `call-${server}` }, undefined]);
      expect(spies.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
        "mcp_search",
        "mcp",
        "mcp_script",
      ]);
      expect(api.getActiveTools().sort()).toEqual(["bash", "mcp", "mcp_script", "mcp_search"]);
    }
    expect(requireValue(mocks.initializeMcp.mock.calls[0]?.[3]).resolvedConfig).toEqual(config);
    await handlers.get("session_shutdown")();
  });

  it("snapshots caller config and isolates separate factories", async () => {
    const firstConfig = { mcpServers: { first: { url: "https://first.example.com/mcp" } } };
    const secondConfig = { mcpServers: { second: { url: "https://second.example.com/mcp" } } };
    const firstAdapter = (await import("../index.ts")).createMcpAdapter({ config: firstConfig });
    const secondAdapter = (await import("../index.ts")).createMcpAdapter({ config: secondConfig });
    firstConfig.mcpServers.first.url = "https://mutated.example.com/mcp";

    const firstPi = await createPi();
    const secondPi = await createPi();
    firstAdapter(firstPi.api);
    secondAdapter(secondPi.api);

    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => ({
      ...createState(),
      config: requireValue(options?.config),
    }));
    await firstPi.handlers.get("session_start")({}, {});
    await secondPi.handlers.get("session_start")({}, {});
    expect(mocks.initializeMcp.mock.calls.at(-2)?.[3]?.config).toEqual({
      mcpServers: { first: { url: "https://first.example.com/mcp" } },
    });
    expect(mocks.initializeMcp.mock.calls.at(-1)?.[3]?.config).toEqual(secondConfig);
  });

  it("defers explicit config paths until trusted session startup", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter, default: defaultAdapter } = await import("../index.ts");

    const configuredPi = await createPi();
    createMcpAdapter({ configPath: "/factory.json" })(configuredPi.api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await configuredPi.handlers.get("session_start")({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/factory.json", process.cwd(), {
      includeProject: true,
    });

    mocks.loadMcpConfig.mockClear();
    const defaultPi = await createPi();
    defaultPi.spies.getFlag.mockReturnValue("/flag.json");
    defaultAdapter(defaultPi.api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await defaultPi.handlers.get("session_start")({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/flag.json", process.cwd(), {
      includeProject: true,
    });
  });

  it("resolves SDK flag config paths against the trusted session cwd", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, spies, handlers } = await createPi();
    spies.getFlag.mockReturnValue("/sdk/mcp.json");
    mcpAdapter(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_start")(
      {},
      {
        cwd: "/actual/project",
        isProjectTrusted: () => false,
      },
    );

    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/sdk/mcp.json", "/actual/project", {
      includeProject: false,
    });
  });

  it("uses status notifications instead of ambient panels in memory-config mode", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    createMcpAdapter({
      config: { mcpServers: { memory: { url: "https://memory.example.com/mcp" } } },
    })(api);
    const ui = { notify: vi.fn<() => void>() };
    await handlers.get("session_start")({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    await commandDef.handler("setup", { hasUI: true, ui });
    await commandDef.handler("disable memory", { hasUI: true, ui });
    await commandDef.handler("status", { hasUI: true, ui });
    const authDef = registeredCommand("mcp-auth");
    await authDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpSetup).not.toHaveBeenCalled();
    expect(mocks.openMcpPanel).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("in-memory"), "info");
  });

  it("starts a replacement init immediately and shuts down stale init results", async () => {
    const first = Promise.withResolvers<McpExtensionState>();
    const second = Promise.withResolvers<McpExtensionState>();
    mocks.initializeMcp.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).not.toHaveBeenCalled();
    const firstRuntime = requireValue(mocks.initializeMcp.mock.calls[0]?.[3]?.oauthRuntime);

    await sessionStart({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(firstRuntime);

    const activeState = createState();
    const activeShutdown = vi.spyOn(activeState.lifecycle, "gracefulShutdown");
    second.resolve(activeState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
    expect(activeShutdown).not.toHaveBeenCalled();

    const staleState = createState();
    const staleShutdown = vi.spyOn(staleState.lifecycle, "gracefulShutdown");
    first.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleShutdown).toHaveBeenCalledTimes(1);
  });

  it("defers project config reads and server startup until session trust is known", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, spies, handlers } = await createPi();
    spies.getFlag.mockReturnValue("/project/.pi/mcp.json");
    mcpAdapter(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(mocks.initializeMcp).not.toHaveBeenCalled();

    await handlers.get("session_start")({}, { isProjectTrusted: () => false });
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/project/.pi/mcp.json", process.cwd(), {
      includeProject: false,
    });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    await handlers.get("session_start")({}, { isProjectTrusted: () => true });
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/project/.pi/mcp.json", process.cwd(), {
      includeProject: true,
    });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
  });

  it("bounds the proxy tool wait when session initialization stalls", async () => {
    const never = Promise.withResolvers<McpExtensionState>();
    mocks.initializeMcp.mockReturnValue(never.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, tool: registeredTool } = await createPi();
    mcpAdapter(api);
    await handlers.get("session_start")({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      const proxyTool = registeredTool("mcp");
      expect(proxyTool).toBeDefined();

      const resultPromise = proxyTool.execute("call-1", { search: "demo" });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result.details).toEqual({ error: "init_timeout", timeoutMs: 30_000 });
      expect(mocks.executeSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports shutdown persistence failures only after all cleanup has finished", async () => {
    const state = createState();
    const cleanup: PromiseWithResolvers<void> = Promise.withResolvers();
    const cleanupStarted: PromiseWithResolvers<void> = Promise.withResolvers();
    const gracefulShutdown = vi
      .spyOn(state.lifecycle, "gracefulShutdown")
      .mockImplementation(() => {
        cleanupStarted.resolve();
        return cleanup.promise;
      });
    const uiServer = await startUiServer({
      serverName: "demo",
      toolName: "view",
      toolArgs: {},
      resource: { uri: "ui://demo/view", html: "<p>Cleanup</p>", mimeType: "text/html", meta: {} },
      manager: state.manager,
      consentManager: state.consentManager,
      port: 0,
    });
    const close = uiServer.close.bind(uiServer);
    vi.spyOn(uiServer, "close").mockImplementation((reason) => {
      close(reason);
      throw new Error("UI cleanup failed");
    });
    state.uiServer = uiServer;
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers, shutdownCallback } = await createPi();
    adapter(api);
    await handlers.get("session_start")({}, {});
    await Promise.resolve();
    mocks.flushMetadataCache.mockImplementation(() => {
      throw new Error("metadata persistence failed");
    });
    mocks.shutdownOAuth.mockRejectedValue(new Error("OAuth cleanup failed"));
    let finished = false;
    const outcome = Promise.allSettled([
      shutdownCallback().finally(() => {
        finished = true;
      }),
    ]);
    await cleanupStarted.promise;
    expect(state.uiServer).toBeNull();
    expect(gracefulShutdown).toHaveBeenCalledOnce();
    expect(mocks.shutdownOAuth).toHaveBeenCalled();
    expect(finished).toBe(false);
    cleanup.resolve();
    const result = requireValue((await outcome)[0]);
    assert.equal(result.status, "rejected");
    const error: unknown = result.reason;
    assert(error instanceof AggregateError);
    expect(error.message).toContain("persistence/cleanup failed");
    const causes: unknown[] = error.errors;
    expect(causes).toHaveLength(2);
    const stateFailure = requireValue(causes[0]);
    assert(stateFailure instanceof AggregateError);
    const stateCauses: unknown[] = stateFailure.errors;
    expect(
      stateCauses.map((cause) => {
        assert(cause instanceof Error);
        return cause.message;
      }),
    ).toEqual(["UI cleanup failed", "metadata persistence failed"]);
  });

  it("shuts down OAuth on session_shutdown", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");

    await sessionStart({}, {});
    await Promise.resolve();
    await Promise.resolve();

    mocks.shutdownOAuth.mockClear();

    await sessionShutdown();

    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
  });

  it("completes current `/mcp` subcommands and server arguments", async () => {
    const state = createState();
    state.config.mcpServers = {
      github: { command: "github-mcp" },
      gitlab: { command: "gitlab-mcp" },
      notion: { command: "notion-mcp" },
    };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, spies, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const commandDef = registeredCommand("mcp");
    expect(await commandDef.getArgumentCompletions("reconnect ")).toBeNull();

    await handlers.get("session_start")({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      requireValue(await commandDef.getArgumentCompletions("")).map(({ value }) => value),
    ).toEqual(["reconnect", "tools", "prompts", "setup", "logout", "disable", "enable", "status"]);
    expect(await commandDef.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status — Show server status" },
    ]);
    expect(await commandDef.getArgumentCompletions("reconnect ")).toEqual([
      { value: "reconnect github", label: "github" },
      { value: "reconnect gitlab", label: "gitlab" },
      { value: "reconnect notion", label: "notion" },
    ]);
    expect(await commandDef.getArgumentCompletions("  logout git")).toEqual([
      { value: "logout github", label: "github" },
      { value: "logout gitlab", label: "gitlab" },
    ]);
    expect(await commandDef.getArgumentCompletions("disable git")).toEqual([
      { value: "disable github", label: "github" },
      { value: "disable gitlab", label: "gitlab" },
    ]);
    expect(await commandDef.getArgumentCompletions("enable not")).toEqual([
      { value: "enable notion", label: "notion" },
    ]);
    expect(await commandDef.getArgumentCompletions("tools anything")).toBeNull();
    expect(spies.registerCommand.mock.calls.some((call) => call[0] === "mcp-reconnect")).toBe(
      false,
    );
  });

  it("hot-registers prompt commands after live prompt metadata refresh", async () => {
    const state = createState();
    state.promptMetadata = new Map();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, spies, handlers } = await createPi();
    mcpAdapter(api);

    await handlers.get("session_start")({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    spies.registerCommand.mockClear();
    state.promptMetadata.set("demo", [
      {
        serverName: "demo",
        originalName: "brief",
        commandName: "mcp__demo__brief",
        description: "Brief",
        arguments: [],
      },
    ]);
    await requireValue(state.onToolMetadataUpdated)("demo", "prompts-list-changed");

    const registered = requireValue(
      spies.registerCommand.mock.calls.find(([name]) => name === "mcp__demo__brief"),
    );
    expect(registered[0]).toBe("mcp__demo__brief");
    expect(registered[1].description).toContain("Brief");
    expect(registered[1].handler).toBeTypeOf("function");
  });

  it("routes `/mcp setup` to the onboarding flow", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui: { notify: vi.fn<() => void>() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    expect(commandDef).toBeDefined();

    await commandDef.handler("setup", { hasUI: true, ui: { notify: vi.fn<() => void>() } });

    expect(mocks.openMcpSetup).toHaveBeenCalledWith(
      state,
      api,
      expect.any(Object),
      undefined,
      "setup",
    );
  });

  it("routes `/mcp logout <server>` to credential logout", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    await commandDef.handler("logout oauth-server", { hasUI: true, ui });

    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, expect.any(Object));
  });

  it("writes project-local disabled overrides and rejects unknown servers", async () => {
    const state = createState();
    state.config.mcpServers = { global: { url: "https://example.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);
    await handlers.get("session_start")(
      {},
      { hasUI: true, cwd: "/tmp/project", ui: { notify: vi.fn<() => void>() } },
    );
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    const ui = { notify: vi.fn<() => void>() };
    await commandDef.handler("disable global", { hasUI: true, cwd: "/tmp/project", ui });
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith(
      undefined,
      "/tmp/project",
      "global",
      true,
    );
    await commandDef.handler("disable missing", { hasUI: true, cwd: "/tmp/project", ui });
    expect(ui.notify).toHaveBeenCalledWith(
      'Server "missing" not found in effective config',
      "error",
    );
  });

  it("shows usage for `/mcp logout` without a server", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    await commandDef.handler("logout", { hasUI: true, ui });

    expect(mocks.logoutServer).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /mcp logout <server>", "error");
  });

  it("triggers core reload after setup changes config", async () => {
    const initialState = createState();
    mocks.initializeMcp.mockResolvedValue(initialState);
    mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const reload = vi.fn<() => Promise<void>>().mockResolvedValue();
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp");
    await commandDef.handler("setup", { hasUI: true, ui, reload });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.flushMetadataCache).not.toHaveBeenCalledWith(initialState);
  });

  it("opens the auth picker for `/mcp-auth` without args in UI sessions", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp-auth");
    await commandDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(state, expect.any(Object), undefined);
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("reconnects after explicit `/mcp-auth <server>` succeeds", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp-auth");
    await commandDef.handler("github", { hasUI: true, ui });

    const authentication = requireValue(mocks.authenticateServer.mock.calls.at(-1));
    expect(authentication).toHaveLength(5);
    expect(authentication[0]).toBe("github");
    expect(authentication[1]).toBe(state.config);
    expect(authentication[2]).toBeTypeOf("object");
    expect(authentication[3]).toBeInstanceOf(AbortSignal);
    expect(authentication[4]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.reconnectServer).toHaveBeenCalledWith(state, expect.any(Object), "github", true);
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("does not reconnect after explicit `/mcp-auth <server>` fails", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: false });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn<() => void>() };
    const sessionStart = handlers.get("session_start");
    await sessionStart({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = registeredCommand("mcp-auth");
    await commandDef.handler("github", { hasUI: true, ui });

    const authentication = requireValue(mocks.authenticateServer.mock.calls.at(-1));
    expect(authentication).toHaveLength(5);
    expect(authentication[0]).toBe("github");
    expect(authentication[1]).toBe(state.config);
    expect(authentication[2]).toBeTypeOf("object");
    expect(authentication[3]).toBeInstanceOf(AbortSignal);
    expect(authentication[4]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.reconnectServer).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("documents that no-arg `/mcp-auth` has no non-UI picker or command feedback path", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, command: registeredCommand } = await createPi();
    mcpAdapter(api);

    const commandDef = registeredCommand("mcp-auth");
    await commandDef.handler("", { hasUI: false });

    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("stops the runtime when initialization rejects before publishing state", async () => {
    mocks.initializeMcp.mockRejectedValue(new Error("init boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Runtime cancellation below verifies the expected initialization failure.
    });

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = await createPi();
      mcpAdapter(api);

      await handlers.get("session_start")({}, {});
      await nextTurn();

      expect(
        requireValue(mocks.initializeMcp.mock.calls[0]?.[3]?.oauthRuntime).signal.aborted,
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs initialization errors when updateStatusBar throws", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.updateStatusBar.mockImplementation(() => {
      throw new Error("status boom");
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // The assertion below owns the expected initialization diagnostic.
    });

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = await createPi();
      mcpAdapter(api);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeTypeOf("function");

      await sessionStart({}, {});
      await Promise.resolve();
      await Promise.resolve();
      await nextTurn();

      expect(consoleError).toHaveBeenCalledWith("MCP initialization failed: status boom");
    } finally {
      consoleError.mockRestore();
    }
  });
});
