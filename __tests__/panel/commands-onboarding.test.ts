import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import type * as PanelModule from "../../mcp-panel.ts";
import type * as SetupModule from "../../mcp-setup-panel.ts";
import type { McpPanelResult } from "../../types.ts";
import type { createTestState } from "../test-state.ts";
import { createPanelHost } from "../fixtures/panel-host.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const mocks = vi.hoisted(() => ({
  createMcpPanel: vi.fn<typeof PanelModule.createMcpPanel>(),
  createMcpSetupPanel: vi.fn<typeof SetupModule.createMcpSetupPanel>(),
}));

vi.mock(import("../../mcp-panel.ts"), async (importOriginal) => {
  const panels = await importOriginal();
  return {
    ...panels,
    createMcpPanel: mocks.createMcpPanel.mockImplementation((...args) => {
      const panel = panels.createMcpPanel(...args);
      panel.dispose();
      args[5](panelResult);
      return panel;
    }),
  };
});
vi.mock(import("../../mcp-setup-panel.ts"), async (importOriginal) => {
  const setup = await importOriginal();
  return {
    ...setup,
    createMcpSetupPanel: mocks.createMcpSetupPanel.mockImplementation((...args) => {
      const panel = setup.createMcpSetupPanel(...args);
      panel.dispose();
      args[4]();
      return panel;
    }),
  };
});

const directories: string[] = [];
const states: ReturnType<typeof createTestState>[] = [];
let host: Awaited<ReturnType<typeof createPanelHost>>;
let panelResult: McpPanelResult;
const originalCwd = process.cwd();

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function createState(overrides: Parameters<typeof createTestState>[0] = {}) {
  const { createTestState: createCurrentState } = await import("../test-state.ts");
  const state = createCurrentState(overrides);
  states.push(state);
  return state;
}

