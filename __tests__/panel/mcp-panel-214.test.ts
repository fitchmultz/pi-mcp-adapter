import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noop } from "./helpers.ts";
import { createMcpPanel } from "../../mcp-panel.ts";
import type { PanelThemeInput } from "../../mcp-panel-text.ts";
import { computeServerHash, type MetadataCache } from "../../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult } from "../../types.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

function createPanelCallbacks(overrides: Partial<McpPanelCallbacks> = {}): McpPanelCallbacks {
  return {
    reconnect: () => Promise.resolve(true),
    canAuthenticate: () => false,
    authenticate: () => Promise.resolve({ ok: false }),
    getConnectionStatus: () => "idle",
    refreshCacheAfterReconnect: () => null,
    ...overrides,
  };
}

function createSampleCache(config: McpConfig): MetadataCache {
  const servers: MetadataCache["servers"] = {};
  const docs = config.mcpServers.docs;
  if (docs) {
    servers.docs = {
      configHash: computeServerHash(docs),
      cachedAt: Date.now(),
      tools: [
        { name: "search_docs", description: "Search project documentation cleanly" },
        { name: "get_page", description: "Fetch page body" },
      ],
      resources: [],
    };
  }
  const locked = config.mcpServers.locked;
  if (locked) {
    servers.locked = {
      configHash: computeServerHash(locked),
      cachedAt: Date.now(),
      tools: [{ name: "hidden_tool", description: "Should not toggle when disabled" }],
      resources: [],
    };
  }
  return { version: 2, servers };
}

