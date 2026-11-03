import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type * as Config from "../../config.ts";
import type * as Metadata from "../../metadata-cache.ts";
import type * as ToolMetadata from "../../tool-metadata.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import type { McpExtensionState } from "../../state.ts";
import type { McpConfig } from "../../types.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";

const mocks = vi.hoisted(() => {
  const state: { cache: Metadata.MetadataCache | null; config: McpConfig } = {
    cache: null,
    config: { settings: {}, mcpServers: {} },
  };
  return {
    state,
    cachePath: "",
    getMissingConfiguredDirectToolServers: vi.fn<
      typeof Metadata.getMissingConfiguredDirectToolServers
    >(() => []),
    buildToolMetadata: vi.fn<typeof ToolMetadata.buildToolMetadata>(() => ({
      metadata: [],
      failedTools: [],
    })),
  };
});

vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Config>()),
  loadMcpConfig: vi.fn<typeof Config.loadMcpConfig>(() => mocks.state.config),
}));

vi.mock("../../metadata-cache.ts", () => ({
  computeServerHash: vi.fn<typeof Metadata.computeServerHash>(() => "hash"),
  getMetadataCachePath: vi.fn<typeof Metadata.getMetadataCachePath>(() => mocks.cachePath),
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  isServerCacheValid: vi.fn<typeof Metadata.isServerCacheValid>(() => false),
  loadMetadataCache: vi.fn<typeof Metadata.loadMetadataCache>(() => mocks.state.cache),
  reconstructToolMetadata: vi.fn<typeof Metadata.reconstructToolMetadata>(() => []),
  reconstructPromptMetadata: vi.fn<typeof Metadata.reconstructPromptMetadata>(() => []),
  saveMetadataCache: vi.fn<typeof Metadata.saveMetadataCache>((cache) => {
    mocks.state.cache = cache;
  }),
  serializeResources: vi.fn<typeof Metadata.serializeResources>(() => []),
  serializeTools: vi.fn<typeof Metadata.serializeTools>(() => []),
  serializePrompts: vi.fn<typeof Metadata.serializePrompts>(() => []),
}));

vi.mock("../../tool-metadata.ts", () => ({
  buildToolMetadata: mocks.buildToolMetadata,
  totalToolCount: vi.fn<typeof ToolMetadata.totalToolCount>(() => 0),
}));

vi.mock("../../direct-tools.ts", () => ({
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
}));

