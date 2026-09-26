import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpConfig } from "../types.ts";
import type { MetadataCache } from "../metadata-cache.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn((_path: string | undefined, _cwd: string, _options: { includeProject?: boolean }): McpConfig => ({ mcpServers: {} })),
  cloneMcpConfig: vi.fn((config: unknown) => structuredClone(config)),
  isPathInsideProject: vi.fn(() => false),
  getMetadataCachePath: vi.fn(() => "/global/mcp-cache.json"),
  loadMetadataCache: vi.fn((): MetadataCache | null => null),
  buildProxyDescription: vi.fn((_config: McpConfig) => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  getMissingConfiguredDirectToolServers: vi.fn((): string[] => []),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  showPrompts: vi.fn(),
  reconnectServer: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  openMcpAuthPanel: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  writeProjectServerDisabledOverride: vi.fn(() => ({ path: "/tmp/project/.pi/fitch-mcp-adapter/mcp.json", changed: true })),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  normalizeDirectToolInputSchema: vi.fn((schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema)
    ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"))
    : { type: "object", properties: {} }),
  truncateAtWord: vi.fn((text: string) => text),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
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
  ...await importOriginal<typeof import("../metadata-cache.ts")>(),
  getMetadataCachePath: mocks.getMetadataCachePath,
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../direct-tools.ts")>(),
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
  ...await importOriginal<typeof import("../utils.ts")>(),
  formatTerminalError: (error: unknown) => error instanceof Error ? error.message : String(error),
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createState() {
  return {
    manager: { getAllConnections: () => new Map() },
    lifecycle: { gracefulShutdown: vi.fn().mockResolvedValue(undefined) },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi(refreshAllowedTools = false) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["bash"];
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const sessionManager = { getBranch: () => entries };
  return {
    handlers,
    api: {
      registerTool: vi.fn((tool) => {
        if (!tools.has(tool.name) && !activeTools.includes(tool.name)) activeTools.push(tool.name);
        tools.set(tool.name, tool);
        // Official 0.87 refreshes every allowlisted tool when a definition changes.
        if (refreshAllowedTools) activeTools = [...tools.keys()];
      }),
      registerEntryRenderer: vi.fn(),
      appendEntry: vi.fn((customType, data) => entries.push({ type: "custom", customType, data })),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((_name: string, definition: { handler?: (args: string, ctx: Record<string, unknown>) => unknown }) => {
        if (!definition.handler) return;
        const handler = definition.handler;
        definition.handler = (args, context = {}) => handler(args, {
          sessionManager,
          cwd: process.cwd(),
          mode: "print",
          hasUI: false,
          isProjectTrusted: () => true,
          reload: vi.fn().mockResolvedValue(undefined),
          ...context,
        });
      }),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, (eventPayload: unknown, context: Record<string, unknown> = {}) => handler(eventPayload, {
          sessionManager,
          cwd: process.cwd(),
          mode: "print",
          hasUI: false,
          isProjectTrusted: () => true,
          ...context,
        }));
      }),
      getAllTools: vi.fn(() => [...tools.values()]),
      getFlag: vi.fn(() => undefined),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((nextActiveTools: string[]) => {
        activeTools = nextActiveTools;
      }),
    } as any,
  };
}

