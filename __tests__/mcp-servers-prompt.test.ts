import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type * as Init from "../init.ts";
import type * as MetadataCacheModule from "../metadata-cache.ts";
import {
  MAX_SERVERS_SECTION_CHARS,
  MCP_SERVERS_SECTION,
  renderMcpServersSection,
} from "../mcp-servers-prompt.ts";
import { computeServerHash } from "../metadata-cache.ts";
import { createMcpAdapter } from "../index.ts";
import type { McpConfig } from "../types.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createTestState } from "./test-state.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn<typeof Init.initializeMcp>(),
  loadMetadataCache: vi.fn<typeof MetadataCacheModule.loadMetadataCache>(),
  flushMetadataCache: vi.fn<typeof Init.flushMetadataCache>(),
  updateStatusBar: vi.fn<typeof Init.updateStatusBar>(),
}));

vi.mock("../init.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Init>()),
  initializeMcp: mocks.initializeMcp,
  flushMetadataCache: mocks.flushMetadataCache,
  updateStatusBar: mocks.updateStatusBar,
}));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof MetadataCacheModule>()),
  loadMetadataCache: mocks.loadMetadataCache,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("<mcp_servers> system prompt section and lifecycle", () => {
  it("renders sorted enabled servers with description/instructions fallback and stays within 4096 chars", () => {
    const beta = { command: "beta" };
    const config: McpConfig = {
      mcpServers: {
        zeta: { command: "zeta", description: "Zeta search\nSecond line ignored" },
        alpha: { command: "alpha" },
        disabled_one: { command: "off", disabled: true, description: "Hidden" },
        beta,
      },
      settings: { disableProxyTool: true },
    };
    const instructions = new Map([["alpha", "Alpha live instructions\nDetails omitted"]]);
    const cache = {
      version: 2,
      servers: {
        beta: {
          configHash: computeServerHash(beta),
          tools: [],
          resources: [],
          instructions: "Beta cached summary",
          cachedAt: Date.now(),
        },
      },
    };

    const section = renderMcpServersSection(config, instructions, cache);
    assert.ok(section !== undefined);
    expect(section).not.toContain("disabled_one");
    expect(section).not.toContain("with `mcp`");
    expect(section).toContain("- alpha: Alpha live instructions");
    expect(section).toContain("- beta: Beta cached summary");
    expect(section).toContain("- zeta: Zeta search");
    expect(section.indexOf("- alpha:")).toBeLessThan(section.indexOf("- beta:"));
    expect(section.indexOf("- beta:")).toBeLessThan(section.indexOf("- zeta:"));
    expect(section).not.toContain("Second line ignored");

    expect(
      renderMcpServersSection(
        { mcpServers: { off: { command: "off", disabled: true } } },
        new Map(),
        null,
      ),
    ).toBeUndefined();

    const hugeServers: McpConfig["mcpServers"] = {};
    for (let i = 0; i < 160; i++) {
      hugeServers[`server-${String(i).padStart(3, "0")}-long-namespace-name`] = {
        command: "demo",
        description: "Detailed server description ".repeat(15),
      };
    }
    const bounded = renderMcpServersSection({ mcpServers: hugeServers }, new Map(), null);
    assert.ok(bounded !== undefined);
    expect(bounded.length).toBeLessThanOrEqual(MAX_SERVERS_SECTION_CHARS);
    expect(bounded).toContain("more server");
  });

  it("renders cache-stable <mcp_servers> in Pi system prompt even with disableProxyTool and surfaces tool_search instructions once", async () => {
    const config: McpConfig = {
      mcpServers: {
        docs: {
          command: "docs",
          description: "Docs catalog",
          directTools: ["ping"],
        },
        issues: { command: "issues" },
      },
      settings: { disableProxyTool: true, freezeDirectTools: true },
    };
    const state = createTestState({ config });
    state.toolMetadata.set("docs", [
      { name: "mcp__docs__ping", originalName: "ping", description: "Ping" },
    ]);
    state.toolMetadata.set("issues", [
      { name: "mcp__issues__list", originalName: "list", description: "List issues" },
    ]);
    state.serverInstructions.set("issues", "Always pass team_id when querying issues.");
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockResolvedValue(state);

    const host = await createTestExtensionContext("builtin", createMcpAdapter({ config }));
    try {
      await host.runner.emit({ type: "session_start", reason: "startup" });

      const first = await host.runner.emitBeforeAgentStart(
        { messageType: "user", prompt: "hello" },
        { cwd: host.context.cwd },
      );
      const firstSection = first.systemPromptOptions.sections[MCP_SERVERS_SECTION];
      assert.ok(firstSection !== undefined);
      expect(firstSection).toContain("- docs: Docs catalog");
      expect(firstSection).toContain("- issues: Always pass team_id when querying issues.");
      expect(firstSection).not.toContain("with `mcp`");

      // Mutating instructions after freeze keeps the <mcp_servers> section byte-identical.
      state.serverInstructions.set("issues", "Changed instructions after reconnect");
      const second = await host.runner.emitBeforeAgentStart(
        { messageType: "user", prompt: "hello again" },
        { cwd: host.context.cwd },
      );
      expect(second.systemPromptOptions.sections[MCP_SERVERS_SECTION]).toBe(firstSection);

      // tool_search surfaces serverInstructions once per server, not on repeated loads.
      const firstLoad = await host.runner.emitToolResult({
        type: "tool_result",
        toolCallId: "ts-1",
        toolName: "tool_search",
        input: { query: "issues" },
        content: [{ type: "text", text: "Loaded 1 tool." }],
        details: { loaded: ["mcp__issues__list"] },
        isError: false,
      });
      assert.ok(firstLoad?.content !== undefined);
      expect(firstLoad.content).toHaveLength(2);
      const secondBlock = firstLoad.content[1];
      assert.ok(secondBlock?.type === "text");
      expect(secondBlock.text).toContain("Server instructions (issues):");
      expect(secondBlock.text).toContain("Changed instructions after reconnect");

      const secondLoad = await host.runner.emitToolResult({
        type: "tool_result",
        toolCallId: "ts-2",
        toolName: "tool_search",
        input: { query: "issues" },
        content: [{ type: "text", text: "Loaded 1 tool." }],
        details: { loaded: ["mcp__issues__list"] },
        isError: false,
      });
      expect(secondLoad).toBeUndefined();

      await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      await host.dispose();
    }
  });

  it("refreshes deferred catalog tools under freezeDirectTools while keeping pinned tools frozen", async () => {
    const config: McpConfig = {
      mcpServers: {
        demo: { command: "demo", directTools: ["pinned"] },
      },
      settings: { freezeDirectTools: true },
    };
    const state = createTestState({ config });
    state.toolMetadata.set("demo", [
      { name: "mcp__demo__pinned", originalName: "pinned", description: "Pinned v1" },
      { name: "mcp__demo__deferred", originalName: "deferred", description: "Deferred v1" },
    ]);
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockResolvedValue(state);

    const host = await createTestExtensionContext("builtin", createMcpAdapter({ config }));
    try {
      await host.runner.emit({ type: "session_start", reason: "startup" });
      expect(host.runner.getToolDefinition("mcp__demo__pinned")?.description).toBe("Pinned v1");
      expect(host.runner.getToolDefinition("mcp__demo__deferred")?.description).toBe("Deferred v1");
      const activeBefore = host.api.getActiveTools();

      state.toolMetadata.set("demo", [
        { name: "mcp__demo__pinned", originalName: "pinned", description: "Pinned v2" },
        { name: "mcp__demo__deferred", originalName: "deferred", description: "Deferred v2" },
        { name: "mcp__demo__added", originalName: "added", description: "Added deferred" },
      ]);
      await state.onToolMetadataUpdated?.("demo", "tools-list-changed");

      // Pinned tool and active tool set stay frozen.
      expect(host.runner.getToolDefinition("mcp__demo__pinned")?.description).toBe("Pinned v1");
      expect(host.api.getActiveTools()).toEqual(activeBefore);
      // Deferred tools refresh cleanly.
      expect(host.runner.getToolDefinition("mcp__demo__deferred")?.description).toBe("Deferred v2");
      expect(host.runner.getToolDefinition("mcp__demo__added")?.exposure).toBe("deferred");

      await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      await host.dispose();
    }
  });

  it("awaits cold-cache directTools from mcp.json at session_start without MCP_DIRECT_TOOLS env", async () => {
    const config: McpConfig = {
      mcpServers: {
        cold: { command: "cold", directTools: true },
      },
    };
    const state = createTestState({ config });
    state.toolMetadata.set("cold", [
      { name: "mcp__cold__ping", originalName: "ping", description: "Ping" },
    ]);
    const deferredInit = Promise.withResolvers<typeof state>();
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockReturnValue(deferredInit.promise);

    const directory = await mkdtemp(join(tmpdir(), "pi-mcp-cold-direct-"));
    try {
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [createMcpAdapter({ config })],
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
        noTools: "builtin",
      });
      try {
        let bound = false;
        const bindPromise = (async () => {
          await session.bindExtensions({});
          bound = true;
        })();
        await delay(25);
        expect(bound).toBe(false);

        deferredInit.resolve(state);
        await bindPromise;
        expect(bound).toBe(true);
        expect(session.getActiveToolNames()).toContain("mcp__cold__ping");

        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