beforeAll(() => initTheme());
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  host = await createPanelHost();
  panelResult = { cancelled: true, changes: new Map() };
  mocks.createMcpPanel.mockClear();
  mocks.createMcpSetupPanel.mockClear();
});
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.owner.stop();
  }
  await host.dispose();
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("commands onboarding", () => {
  it("opens setup mode when no MCP servers are configured", async () => {
    vi.stubEnv("HOME", temporaryDirectory("pi-mcp-commands-home-"));
    const { openMcpPanel } = await import("../../commands.ts");
    await openMcpPanel(await createState(), host.api, { ...host.context, cwd: process.cwd() });
    expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
    expect(mocks.createMcpPanel).not.toHaveBeenCalled();
  });

  it("does not open custom panels outside TUI mode", async () => {
    const custom = vi.spyOn(host.context.ui, "custom");
    const { openMcpAuthPanel, openMcpPanel, openMcpSetup } = await import("../../commands.ts");
    const state = await createState();
    const ctx = { ...host.context, cwd: process.cwd(), mode: "rpc" as const };
    await openMcpSetup(state, host.api, ctx);
    await openMcpPanel(state, host.api, ctx);
    await openMcpAuthPanel(state, ctx);
    expect(custom).not.toHaveBeenCalled();
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("TUI mode"),
      "info",
    );
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP Server Status"),
      "info",
    );
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/mcp-auth <server>"),
      "info",
    );
  });

  it("uses the resolved config override without re-reading Pi flags", async () => {
    vi.stubEnv("HOME", temporaryDirectory("pi-mcp-commands-home-"));
    const getFlag = vi.spyOn(host.api, "getFlag").mockReturnValue("/flag/mcp.json");
    const state = await createState({
      config: { mcpServers: { oauth: { url: "https://example.com/mcp", auth: "oauth" } } },
    });
    const ctx = { ...host.context, cwd: "/project" };
    const { openMcpAuthPanel, openMcpPanel } = await import("../../commands.ts");
    await openMcpPanel(state, host.api, ctx, "/factory/mcp.json");
    await openMcpAuthPanel(state, ctx, "/factory/mcp.json");
    expect(getFlag).not.toHaveBeenCalled();
    expect(mocks.createMcpPanel).toHaveBeenCalledTimes(2);
  });

  it("shows a one-time shared-config notice in the MCP panel", async () => {
    const home = temporaryDirectory("pi-mcp-commands-home-");
    const project = temporaryDirectory("pi-mcp-commands-project-");
    vi.stubEnv("HOME", home);
    process.chdir(project);
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { sharedServer: { command: "shared" } },
    });
    const { loadMcpConfig } = await import("../../config.ts");
    const { openMcpPanel } = await import("../../commands.ts");
    const { loadOnboardingState } = await import("../../onboarding-state.ts");
    await openMcpPanel(await createState({ config: loadMcpConfig() }), host.api, {
      ...host.context,
      cwd: project,
    });
    expect(mocks.createMcpPanel).toHaveBeenCalled();
    const options = requireValue(mocks.createMcpPanel.mock.calls[0])[6];
    expect(options?.noticeLines?.[0]).toContain("Using standard MCP config");
    expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
  });

  it.each([
    ["shared global", ".config/mcp/mcp.json"],
    ["agents global", ".agents/mcp.json"],
    ["agents nested global", ".agents/mcp/mcp.json"],
    ["explicit import", ".cursor/mcp.json"],
    ["auto import", ".cursor/mcp.json"],
  ])(
    "saves directTools without copying inherited definitions from %s",
    async (kind, sourceFile) => {
      const home = temporaryDirectory("pi-mcp-save-home-");
      const project = temporaryDirectory("pi-mcp-save-project-");
      vi.stubEnv("HOME", home);
      process.chdir(project);
      const sourcePath = join(home, sourceFile);
      const piPath = join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json");
      const projectPath = join(project, ".mcp.json");
      const projectPiPath = join(project, ".pi", "fitch-mcp-adapter", "mcp.json");
      const source = {
        mcpServers: {
          inherited: {
            url: "https://internal.example/mcp",
            headers: { Authorization: "Bearer source-secret" },
          },
          customized: { command: "source-command", env: { TOKEN: "source-token" } },
        },
      };
      const destination = {
        imports: kind === "explicit import" ? ["cursor"] : [],
        settings: {
          hostConfigDiscovery: kind === "auto import" ? "on" : "off",
          showStatusIcon: false,
        },
        mcpServers: {
          customized: { excludeTools: ["admin"] },
          piOwned: { command: "pi-command" },
        },
      };
      writeJson(sourcePath, source);
      writeJson(piPath, destination);
      writeJson(projectPath, { mcpServers: { projectOwned: { command: "project-command" } } });
      writeJson(projectPiPath, {
        mcpServers: { projectPiOwned: { command: "project-pi-command" } },
      });
      const sourceText = readFileSync(sourcePath, "utf-8");
      const { loadMcpConfig } = await import("../../config.ts");
      const { openMcpPanel } = await import("../../commands.ts");
      const refreshed = vi.fn<NonNullable<Parameters<typeof openMcpPanel>[4]>>();
      const changes: McpPanelResult["changes"] = new Map<string, boolean | string[]>([
        ["inherited", true],
        ["customized", false],
        ["piOwned", false],
        ["projectOwned", ["search"]],
        ["projectPiOwned", true],
      ]);
      panelResult = { cancelled: false, changes };
      const save = async () =>
        openMcpPanel(
          await createState({ config: loadMcpConfig() }),
          host.api,
          { ...host.context, cwd: project },
          undefined,
          refreshed,
        );
      await expect(save()).resolves.toEqual({ configChanged: false });
      expect(readJson(piPath)).toEqual({
        ...destination,
        mcpServers: {
          inherited: { directTools: true },
          customized: { excludeTools: ["admin"], directTools: false },
          piOwned: { command: "pi-command", directTools: false },
        },
      });
      expect(readJson(projectPath)).toEqual({
        mcpServers: { projectOwned: { command: "project-command", directTools: ["search"] } },
      });
      expect(readJson(projectPiPath)).toEqual({
        mcpServers: { projectPiOwned: { command: "project-pi-command", directTools: true } },
      });
      expect(readFileSync(sourcePath, "utf-8")).toBe(sourceText);
      expect(refreshed).toHaveBeenCalledWith(changes);
      expect(host.context.ui.notify).toHaveBeenCalledWith(
        "Direct tools updated for this session.",
        "info",
      );
      expect(loadMcpConfig().mcpServers.inherited).toEqual({
        ...source.mcpServers.inherited,
        directTools: true,
      });
      source.mcpServers.inherited = {
        url: "https://updated.example/mcp",
        headers: { Authorization: "Bearer updated-secret" },
      };
      source.mcpServers.customized = {
        command: "updated-command",
        env: { TOKEN: "updated-token" },
      };
      writeJson(sourcePath, source);
      const updatedSourceText = readFileSync(sourcePath, "utf-8");
      changes.clear();
      for (const selection of [false, ["search"]] as const) {
        changes.set("inherited", selection === false ? false : [...selection]);
        await expect(save()).resolves.toEqual({ configChanged: false });
        expect(readJson(piPath)).toHaveProperty("mcpServers.inherited", { directTools: selection });
        expect(loadMcpConfig().mcpServers.inherited).toEqual({
          ...source.mcpServers.inherited,
          directTools: selection,
        });
      }
      expect(loadMcpConfig().mcpServers.customized).toEqual({
        ...source.mcpServers.customized,
        excludeTools: ["admin"],
        directTools: false,
      });
      expect(readFileSync(sourcePath, "utf-8")).toBe(updatedSourceText);
    },
  );

  it("keeps the native panel open until live pin refresh finishes", async () => {
    const home = temporaryDirectory("pi-mcp-refresh-home-");
    const project = temporaryDirectory("pi-mcp-refresh-project-");
    vi.stubEnv("HOME", home);
    const projectConfig = join(project, ".mcp.json");
    writeJson(projectConfig, { mcpServers: { demo: { command: "node" } } });
    const { loadMcpConfig } = await import("../../config.ts");
    const { openMcpPanel } = await import("../../commands.ts");
    const state = await createState({ config: loadMcpConfig(undefined, project) });
    const started = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const events: string[] = [];
    const nativeCustom = host.context.ui.custom.bind(host.context.ui);
    function observeCompletion<T>(
      factory: Parameters<typeof host.context.ui.custom<T>>[0],
    ): Promise<T> {
      return nativeCustom<T>((tui, theme, keybindings, done) =>
        factory(tui, theme, keybindings, (result) => {
          events.push("closed");
          done(result);
        }),
      );
    }
    vi.spyOn(host.context.ui, "custom").mockImplementation(observeCompletion);
    panelResult = { cancelled: false, changes: new Map([["demo", true]]) };
    const opening = openMcpPanel(
      state,
      host.api,
      { ...host.context, cwd: project },
      undefined,
      async () => {
        events.push("refresh");
        started.resolve(null);
        await release.promise;
      },
    );
    try {
      await started.promise;
      expect(readJson(projectConfig)).toEqual({
        mcpServers: { demo: { command: "node", directTools: true } },
      });
      expect(events).toEqual(["refresh"]);
    } finally {
      release.resolve(null);
      await opening;
    }
    expect(events).toEqual(["refresh", "closed"]);
  });

  it("clears OAuth credentials, cancels pending auth, and closes the server on logout", async () => {
    vi.stubEnv("FITCH_MCP_OAUTH_DIR", temporaryDirectory("pi-mcp-commands-logout-"));
    const { getAuthEntry, saveAuthEntry } = await import("../../mcp-auth.ts");
    const { waitForCallback } = await import("../../mcp-callback-server.ts");
    const { logoutServer } = await import("../../commands.ts");
    saveAuthEntry(
      "oauth-server",
      { tokens: { accessToken: "token", refreshToken: "refresh" }, oauthState: "pending-state" },
      "https://example.com/mcp",
    );
    const pendingCallback = waitForCallback("pending-state");
    const state = await createState({
      config: { mcpServers: { "oauth-server": { url: "https://example.com/mcp", auth: "oauth" } } },
    });
    const close = vi.spyOn(state.manager, "close");
    const [, result] = await Promise.all([
      expect(pendingCallback).rejects.toThrow("Authorization cancelled"),
      logoutServer("oauth-server", state, { ...host.context, cwd: process.cwd() }),
    ]);
    expect(result.ok).toBe(true);
    expect(getAuthEntry("oauth-server")).toBeUndefined();
    expect(close).toHaveBeenCalledWith("oauth-server");
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("OAuth credentials cleared"),
      "info",
    );
  });

  it("marks explicit OAuth servers as needs-auth when only stale URL tokens exist", async () => {
    vi.stubEnv("FITCH_MCP_OAUTH_DIR", temporaryDirectory("pi-mcp-commands-oauth-"));
    const { updateTokens } = await import("../../mcp-auth.ts");
    const { openMcpPanel } = await import("../../commands.ts");
    updateTokens("legacy", { accessToken: "legacy-token" });
    updateTokens("stale", { accessToken: "stale-token" }, "https://old.example.com/mcp");
    await openMcpPanel(
      await createState({
        config: {
          mcpServers: {
            legacy: { url: "https://new.example.com/mcp", auth: "oauth" },
            stale: { url: "https://new.example.com/mcp", auth: "oauth" },
          },
        },
      }),
      host.api,
      { ...host.context, cwd: process.cwd() },
    );
    const callbacks = requireValue(mocks.createMcpPanel.mock.calls[0])[3];
    expect(callbacks.getConnectionStatus("legacy")).toBe("needs-auth");
    expect(callbacks.getConnectionStatus("stale")).toBe("needs-auth");
  });

  it("panel reconnect force-clears stale needs-auth state", async () => {
    vi.stubEnv("HOME", temporaryDirectory("pi-mcp-commands-reconnect-"));
    const { updateTokens } = await import("../../mcp-auth.ts");
    updateTokens("notion", { accessToken: "token" }, "https://mcp.notion.com/mcp");
    const definition = { url: "https://mcp.notion.com/mcp", auth: "oauth" } as const;
    const client = new Client({ name: "panel-test", version: "1" });
    let currentConnection: ServerConnection | undefined = {
      client,
      transport: new InMemoryTransport(),
      definition,
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: 0,
      inFlight: 0,
      status: "needs-auth",
    };
    const manager = new McpServerManager();
    const close = vi.spyOn(manager, "close").mockImplementation(async () => {
      currentConnection = undefined;
    });
    const connect = vi.spyOn(manager, "connect").mockImplementation(async () => {
      currentConnection = {
        client,
        transport: new InMemoryTransport(),
        definition,
        status: "connected",
        tools: [{ name: "search", description: "Search" }],
        resources: [],
        prompts: [],
        lastUsedAt: 0,
        inFlight: 0,
      };
      return currentConnection;
    });
    vi.spyOn(manager, "getConnection").mockImplementation(() => currentConnection);
    vi.spyOn(manager, "getAllConnections").mockImplementation(
      () =>
        new Map(currentConnection?.status === "connected" ? [["notion", currentConnection]] : []),
    );
    const state = await createState({
      config: { mcpServers: { notion: definition } },
      manager,
      failureTracker: new Map([["notion", Date.now()]]),
    });
    const { openMcpPanel } = await import("../../commands.ts");
    await openMcpPanel(state, host.api, { ...host.context, cwd: process.cwd() });
    const callbacks = requireValue(mocks.createMcpPanel.mock.calls[0])[3];
    await expect(callbacks.reconnect("notion")).resolves.toBe(true);
    expect(close).toHaveBeenCalledWith("notion");
    const signal: unknown = expect.any(AbortSignal);
    expect(connect).toHaveBeenCalledWith("notion", state.config.mcpServers.notion, signal);
    expect(state.failureTracker.has("notion")).toBe(false);
    expect(state.toolMetadata.get("notion")?.[0]?.name).toBe("notion_search");
    expect(callbacks.getConnectionStatus("notion")).toBe("connected");
  });
});
