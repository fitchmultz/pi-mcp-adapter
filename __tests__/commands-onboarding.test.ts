import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const mocks = {
  createMcpPanel: vi.fn(),
  createMcpSetupPanel: vi.fn(),
};

vi.mock("../mcp-panel.ts", () => ({
  createMcpPanel: mocks.createMcpPanel,
}));

vi.mock("../mcp-setup-panel.ts", () => ({
  createMcpSetupPanel: mocks.createMcpSetupPanel,
}));

describe("commands onboarding", () => {
  const originalHome = process.env.HOME;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    mocks.createMcpPanel.mockReset().mockImplementation((_config, _cache, _prov, _callbacks, _tui, done) => {
      done({ cancelled: true, changes: new Map() });
      return { dispose() {} };
    });
    mocks.createMcpSetupPanel.mockReset().mockImplementation((_discovery, _callbacks, _options, _tui, done) => {
      done();
      return { dispose() {} };
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
    process.chdir(originalCwd);
  });

  function createUi() {
    return {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((renderer: any) => renderer({ requestRender: vi.fn() }, {}, {}, vi.fn())),
    };
  }

  it("opens setup mode when no MCP servers are configured", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const ui = createUi();
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel({
      config: { mcpServers: {} },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any);

    expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
    expect(mocks.createMcpPanel).not.toHaveBeenCalled();
  });

  it("does not open custom panels outside TUI mode", async () => {
    const ui = createUi();
    const { openMcpAuthPanel, openMcpPanel, openMcpSetup } = await import("../commands.ts");
    const state = {
      config: { mcpServers: {} },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any;
    const ctx = { hasUI: true, mode: "rpc", isProjectTrusted: () => true, ui } as any;

    await openMcpSetup(state, {} as any, ctx);
    await openMcpPanel(state, { getFlag: () => undefined } as any, ctx);
    await openMcpAuthPanel(state, ctx);

    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "info");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("MCP Server Status"), "info");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/mcp-auth <server>"), "info");
  });

  it("uses the resolved config override without re-reading Pi flags", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    process.env.HOME = home;
    const ui = createUi();
    const getFlag = vi.fn(() => "/flag/mcp.json");
    const state = {
      config: { mcpServers: { oauth: { url: "https://example.com/mcp", auth: "oauth" } } },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any;
    const ctx = { hasUI: true, mode: "tui", isProjectTrusted: () => true, cwd: "/project", ui } as any;
    const { openMcpAuthPanel, openMcpPanel } = await import("../commands.ts");

    await openMcpPanel(state, { getFlag } as any, ctx, "/factory/mcp.json");
    await openMcpAuthPanel(state, ctx, "/factory/mcp.json");

    expect(getFlag).not.toHaveBeenCalled();
    expect(mocks.createMcpPanel).toHaveBeenCalledTimes(2);
  });

  it("shows a one-time shared-config notice in the MCP panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-commands-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared" },
      },
    });

    const ui = createUi();
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");

    await openMcpPanel({
      config: loadMcpConfig(),
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any);

    expect(mocks.createMcpPanel).toHaveBeenCalled();
    const options = mocks.createMcpPanel.mock.calls[0]?.[6];
    expect(options.noticeLines[0]).toContain("Using standard MCP config");
    expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
  });

  it.each([
    ["shared global", ".config/mcp/mcp.json"],
    ["agents global", ".agents/mcp.json"],
    ["agents nested global", ".agents/mcp/mcp.json"],
    ["explicit import", ".cursor/mcp.json"],
    ["auto import", ".cursor/mcp.json"],
  ])("saves directTools without copying inherited definitions from %s", async (kind, sourceFile) => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-save-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-save-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const sourcePath = join(home, sourceFile);
    const piPath = join(home, ".pi", "agent", "mcp.json");
    const projectPath = join(project, ".mcp.json");
    const projectPiPath = join(project, ".pi", "mcp.json");
    const source = {
      mcpServers: {
        inherited: { url: "https://internal.example/mcp", headers: { Authorization: "Bearer source-secret" } },
        customized: { command: "source-command", env: { TOKEN: "source-token" } },
      },
    };
    const destination = {
      imports: kind === "explicit import" ? ["cursor"] : [],
      settings: { hostConfigDiscovery: kind === "auto import" ? "on" : "off", showStatusIcon: false },
      mcpServers: {
        customized: { excludeTools: ["admin"] },
        piOwned: { command: "pi-command" },
      },
    };
    writeJson(sourcePath, source);
    writeJson(piPath, destination);
    writeJson(projectPath, { mcpServers: { projectOwned: { command: "project-command" } } });
    writeJson(projectPiPath, { mcpServers: { projectPiOwned: { command: "project-pi-command" } } });
    const sourceText = readFileSync(sourcePath, "utf-8");
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    const ui = createUi();
    const refreshed = vi.fn();
    const changes = new Map<string, true | false | string[]>([
      ["inherited", true],
      ["customized", false],
      ["piOwned", false],
      ["projectOwned", ["search"]],
      ["projectPiOwned", true],
    ]);
    mocks.createMcpPanel.mockImplementation((_config, _cache, _prov, _callbacks, _tui, done) => {
      done({ cancelled: false, changes });
      return { dispose() {} };
    });
    const save = () => openMcpPanel({
      config: loadMcpConfig(),
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, {} as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, cwd: project, ui } as any, undefined, refreshed);

    await expect(save()).resolves.toEqual({ configChanged: false });

    expect(JSON.parse(readFileSync(piPath, "utf-8"))).toEqual({
      ...destination,
      mcpServers: {
        inherited: { directTools: true },
        customized: { excludeTools: ["admin"], directTools: false },
        piOwned: { command: "pi-command", directTools: false },
      },
    });
    expect(JSON.parse(readFileSync(projectPath, "utf-8"))).toEqual({
      mcpServers: { projectOwned: { command: "project-command", directTools: ["search"] } },
    });
    expect(JSON.parse(readFileSync(projectPiPath, "utf-8"))).toEqual({
      mcpServers: { projectPiOwned: { command: "project-pi-command", directTools: true } },
    });
    expect(readFileSync(sourcePath, "utf-8")).toBe(sourceText);
    expect(refreshed).toHaveBeenCalledWith(changes);
    expect(ui.notify).toHaveBeenCalledWith("Direct tools updated for this session.", "info");
    expect(loadMcpConfig().mcpServers.inherited).toEqual({ ...source.mcpServers.inherited, directTools: true });

    source.mcpServers.inherited = { url: "https://updated.example/mcp", headers: { Authorization: "Bearer updated-secret" } };
    source.mcpServers.customized = { command: "updated-command", env: { TOKEN: "updated-token" } };
    writeJson(sourcePath, source);
    const updatedSourceText = readFileSync(sourcePath, "utf-8");
    changes.clear();
    for (const selection of [false, ["search"]] as const) {
      changes.set("inherited", selection === false ? false : [...selection]);
      await expect(save()).resolves.toEqual({ configChanged: false });
      expect(JSON.parse(readFileSync(piPath, "utf-8")).mcpServers.inherited).toEqual({ directTools: selection });
      expect(loadMcpConfig().mcpServers.inherited).toEqual({ ...source.mcpServers.inherited, directTools: selection });
    }
    expect(loadMcpConfig().mcpServers.customized).toEqual({
      ...source.mcpServers.customized, excludeTools: ["admin"], directTools: false,
    });
    expect(readFileSync(sourcePath, "utf-8")).toBe(updatedSourceText);
  });

  it("clears OAuth credentials, cancels pending auth, and closes the server on logout", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-commands-logout-"));
    const ui = createUi();
    const close = vi.fn();
    const { getAuthEntry, saveAuthEntry } = await import("../mcp-auth.ts");
    const { waitForCallback } = await import("../mcp-callback-server.ts");
    const { logoutServer } = await import("../commands.ts");

    saveAuthEntry("oauth-server", {
      tokens: { accessToken: "token", refreshToken: "refresh" },
      oauthState: "pending-state",
    }, "https://example.com/mcp");
    const pendingCallback = waitForCallback("pending-state");
    const pendingCallbackRejection = expect(pendingCallback).rejects.toThrow("Authorization cancelled");

    const result = await logoutServer("oauth-server", {
      config: { mcpServers: { "oauth-server": { url: "https://example.com/mcp", auth: "oauth" } } },
      manager: { close },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any);

    await pendingCallbackRejection;
    expect(result.ok).toBe(true);
    expect(getAuthEntry("oauth-server")).toBeUndefined();
    expect(close).toHaveBeenCalledWith("oauth-server");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("OAuth credentials cleared"), "info");
  });

  it("marks explicit OAuth servers as needs-auth when only stale URL tokens exist", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-commands-oauth-"));
    const ui = createUi();
    const { updateTokens } = await import("../mcp-auth.ts");
    const { openMcpPanel } = await import("../commands.ts");

    updateTokens("legacy", { accessToken: "legacy-token" });
    updateTokens("stale", { accessToken: "stale-token" }, "https://old.example.com/mcp");

    await openMcpPanel({
      config: {
        mcpServers: {
          legacy: { url: "https://new.example.com/mcp", auth: "oauth" },
          stale: { url: "https://new.example.com/mcp", auth: "oauth" },
        },
      },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any);

    const callbacks = mocks.createMcpPanel.mock.calls[0]?.[3];
    expect(callbacks.getConnectionStatus("legacy")).toBe("needs-auth");
    expect(callbacks.getConnectionStatus("stale")).toBe("needs-auth");
  });

  it("panel reconnect force-clears stale needs-auth state", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-commands-reconnect-"));
    const ui = createUi();
    const { updateTokens } = await import("../mcp-auth.ts");
    updateTokens("notion", { accessToken: "token" }, "https://mcp.notion.com/mcp");
    let currentConnection: any = { status: "needs-auth" };
    const close = vi.fn(async () => {
      currentConnection = null;
    });
    const connect = vi.fn(async () => {
      currentConnection = {
        status: "connected",
        tools: [{ name: "search", description: "Search" }],
        resources: [],
      };
      return currentConnection;
    });
    const state = {
      config: { mcpServers: { notion: { url: "https://mcp.notion.com/mcp", auth: "oauth" } } },
      manager: {
        close,
        connect,
        getConnection: vi.fn(() => currentConnection),
        getAllConnections: vi.fn(() => new Map(currentConnection?.status === "connected" ? [["notion", currentConnection]] : [])),
      },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map([["notion", Date.now()]]),
      lifecycle: { markKeepAlive: vi.fn() },
    } as any;
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel(state, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any);

    const callbacks = mocks.createMcpPanel.mock.calls[0]?.[3];
    await expect(callbacks.reconnect("notion")).resolves.toBe(true);

    expect(close).toHaveBeenCalledWith("notion");
    expect(connect).toHaveBeenCalledWith("notion", state.config.mcpServers.notion);
    expect(state.failureTracker.has("notion")).toBe(false);
    expect(state.toolMetadata.get("notion")?.[0]?.name).toBe("notion_search");
    expect(callbacks.getConnectionStatus("notion")).toBe("connected");
  });
});
