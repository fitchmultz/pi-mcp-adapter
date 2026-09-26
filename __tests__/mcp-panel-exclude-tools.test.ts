import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelResult } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("mcp-panel include/exclude tools", () => {
  it("projects canonical tools and resources on initial display and reconnect", async () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        docs: {
          command: "node",
          toolPrefix: "none",
          directTools: ["search"],
          includeTools: ["search", "details", "app_only", "read_guide", "read_secret"],
          excludeTools: ["read_secret"],
        },
        cold: { command: "node" },
      },
    };
    const entry = {
      configHash: computeServerHash(config.mcpServers.docs!),
      cachedAt: Date.now(),
      tools: [
        { name: "search", description: "Search docs" },
        { name: "app_only", _meta: { ui: { visibility: ["app"] } } },
        { name: "excluded" },
      ],
      resources: [
        { name: "guide", uri: "docs://guide" },
        { name: "secret", uri: "docs://secret" },
      ],
    };
    const done = vi.fn<(result: McpPanelResult) => void>();
    const panel = createMcpPanel(config, { version: 2, servers: { docs: entry } }, new Map(), {
      reconnect: async () => true,
      canAuthenticate: () => false,
      authenticate: async () => ({ ok: false }),
      getConnectionStatus: () => "connected",
      refreshCacheAfterReconnect: () => ({ ...entry, tools: [...entry.tools, { name: "details" }] }),
    }, { requestRender: () => {} }, done);
    panel.handleInput("\r");
    let output = stripAnsi(panel.render(100).join("\n"));
    expect(output).not.toMatch(/app_only|excluded|read_guide|read_secret/);
    expect(output).toContain("1 tool, 1 pinned, 1 resource");
    expect(output).toContain("resources / read-resource");
    expect(output).toContain("cold  (undiscovered)");

    panel.handleInput("\x12"); // reconnect, then keep existing pin choices
    await vi.waitFor(() => {
      output = stripAnsi(panel.render(100).join("\n"));
      expect(output).toContain("2 tools, 1 pinned, 1 resource");
    });
    expect(output).toContain("details");
    expect(output).not.toMatch(/app_only|excluded|read_guide|read_secret/);
    panel.handleInput(" "); // pin all actual tools
    panel.handleInput("\x13");
    expect(done.mock.calls[0]![0].changes.get("docs")).toBe(true);
    panel.dispose();
  });

  it("omits resources disabled by policy and preserves legacy cache visibility", () => {
    const config: McpConfig = { mcpServers: { docs: { command: "node", exposeResources: false } } };
    const panel = createMcpPanel(config, { version: 1, servers: { docs: {
      configHash: computeServerHash(config.mcpServers.docs!), cachedAt: Date.now(),
      tools: [{ name: "search" }, { name: "app_only", uiVisibility: ["app"] }],
      resources: [{ name: "guide", uri: "docs://guide" }],
    } } }, new Map(), {
      reconnect: async () => true, canAuthenticate: () => false,
      authenticate: async () => ({ ok: false }), getConnectionStatus: () => "idle",
      refreshCacheAfterReconnect: () => null,
    }, { requestRender: () => {} }, () => {});
    panel.handleInput("\r");
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).not.toMatch(/app_only|read_guide|resources \/ read-resource/);
    expect(output).toContain("1 tool, 0 pinned");
    panel.dispose();
  });
  it("hides excluded tools from the panel view", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot", "read_figjam"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma!),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const panel = createMcpPanel(
      config,
      cache,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("g");
    panel.handleInput("e");
    panel.handleInput("t");
    panel.handleInput("_");

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("get_nodes");
    expect(output).not.toContain("get_screenshot");
    expect(output).not.toContain("read_figjam");

    panel.dispose();
  });

  it("hides non-included tools from the panel view", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          includeTools: ["get_node*"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma!),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
        },
      },
    };

    const panel = createMcpPanel(
      config,
      cache,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("g");
    panel.handleInput("e");
    panel.handleInput("t");
    panel.handleInput("_");

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("get_nodes");
    expect(output).not.toContain("get_screenshot");
    expect(output).not.toContain("read_figjam");

    panel.dispose();
  });
});