describe("mcpAdapter session lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    vi.doUnmock("typebox");
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.normalizeDirectToolInputSchema.mockImplementation((schema: unknown) => structuredClone(schema ?? { type: "object", properties: {} }));
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  afterEach(() => {
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  it("keeps the gateway available while pinned tools are undiscovered", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } }, settings: { disableProxyTool: true } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    expect(api.getActiveTools()).toContain("mcp");
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
  }, 15_000);

  it("waits for env-selected cold-cache tools and registers their exact schemas", async () => {
    process.env.MCP_DIRECT_TOOLS = "demo/search";
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { query: { type: "string", description: "Query" } }, additionalProperties: false };
    const initialization = createDeferred<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.initializeMcp.mockReturnValue(initialization.promise);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    let started = false;
    const start = Promise.resolve(handlers.get("session_start")?.({}, {})).then(() => { started = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toBe(false);
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    state.toolMetadata.set("demo", [{ name: "demo_search", originalName: "search", description: "Search", inputSchema: schema }]);
    initialization.resolve(state);
    await start;
    const definition = api.registerTool.mock.calls.find(([tool]: any[]) => tool.name === "demo_search")![0];
    expect(definition.parameters).toEqual(schema);
    expect(definition).not.toHaveProperty("promptSnippet");
    expect(api.getActiveTools()).toContain("demo_search");
  });

  it.each([false, true])("refreshes pins and gateway while preserving a manual deactivation (%s)", async manuallyDisabled => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } }, settings: { disableProxyTool: true } };
    const state = createState();
    state.config = config;
    const tool = { name: "demo_search", originalName: "search", description: "Search" };
    state.toolMetadata.set("demo", [tool]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    expect(api.getActiveTools()).toContain("demo_search");
    expect(api.getActiveTools()).not.toContain("mcp");
    if (manuallyDisabled) api.setActiveTools(api.getActiveTools().filter((name: string) => name !== "demo_search"));
    state.toolMetadata.set("demo", []);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway refreshed");
    state.onToolMetadataUpdated("demo", "tools-list-changed");
    expect(api.getActiveTools()).not.toContain("demo_search");
    expect(api.getActiveTools()).toContain("mcp");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp", description: "MCP gateway refreshed" }));
    state.toolMetadata.set("demo", [{ ...tool, description: "Search v2" }]);
    state.onToolMetadataUpdated("demo", "tools-list-changed");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search", description: "Search v2" }));
    expect(api.getActiveTools().includes("demo_search")).toBe(!manuallyDisabled);
  });

  it("keeps the gateway for legacy resource pins without registering fake functions", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } }, settings: { disableProxyTool: true } };
    const state = createState();
    state.config = config;
    state.toolMetadata.set("demo", [
      { name: "demo_search", originalName: "search", description: "Search" },
      { name: "demo_read_doc", originalName: "read_doc", description: "Doc", resourceUri: "docs://doc" },
    ]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    expect(api.getActiveTools()).toContain("demo_search");
    expect(api.getActiveTools()).toContain("mcp");
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_read_doc" }));
  });

  it("keeps cached unselected tools inactive after the gateway's config refresh on official Pi", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const { computeServerHash } = await import("../metadata-cache.ts");
    const state = createState();
    state.config = config;
    const init = createDeferred<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockReturnValue(init.promise);
    mocks.loadMetadataCache.mockReturnValue({ version: 2, servers: { demo: {
      configHash: computeServerHash(config.mcpServers.demo), cachedAt: Date.now(), resources: [], tools: [{ name: "search" }],
    } } });
    mocks.buildProxyDescription.mockImplementation(config => `Servers: ${Object.keys(config.mcpServers).join(",")}`);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi(true);
    adapter(api);
    try {
      await handlers.get("session_start")?.({}, {});
      expect(api.getAllTools().some((tool: any) => tool.name === "demo_search")).toBe(true);
      expect(api.getActiveTools()).not.toContain("demo_search");
    } finally {
      init.resolve(state);
      await Promise.resolve();
      await handlers.get("session_shutdown")?.();
    }
  });

  it("loads an initially inactive schema when discovery selects it", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    state.toolMetadata.set("demo", [{ name: "demo_search", originalName: "search", description: "Search" }]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeSearch.mockReturnValue({ content: [{ type: "text", text: "Search" }], details: {} });
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    expect(api.getActiveTools()).not.toContain("demo_search");
    const search = api.registerTool.mock.calls.find(([tool]: any[]) => tool.name === "mcp_search")![0];
    const result = await search.execute("search-1", { query: "search", server: "demo" }, undefined, undefined, {});
    expect(result.tools).toEqual([{ name: "demo_search" }]);
    expect(api.getActiveTools()).toContain("demo_search");
    expect(api.appendEntry).toHaveBeenCalledWith("mcp-tool-selection", expect.objectContaining({ selected: [{ server: "demo", tool: "search" }] }));
  });

  it.each([false, true])("loads the advertised next page and retry, native host: %s", async (native) => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    const state = createState();
    state.config = config;
    state.toolMetadata.set("demo", ["alpha", "beta"].map(name => ({
      name: `demo_${name}`, originalName: name, description: "Find records",
    })));
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);
    const realProxy = await vi.importActual<typeof import("../proxy-modes.ts")>("../proxy-modes.ts");
    mocks.executeSearch.mockImplementation(realProxy.executeSearch);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    if (native) {
      let refs: Array<{ name: string; namespace?: string }> = [];
      api.registerToolSearch = vi.fn();
      api.getActiveToolReferences = () => refs;
      api.setActiveToolReferences = (next: typeof refs) => { refs = next; };
    }
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    const search = native ? api.registerToolSearch.mock.calls[0][0]
      : api.registerTool.mock.calls.find(([tool]: any[]) => tool.name === "mcp_search")![0];
    const gateway = api.registerTool.mock.calls.find(([tool]: any[]) => tool.name === "mcp")![0];
    const active = () => native ? api.getActiveToolReferences() : api.getActiveTools().map((name: string) => ({ name }));
    const beta = native ? { namespace: "mcp_demo", name: "beta" } : { name: "demo_beta" };
    const params = { query: "records", server: "demo", limit: 1 };
    const page = await search.execute("page-1", params, undefined, undefined, {});
    expect(active()).not.toContainEqual(beta);
    // Dispatch the operation printed in the result, rather than constructing page two ourselves.
    const follow = (result: any) => {
      const text = result.content.map((item: any) => item.text ?? "").join("\n");
      const call = text.match(/(mcp_search|mcp)\((\{[^\n]+\})\)/)!;
      expect(call).not.toBeNull();
      const args = JSON.parse(call[2].replace(/(\w+):/g, '"$1":'));
      return (call[1] === "mcp_search" ? search : gateway).execute("follow", args, undefined, undefined, {});
    };
    const before = active();
    const metadataPage = await gateway.execute("metadata-page", { action: "search", ...params }, undefined, undefined, {});
    expect(metadataPage.content[0].text).toContain('mcp({ action: "search"');
    await follow(metadataPage);
    expect(active()).toEqual(before);
    expect(active()).not.toContainEqual(beta);
    const next = await follow(page);
    expect(next.tools).toEqual([beta]);
    expect(active()).toContainEqual(beta);
    expect(next.details.matches).toMatchObject([{ tool: "demo_beta" }]);
    expect(next.details.query).toBe(params.query);
    const retry = await search.execute("out-of-range", { ...params, offset: 99 }, undefined, undefined, {});
    expect((await follow(retry)).details.matches).toMatchObject([{ tool: "demo_alpha" }]);
    expect(mocks.executeConnect).not.toHaveBeenCalled();
  });

  it("advertises object args and explicit actions while preparing legacy JSON strings", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    const argsSchema = proxyTool.parameters.properties.args;
    expect(argsSchema).toMatchObject({ type: "object", additionalProperties: true });
    expect(proxyTool.parameters.required).toContain("action");
    expect(proxyTool.prepareArguments({ tool: "demo_search", args: '{"q":"hello"}' })).toEqual({ action: "call", tool: "demo_search", args: { q: "hello" } });
    expect(JSON.stringify(argsSchema)).not.toContain("patternProperties");
  });

  it("forwards native object proxy args into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
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
    mocks.executeList.mockReturnValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    await proxyTool.execute("call-1", { server: "demo", limit: 5, offset: 10 });

    expect(mocks.executeList).toHaveBeenCalledWith(state, "demo", 5, 10);
  });

  it("routes manual auth actions through the proxy tool", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeAuthStart.mockResolvedValue({ content: [{ type: "text", text: "auth url" }] });
    mocks.executeAuthComplete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
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
      expect(mocks.executeAuthComplete).toHaveBeenLastCalledWith(state, "demo", typeof args === "object" && Object.keys(args).length ? "raw-code" : undefined, undefined);
    }
    const calls = mocks.executeAuthComplete.mock.calls.length;
    for (const args of [{ code: "" }, { redirectUrl: 42 }, { input: "  " }]) {
      await expect(proxyTool.execute("call-5", { action: "auth-complete", server: "demo", args })).rejects.toThrow("non-empty");
    }
    expect(mocks.executeAuthComplete).toHaveBeenCalledTimes(calls);
  });

  it("forwards the proxy tool AbortSignal into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
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

    const { api, handlers } = createPi();
    adapterModule.default(api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_start")?.({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(
      undefined,
      process.cwd(),
      { includeProject: true },
    );
  });

  it("uses only the supplied config after session startup", async () => {
    const config = { mcpServers: { memory: { url: "https://memory.example.com/mcp", directTools: true } }, settings: { disableProxyTool: true } };
    const state = createState();
    state.config = structuredClone(config);
    state.toolMetadata.set("memory", [{ name: "memory_search", originalName: "search", description: "Search" }]);
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config })(api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "memory_search" }));
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "memory_search" }));
    expect(api.getActiveTools()).not.toContain("mcp");
    expect(mocks.initializeMcp).toHaveBeenCalledWith(api, expect.any(Object), expect.any(Object), expect.objectContaining({ config: expect.objectContaining({ mcpServers: config.mcpServers }) }));
    expect(mocks.initializeMcp.mock.calls[0]![3].config).not.toBe(config);
  });

  it.each([false, true])("transforms each session's resolved config before registration and initialization (snapshot=%s)", async (snapshot) => {
    const source: McpConfig = {
      mcpServers: { docs: { command: "docs-server", env: { ORIGINAL: "yes" } } },
      settings: { autoAuth: true, scriptMode: true },
    };
    const original = structuredClone(source);
    const sharedSettings = { autoAuth: false, scriptMode: false };
    const inputs: McpConfig[] = [];
    const states: ReturnType<typeof createState>[] = [];
    const transformConfig = vi.fn((config: McpConfig, ctx: ExtensionContext): McpConfig => {
      inputs.push(structuredClone(config));
      // Hosts may modify their input clone and return objects shared with their own config.
      config.mcpServers.docs!.env!.ORIGINAL = "transformed";
      return {
        ...config,
        settings: sharedSettings,
        mcpServers: {
          ...config.mcpServers,
          ephemeral: { command: "session-server", lifecycle: "lazy", env: { SESSION: ctx.sessionManager.getSessionId() } },
        },
      };
    });
    mocks.loadMcpConfig.mockReturnValue(source);
    const { buildProxyDescription } = await vi.importActual<typeof import("../direct-tools.ts")>("../direct-tools.ts");
    mocks.buildProxyDescription.mockImplementation(buildProxyDescription);
    mocks.initializeMcp.mockImplementation(async (pi, _ctx, _owner, options) => {
      const tools = pi.registerTool.mock.calls.map(([tool]: any[]) => tool);
      expect(tools.map((tool: any) => tool.name)).toEqual(["mcp_search", "mcp"]);
      expect(tools.find((tool: any) => tool.name === "mcp").description).toContain("ephemeral");
      const state = createState();
      state.config = options.config ?? options.resolvedConfig;
      states.push(state);
      return state;
    });

    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ ...(snapshot ? { config: source } : {}), transformConfig })(api);
    expect(api.registerTool.mock.calls.map(([tool]: any[]) => tool.name)).toEqual(["mcp_search"]);
    expect(transformConfig).not.toHaveBeenCalled();

    for (const [index, reason] of ["startup", "reload", "new"].entries()) {
      const sessionManager = { getSessionId: () => `session-${index}`, getBranch: () => [] };
      await handlers.get("session_start")?.({ reason }, { sessionManager });
      await Promise.resolve();
      const options = mocks.initializeMcp.mock.calls[index]![3];
      const runtimeConfig = snapshot ? options.config : options.resolvedConfig;
      expect(options).not.toHaveProperty(snapshot ? "resolvedConfig" : "config");
      expect(runtimeConfig).toEqual({
        mcpServers: {
          docs: { command: "docs-server", env: { ORIGINAL: "transformed" } },
          ephemeral: { command: "session-server", lifecycle: "lazy", env: { SESSION: `session-${index}` } },
        },
        settings: { autoAuth: false, scriptMode: false },
      });
      expect(transformConfig.mock.calls[index]![1]).toBe(mocks.initializeMcp.mock.calls[index]![1]);
      expect(transformConfig.mock.calls[index]![1].sessionManager).toBe(sessionManager);
      expect(mocks.buildProxyDescription.mock.calls.some(([config]) => config === runtimeConfig)).toBe(true);
      const proxy = api.registerTool.mock.calls.filter(([tool]: any[]) => tool.name === "mcp").at(-1)![0];
      expect(proxy.description).toContain("ephemeral");
      expect(proxy.description).toContain("docs");
      expect(api.registerTool.mock.calls.map(([tool]: any[]) => tool.name)).toEqual(["mcp_search", "mcp"]);
      expect(transformConfig).toHaveBeenCalledTimes(index + 1);

      // Runtime edits must not leak into a retained hook result or the next session.
      states[index].config.settings.scriptMode = true;
      states[index].config.mcpServers.ephemeral.env.SESSION = "runtime-edit";
      expect(transformConfig.mock.results[index]!.value.settings.scriptMode).toBe(false);
      expect(transformConfig.mock.results[index]!.value.mcpServers.ephemeral.env.SESSION).toBe(`session-${index}`);
    }
    expect(inputs).toEqual([original, original, original]);
    expect(source).toEqual(original);
    expect(sharedSettings).toEqual({ autoAuth: false, scriptMode: false });
    if (snapshot) expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.();
  });

  it("keeps ambient trust resolution and configuration panels when transforming config", async () => {
    const globalConfig: McpConfig = { mcpServers: { global: { command: "global-server" } } };
    const trustedConfig: McpConfig = {
      mcpServers: { ...globalConfig.mcpServers, project: { command: "project-server" } },
    };
    mocks.loadMcpConfig.mockImplementation((_path, _cwd, options) => options.includeProject ? trustedConfig : globalConfig);
    mocks.writeProjectServerDisabledOverride.mockReturnValue({ path: "/project/.pi/fitch-mcp-adapter/mcp.json", changed: true });
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => ({
      ...createState(), config: options.resolvedConfig,
    }));
    const transformConfig = vi.fn((config: McpConfig) => config);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ configPath: "/host/mcp.json", transformConfig })(api);
    const command = api.registerCommand.mock.calls.find(([name]: any[]) => name === "mcp")![1];
    const auth = api.registerCommand.mock.calls.find(([name]: any[]) => name === "mcp-auth")![1];
    const ctx = { cwd: "/project", hasUI: true, ui: { notify: vi.fn() }, isProjectTrusted: () => false };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await command.handler("disable global", ctx);
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(transformConfig.mock.calls[0]![0]).toEqual(globalConfig);
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/host/mcp.json", "/project", { includeProject: false });

    ctx.isProjectTrusted = () => true;
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    expect(transformConfig.mock.calls[1]![0]).toEqual(trustedConfig);
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith("/host/mcp.json", "/project", { includeProject: true });
    await command.handler("status", ctx);
    await command.handler("setup", ctx);
    await command.handler("disable project", ctx);
    await auth.handler("", ctx);
    expect(mocks.openMcpPanel).toHaveBeenCalledWith(expect.any(Object), api, expect.any(Object), "/host/mcp.json", expect.any(Function));
    expect(mocks.openMcpSetup).toHaveBeenCalledWith(expect.any(Object), api, expect.any(Object), "/host/mcp.json", "setup");
    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), "/host/mcp.json");
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith("/host/mcp.json", "/project", "project", true);
    await handlers.get("session_shutdown")?.();
  });

  it("keeps only the three gateway tools with MCP_DIRECT_TOOLS=__none__ through metadata updates", async () => {
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
    for (const server of ["demo", "other"]) state.toolMetadata.set(server, [{ name: `${server}_search`, originalName: "search", description: "Search" }]);
    mocks.executeConnect.mockImplementation(async (currentState, server) => {
      currentState.onToolMetadataUpdated(server, "lazy-connect");
      return { content: [{ type: "text", text: `Connected ${server}` }], details: {} };
    });
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "Search result" }] });
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    api.setActiveTools(["mcp", "mcp_script"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    const proxy = api.registerTool.mock.calls.find(([tool]: any[]) => tool.name === "mcp")![0];
    for (const server of ["demo", "other"]) {
      expect(await proxy.execute(`connect-${server}`, { connect: server })).toEqual({ content: [{ type: "text", text: `Connected ${server}` }], details: {} });
      state.onToolMetadataUpdated(server, "tools-list-changed");
      expect(await proxy.execute(`call-${server}`, { tool: `${server}_search`, server })).toEqual({ content: [{ type: "text", text: "Search result" }] });
      expect(mocks.executeCall).toHaveBeenLastCalledWith(state, `${server}_search`, undefined, server, expect.any(Function), undefined, { toolCallId: `call-${server}` }, undefined);
      expect(api.registerTool.mock.calls.map(([tool]: any[]) => tool.name)).toEqual(["mcp_search", "mcp", "mcp_script"]);
      expect(api.getActiveTools().sort()).toEqual(["mcp", "mcp_script", "mcp_search"]);
    }
    expect(mocks.initializeMcp.mock.calls[0]![3].resolvedConfig).toEqual(config);
    await handlers.get("session_shutdown")?.();
  });

  it("snapshots caller config and isolates separate factories", async () => {
    const firstConfig = { mcpServers: { first: { url: "https://first.example.com/mcp" } } };
    const secondConfig = { mcpServers: { second: { url: "https://second.example.com/mcp" } } };
    const firstAdapter = (await import("../index.ts")).createMcpAdapter({ config: firstConfig });
    const secondAdapter = (await import("../index.ts")).createMcpAdapter({ config: secondConfig });
    firstConfig.mcpServers.first.url = "https://mutated.example.com/mcp";

    const firstPi = createPi();
    const secondPi = createPi();
    firstAdapter(firstPi.api);
    secondAdapter(secondPi.api);

    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => ({ ...createState(), config: options.config }));
    await firstPi.handlers.get("session_start")?.({}, {});
    await secondPi.handlers.get("session_start")?.({}, {});
    expect(mocks.initializeMcp.mock.calls.at(-2)?.[3].config).toEqual({
      mcpServers: { first: { url: "https://first.example.com/mcp" } },
    });
    expect(mocks.initializeMcp.mock.calls.at(-1)?.[3].config).toEqual(secondConfig);
  });

  it("defers explicit config paths until trusted session startup", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter, default: defaultAdapter } = await import("../index.ts");

    const configuredPi = createPi();
    createMcpAdapter({ configPath: "/factory.json" })(configuredPi.api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await configuredPi.handlers.get("session_start")?.({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(
      "/factory.json",
      process.cwd(),
      { includeProject: true },
    );

    mocks.loadMcpConfig.mockClear();
    const defaultPi = createPi();
    defaultPi.api.getFlag.mockReturnValue("/flag.json");
    defaultAdapter(defaultPi.api);
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await defaultPi.handlers.get("session_start")?.({}, {});
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(
      "/flag.json",
      process.cwd(),
      { includeProject: true },
    );
  });

  it("resolves SDK flag config paths against the trusted session cwd", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    api.getFlag.mockReturnValue("/sdk/mcp.json");
    mcpAdapter(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_start")?.({}, {
      cwd: "/actual/project",
      isProjectTrusted: () => false,
    });

    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(
      "/sdk/mcp.json",
      "/actual/project",
      { includeProject: false },
    );
  });

  it("uses status notifications instead of ambient panels in memory-config mode", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config: { mcpServers: { memory: { url: "https://memory.example.com/mcp" } } } })(api);
    const ui = { notify: vi.fn() };
    await handlers.get("session_start")?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui });
    await commandDef.handler("disable memory", { hasUI: true, ui });
    await commandDef.handler("status", { hasUI: true, ui });
    const authDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await authDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpSetup).not.toHaveBeenCalled();
    expect(mocks.openMcpPanel).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("in-memory"), "info");
  });

  it("starts a replacement init immediately and shuts down stale init results", async () => {
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).not.toHaveBeenCalled();
    const firstRuntime = mocks.createOAuthRuntime.mock.results[0]!.value;

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(firstRuntime);

    const activeState = createState();
    second.resolve(activeState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
    expect(activeState.lifecycle.gracefulShutdown).not.toHaveBeenCalled();

    const staleState = createState();
    first.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("defers project config reads and server startup until session trust is known", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    api.getFlag.mockReturnValue("/project/.pi/mcp.json");
    mcpAdapter(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(mocks.initializeMcp).not.toHaveBeenCalled();

    await handlers.get("session_start")?.({}, { isProjectTrusted: () => false });
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith(
      "/project/.pi/mcp.json",
      process.cwd(),
      { includeProject: false },
    );
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    await handlers.get("session_start")?.({}, { isProjectTrusted: () => true });
    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith(
      "/project/.pi/mcp.json",
      process.cwd(),
      { includeProject: true },
    );
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
  });

  it("bounds the proxy tool wait when session initialization stalls", async () => {
    const never = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(never.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
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
    const cleanup = createDeferred<void>();
    state.lifecycle.gracefulShutdown.mockReturnValue(cleanup.promise);
    state.uiServer = { close: vi.fn(() => { throw new Error("UI cleanup failed"); }) };
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: adapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    adapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    mocks.flushMetadataCache.mockImplementation(() => { throw new Error("metadata persistence failed"); });
    mocks.shutdownOAuth.mockRejectedValue(new Error("OAuth cleanup failed"));
    const done = vi.fn();
    const stopping = Promise.resolve(handlers.get("session_shutdown")?.());
    const observed = stopping.then(done, error => { done(); return error; });
    await Promise.resolve();
    expect(state.uiServer).toBeNull();
    expect(state.lifecycle.gracefulShutdown).toHaveBeenCalledOnce();
    expect(mocks.shutdownOAuth).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    cleanup.resolve();
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain("persistence/cleanup failed");
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0].errors.map((cause: Error) => cause.message)).toEqual(["UI cleanup failed", "metadata persistence failed"]);
  });

  it("shuts down OAuth on session_shutdown", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");

    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    mocks.shutdownOAuth.mockClear();

    await sessionShutdown?.();

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
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    expect(commandDef.getArgumentCompletions("reconnect ")).toBeNull();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(commandDef.getArgumentCompletions("").map(({ value }: { value: string }) => value)).toEqual([
      "reconnect",
      "tools",
      "prompts",
      "setup",
      "logout",
      "disable",
      "enable",
      "status",
    ]);
    expect(commandDef.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status — Show server status" },
    ]);
    expect(commandDef.getArgumentCompletions("reconnect ")).toEqual([
      { value: "reconnect github", label: "github" },
      { value: "reconnect gitlab", label: "gitlab" },
      { value: "reconnect notion", label: "notion" },
    ]);
    expect(commandDef.getArgumentCompletions("  logout git")).toEqual([
      { value: "logout github", label: "github" },
      { value: "logout gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("disable git")).toEqual([
      { value: "disable github", label: "github" },
      { value: "disable gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("enable not")).toEqual([
      { value: "enable notion", label: "notion" },
    ]);
    expect(commandDef.getArgumentCompletions("tools anything")).toBeNull();
    expect(api.registerCommand.mock.calls.some((call: any[]) => call[0] === "mcp-reconnect")).toBe(false);
  });

  it("hot-registers prompt commands after live prompt metadata refresh", async () => {
    const state = createState();
    state.promptMetadata = new Map();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    api.registerCommand.mockClear();
    state.promptMetadata.set("demo", [{
      serverName: "demo",
      originalName: "brief",
      commandName: "mcp__demo__brief",
      description: "Brief",
      arguments: [],
    }]);
    state.onToolMetadataUpdated?.("demo", "prompts-list-changed");

    expect(api.registerCommand).toHaveBeenCalledWith("mcp__demo__brief", expect.objectContaining({
      description: expect.stringContaining("Brief"),
      handler: expect.any(Function),
    }));
  });

  it("routes `/mcp setup` to the onboarding flow", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    expect(commandDef).toBeDefined();

    await commandDef.handler("setup", { hasUI: true, ui: { notify: vi.fn() } });

    expect(mocks.openMcpSetup).toHaveBeenCalledWith(state, api, expect.any(Object), undefined, "setup");
  });

  it("routes `/mcp logout <server>` to credential logout", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout oauth-server", { hasUI: true, ui });

    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, expect.any(Object));
  });

  it("writes project-local disabled overrides and rejects unknown servers", async () => {
    const state = createState();
    state.config.mcpServers = { global: { url: "https://example.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: true, cwd: "/tmp/project", ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const ui = { notify: vi.fn() };
    await commandDef.handler("disable global", { hasUI: true, cwd: "/tmp/project", ui });
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith(undefined, "/tmp/project", "global", true);
    await commandDef.handler("disable missing", { hasUI: true, cwd: "/tmp/project", ui });
    expect(ui.notify).toHaveBeenCalledWith("Server \"missing\" not found in effective config", "error");
  });

  it("shows usage for `/mcp logout` without a server", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout", { hasUI: true, ui });

    expect(mocks.logoutServer).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /mcp logout <server>", "error");
  });

  it("triggers core reload after setup changes config", async () => {
    const initialState = createState();
    mocks.initializeMcp.mockResolvedValue(initialState);
    mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const reload = vi.fn().mockResolvedValue(undefined);
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui, reload });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.flushMetadataCache).not.toHaveBeenCalledWith(initialState);
  });

  it("opens the auth picker for `/mcp-auth` without args in UI sessions", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(state, expect.any(Object), undefined);
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("reconnects after explicit `/mcp-auth <server>` succeeds", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).toHaveBeenCalledWith(state, expect.any(Object), "github", true);
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("does not reconnect after explicit `/mcp-auth <server>` fails", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: false });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("documents that no-arg `/mcp-auth` has no non-UI picker or command feedback path", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: false });

    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("stops the runtime when initialization rejects before publishing state", async () => {
    mocks.initializeMcp.mockRejectedValue(new Error("init boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      await handlers.get("session_start")?.({}, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(mocks.createOAuthRuntime.mock.results[0]!.value.signal.aborted).toBe(true);
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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeTypeOf("function");

      await sessionStart?.({}, {});
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(consoleError).toHaveBeenCalledWith("MCP initialization failed: status boom");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("registers a tool_result handler that re-flags returned MCP tool failures (and leaves other results alone)", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const toolResult = handlers.get("tool_result");
    expect(toolResult).toBeDefined();

    // server returned an error result (direct path) -> tagged tool_error
    expect(toolResult?.({ details: { error: "tool_error", server: "demo" } })).toEqual({ isError: true });
    // the call itself threw and was caught (proxy path) -> tagged call_failed
    expect(toolResult?.({ details: { mode: "call", error: "call_failed", message: "boom" } })).toEqual({ isError: true });
    // a precondition code is not a tool-execution failure -> left untouched
    expect(toolResult?.({ details: { error: "auth_required", server: "demo" } })).toBeUndefined();
  });
});