describe("lazy-keep-alive initializeMcp integration", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const states: McpExtensionState[] = [];
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  let tempDir: string;
  let current: ServerConnection | undefined;
  let connect: MockInstance<McpServerManager["connect"]>;

  async function initialize(context: Partial<ExtensionContext> = {}) {
    const { initializeMcp } = await import("../../init.ts");
    const state = await initializeMcp(host.api, {
      ...host.context,
      cwd: tempDir,
      ...context,
    });
    states.push(state);
    return state;
  }

  beforeAll(async () => {
    initTheme();
    host = await createTestExtensionContext();
  });

  afterAll(async () => {
    await host.dispose();
  });

  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-lifecycle-init-"));
    mocks.cachePath = join(tempDir, "mcp-cache.json");
    mocks.state.cache = { version: 1, servers: {} };
    const definition = {
      command: "demo",
      lifecycle: "lazy-keep-alive",
      directTools: true,
    } satisfies McpConfig["mcpServers"][string];
    mocks.state.config = { settings: {}, mcpServers: { srv: definition } };
    const connection: ServerConnection = {
      client: new Client({ name: "init-test", version: "1" }),
      transport: new InMemoryTransport(),
      definition,
      status: "connected",
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
    };
    current = undefined;
    connect = vi.spyOn(McpServerManager.prototype, "connect").mockImplementation(async () => {
      current = connection;
      return connection;
    });
    vi.spyOn(McpServerManager.prototype, "getConnection").mockImplementation(() => current);
    vi.spyOn(McpServerManager.prototype, "getAllConnections").mockImplementation(() =>
      current ? new Map([["srv", current]]) : new Map<string, ServerConnection>(),
    );
    vi.spyOn(McpServerManager.prototype, "isIdle").mockReturnValue(false);
    mocks.getMissingConfiguredDirectToolServers.mockReset().mockReturnValue([]);
    mocks.buildToolMetadata.mockClear();
  });

  afterEach(async () => {
    for (const state of states.splice(0)) {
      await state.owner.stop();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves uncached lazy servers disconnected until selected", async () => {
    vi.useFakeTimers();
    mocks.state.cache = null;
    const definition = mocks.state.config.mcpServers.srv;
    assert.ok(definition);
    definition.directTools = false;
    const state = await initialize();

    current = undefined;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connect).not.toHaveBeenCalled();
    expect(state.toolMetadata.has("srv")).toBe(false);
  });

  it("records direct-tool bootstrap failures", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.state.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "lazy", directTools: true } },
    };
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    connect.mockRejectedValueOnce(new Error("bootstrap failed"));
    const state = await initialize();

    expect(state.failureTracker.has("srv")).toBe(true);
    expect(state.failureMessages.get("srv")).toBe("bootstrap failed");
  });

  it("clears stale startup diagnostics when direct-tool bootstrap recovers", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.state.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "keep-alive", directTools: true } },
    };
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    connect.mockRejectedValueOnce(new Error("startup failed"));
    const state = await initialize();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.failureTracker.has("srv")).toBe(false);
    expect(state.failureMessages.has("srv")).toBe(false);
  });

  it("sanitizes captured diagnostics in startup notifications and terminal logs", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.state.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    connect.mockRejectedValueOnce(new Error("stderr \x1b]52;c;clipboard-secret\x07startup failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Capture the intentionally unsafe diagnostic without sending it to the terminal.
    });
    const notify = vi.spyOn(host.context.ui, "notify");
    const state = await initialize({ hasUI: true, mode: "tui" });

    expect(state.failureMessages.get("srv")).toContain("clipboard-secret");
    expect(notify).toHaveBeenCalledWith(
      "MCP: Failed to connect to srv: stderr startup failed",
      "error",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "MCP: Failed to connect to srv: stderr startup failed",
    );
  });

  it("honors the status icon opt-out during eager startup", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.state.config = {
      settings: { showStatusIcon: false },
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const setStatus = vi.spyOn(host.context.ui, "setStatus");
    await initialize({ hasUI: true, mode: "tui" });

    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: connecting to 1 servers...");
  });

  it("does not record or notify an aborted eager startup", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.state.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const controller = new AbortController();
    connect.mockImplementationOnce(async () => {
      controller.abort(new Error("startup cancelled"));
      throw new Error("startup cancelled");
    });
    const notify = vi.spyOn(host.context.ui, "notify");
    const state = await initialize({ hasUI: true, mode: "tui", signal: controller.signal });

    expect(state.failureTracker.size).toBe(0);
    expect(state.failureMessages.size).toBe(0);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Failed to connect"), "error");
  });

  it("does not preserve stale cached resources after authoritative list-change removal", async () => {
    const definition = mocks.state.config.mcpServers.srv;
    assert.ok(definition);
    definition.lifecycle = "eager";
    const state = await initialize();
    const { updateMetadataCache } = await import("../../init.ts");
    mocks.state.cache = {
      version: 1,
      servers: {
        srv: {
          configHash: "hash",
          tools: [],
          resources: [{ uri: "ui://old", name: "Old resource" }],
          cachedAt: Date.now(),
        },
      },
    };

    updateMetadataCache(state, "srv");
    expect(mocks.state.cache.servers.srv?.resources).toEqual([
      { uri: "ui://old", name: "Old resource" },
    ]);

    updateMetadataCache(state, "srv", { preserveEmptyResources: false });
    expect(mocks.state.cache.servers.srv?.resources).toEqual([]);
  });

  it("marks direct-tool metadata bootstrap spawns for health-check reconnects", async () => {
    vi.useFakeTimers();
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    await initialize();

    current = undefined;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connect).toHaveBeenCalledTimes(2);
  });
});