describe("MCP-214 panel polish and single-pass open", () => {
  it("uses Pi theme helpers without hardcoded ANSI escapes when theme is provided", () => {
    const fgCalls: string[] = [];
    const theme: PanelThemeInput = {
      fg: vi.fn<PanelThemeInput["fg"]>((token, text) => {
        fgCalls.push(token);
        const tag = token[0] ?? "x";
        return `<${tag}>${text}</${tag}>`;
      }),
      bold: vi.fn<PanelThemeInput["bold"]>((text) => `<b>${text}</b>`),
      italic: vi.fn<PanelThemeInput["italic"]>((text) => `<i>${text}</i>`),
      inverse: vi.fn<PanelThemeInput["inverse"]>((text) => `<v>${text}</v>`),
    };
    const config: McpConfig = {
      mcpServers: {
        docs: { url: "https://docs.example.test/mcp" },
        brokenSrv: { url: "https://broken.example.test/mcp" },
      },
    };
    const panel = createMcpPanel({
      config,
      cache: createSampleCache(config),
      provenance: new Map(),
      callbacks: createPanelCallbacks({
        getConnectionStatus: (name) => (name === "brokenSrv" ? "failed" : "connected"),
      }),
      tui: { requestRender: noop },
      done: noop,
      options: { theme },
    });

    const rendered = panel.render(220).join("\n");
    panel.dispose();

    expect(fgCalls).toContain("accent");
    expect(fgCalls).toContain("error");
    expect(rendered).toContain("<e>failed</e>");
    expect(rendered).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("blocks Space and Enter on disabled servers", () => {
    const config: McpConfig = {
      mcpServers: {
        locked: { command: "node", disabled: true },
      },
    };
    const done = vi.fn<(result: McpPanelResult) => void>();
    const reconnect = vi.fn<McpPanelCallbacks["reconnect"]>(() => Promise.resolve(true));
    const panel = createMcpPanel({
      config,
      cache: createSampleCache(config),
      provenance: new Map(),
      callbacks: createPanelCallbacks({
        reconnect,
        getConnectionStatus: () => "disabled",
      }),
      tui: { requestRender: noop },
      done,
    });

    panel.handleInput(" ");
    panel.handleInput("\r");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("disabled");
    expect(output).not.toContain("(unsaved)");

    panel.handleInput("\x13");
    expect(done).toHaveBeenCalledWith({ cancelled: false, changes: new Map() });
    expect(reconnect).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("maps real callback statuses for disabled, needs-auth, failed, and idle servers without inventing blocked", async () => {
    const prevAuthStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    try {
      const home = makeTempDir("pi-mcp-panel-cb-home-");
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

      const { buildMcpPanelCallbacks } = await import("../../mcp-panel-callbacks.ts");
      const { createTestExtensionContext } = await import("../test-extension-context.ts");
      const { createTestState } = await import("../test-state.ts");

      const host = await createTestExtensionContext();
      const state = createTestState({
        config: {
          mcpServers: {
            locked: { command: "node", disabled: true },
            oauthSrv: { url: "https://oauth.example.test/mcp", auth: "oauth" },
            brokenSrv: { url: "https://broken.example.test/mcp" },
            idleSrv: { url: "https://idle.example.test/mcp" },
          },
        },
        failureTracker: new Map([["brokenSrv", Date.now()]]),
        failureMessages: new Map([["brokenSrv", "Dial timeout"]]),
      });
      const callbacks = await buildMcpPanelCallbacks(state, state.config, host.context);
      expect(callbacks.getConnectionStatus("locked")).toBe("disabled");
      expect(callbacks.getConnectionStatus("oauthSrv")).toBe("needs-auth");
      expect(callbacks.getConnectionStatus("brokenSrv")).toBe("failed");
      expect(callbacks.getConnectionStatus("idleSrv")).toBe("idle");
      expect(callbacks.getFailureMessage?.("brokenSrv")).toBe("Dial timeout");
      await state.owner.stop();
      await host.dispose();
    } finally {
      if (prevAuthStore === undefined) {
        delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      } else {
        process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = prevAuthStore;
      }
    }
  });

  it("pauses 60s inactivity auto-cancel while busy or dirty and resumes when idle and clean", async () => {
    vi.useFakeTimers();
    const config: McpConfig = {
      mcpServers: {
        docs: { url: "https://docs.example.test/mcp" },
      },
    };
    let resolveReconnect: ((value: boolean) => void) | undefined;
    const done = vi.fn<(result: McpPanelResult) => void>();
    const panel = createMcpPanel({
      config,
      cache: createSampleCache(config),
      provenance: new Map(),
      callbacks: createPanelCallbacks({
        reconnect: () =>
          new Promise<boolean>((resolve) => {
            resolveReconnect = resolve;
          }),
      }),
      tui: { requestRender: noop },
      done,
    });

    panel.handleInput("\x12");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(done).not.toHaveBeenCalled();

    resolveReconnect?.(true);
    await Promise.resolve();
    await Promise.resolve();

    panel.handleInput(" ");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(done).not.toHaveBeenCalled();

    panel.handleInput(" ");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toHaveBeenCalledWith({ cancelled: true, changes: new Map() });
    panel.dispose();
  });

  it("keeps matching undiscovered and failed servers in search and renders token estimates", () => {
    const config: McpConfig = {
      mcpServers: {
        docs: { url: "https://docs.example.test/mcp", directTools: ["search_docs"] },
        cold_remote: { url: "https://cold.example.test/mcp", description: "Billing API server" },
        broken_remote: { url: "https://broken.example.test/mcp" },
      },
    };
    const panel = createMcpPanel({
      config,
      cache: createSampleCache(config),
      provenance: new Map(),
      callbacks: createPanelCallbacks({
        getConnectionStatus: (name) => (name === "broken_remote" ? "failed" : "idle"),
        getFailureMessage: (name) => (name === "broken_remote" ? "Timeout waiting" : null),
      }),
      tui: { requestRender: noop },
      done: noop,
    });

    panel.handleInput("\r");
    const fullView = stripAnsi(panel.render(100).join("\n"));
    expect(fullView).toMatch(/search_docs ~\d+t/);
    expect(fullView).toMatch(/2 tools, 1 pinned \(~\d+\/\d+ tok\)/);
    expect(fullView).toMatch(/1 pinned \(~\d+ tok\) \/ 2 total \(~\d+ tok\)/);

    for (const ch of "remote") {
      panel.handleInput(ch);
    }
    const nameSearch = stripAnsi(panel.render(100).join("\n"));
    expect(nameSearch).toContain("cold_remote");
    expect(nameSearch).toContain("broken_remote");

    panel.handleInput("\x1b");
    panel.handleInput("?");
    for (const ch of "Billing") {
      panel.handleInput(ch);
    }
    const descSearch = stripAnsi(panel.render(100).join("\n"));
    expect(descSearch).toContain("cold_remote");
    panel.dispose();
  });

  it("reads each config file only once when opening /mcp", async () => {
    const home = makeTempDir("pi-mcp-open-home-");
    const project = makeTempDir("pi-mcp-open-proj-");
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

    const sharedPath = join(project, ".mcp.json");
    const piPath = join(project, ".pi", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(join(project, ".pi", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      sharedPath,
      JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.test/mcp" } } }),
    );
    writeFileSync(piPath, JSON.stringify({ mcpServers: { docs: { directTools: true } } }));

    vi.resetModules();
    const freshConfigImports = await import("../../config-imports.ts");
    const { openMcpPanel: openFreshPanel } = await import("../../commands.ts");
    const { createPanelHost: createFreshPanelHost } = await import("../fixtures/panel-host.ts");
    const { createTestState: createFreshState } = await import("../test-state.ts");

    const panelHost = await createFreshPanelHost();
    const state = createFreshState({
      config: { mcpServers: { docs: { url: "https://docs.example.test/mcp", directTools: true } } },
    });
    const spy = vi.spyOn(freshConfigImports, "readValidatedConfigWithDiagnostics");
    vi.spyOn(panelHost.context.ui, "custom").mockResolvedValue({
      cancelled: true,
      changes: new Map(),
    });
    const ctx = { ...panelHost.context, cwd: project };

    await openFreshPanel({ state, pi: panelHost.api, ctx });
    await state.owner.stop();
    await panelHost.dispose();

    const reads = new Map<string, number>();
    for (const [path] of spy.mock.calls) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
    }
    expect(reads.get(sharedPath)).toBe(1);
    expect(reads.get(piPath)).toBe(1);
  });
});
