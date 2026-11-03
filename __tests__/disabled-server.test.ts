import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDirectToolExecutor,
  getMissingConfiguredDirectToolServers,
} from "../direct-tools.ts";
import { resolvePinnedTools } from "./fixtures/pinned-tools.ts";
import {
  executeAuthStart,
  executeCall,
  executeConnect,
  executeDescribe,
  executeInstructions,
  executeList,
  executeSearch,
  executeStatus,
} from "../proxy-modes.ts";
import { updateStatusBar } from "../init.ts";
import { loadMcpConfig, writeProjectServerDisabledOverride } from "../config.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import { McpServerManager } from "../server-manager.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";
import { createActivationFixture } from "./fixtures/strict-activation-boundaries.ts";

let host: Awaited<ReturnType<typeof createActivationFixture>>;
beforeEach(async () => {
  host = await createActivationFixture();
});
afterEach(async () => {
  await host.dispose();
});

const cache: MetadataCache = {
  version: 1,
  servers: {
    disabled: {
      configHash: "disabled-cache",
      cachedAt: Date.now(),
      tools: [{ name: "search", description: "disabled search" }],
      resources: [{ name: "doc", uri: "mcp://doc" }],
      instructions: "disabled instructions",
    },
    enabled: {
      configHash: "enabled-cache",
      cachedAt: Date.now(),
      tools: [{ name: "search", description: "enabled search" }],
      resources: [],
    },
  },
};

async function disabledState() {
  const wire = await host.wire();
  const state = host.state();
  await state.manager.connect("disabled", wire.definition);
  state.config = {
    mcpServers: {
      disabled: { ...wire.definition, disabled: true },
      enabled: { command: "node" },
    },
  };
  state.toolMetadata.set("disabled", [
    { name: "disabled_search", originalName: "search", description: "cached" },
  ]);
  state.serverInstructions.set("disabled", "cached instructions");
  return state;
}

describe("disabled MCP servers", () => {
  it("only literal true disables direct tools and configured bootstrap", async () => {
    const path = join(host.directory, "literal-disabled.json");
    writeFileSync(
      path,
      JSON.stringify({
        settings: { directTools: true },
        mcpServers: {
          disabled: { command: "node", disabled: true },
          string: { command: "node", disabled: "true" },
          enabled: { command: "node" },
        },
      }),
    );
    const config = loadMcpConfig(path, host.directory);
    const disabledCache = cache.servers.disabled;
    const enabledCache = cache.servers.enabled;
    const { disabled, string, enabled } = config.mcpServers;
    assert(disabledCache !== undefined && enabledCache !== undefined);
    assert(disabled !== undefined && string !== undefined && enabled !== undefined);
    const directCache: MetadataCache = {
      ...cache,
      servers: {
        disabled: {
          ...disabledCache,
          configHash: computeServerHash(disabled),
        },
        string: {
          ...enabledCache,
          configHash: computeServerHash(string),
        },
        enabled: {
          ...enabledCache,
          configHash: computeServerHash(enabled),
        },
      },
    };

    expect(
      (await resolvePinnedTools(config, directCache, "server"))
        .map((spec) => spec.serverName)
        .sort(),
    ).toEqual(["enabled", "string"]);
    expect(getMissingConfiguredDirectToolServers(config, directCache)).not.toContain("disabled");
  });

  it("rejects stale direct executors before connect or auth", async () => {
    const state = await disabledState();
    const connect = vi.spyOn(state.manager, "connect");
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "disabled",
        originalName: "search",
        prefixedName: "disabled_search",
        description: "cached",
      },
    );

    const result = await execute(
      "call",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("call", state.owner.signal),
    );
    expect(result.details).toMatchObject({ error: "server_disabled", server: "disabled" });
    const content = result.content[0];
    assert(content?.type === "text");
    expect(content.text).toContain("/reload");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects proxy execution and hides disabled cached metadata while listing it in status", async () => {
    const state = await disabledState();
    const connect = vi.spyOn(state.manager, "connect");
    const status = executeStatus(state).content[0];
    assert(status?.type === "text");
    expect(status.text).toContain("disabled");
    expect(status.text).toContain("0/1 connected");
    expect(executeList(state, "disabled").details).toMatchObject({ error: "server_disabled" });
    expect(executeInstructions(state, "disabled").details).toMatchObject({
      error: "server_disabled",
    });
    state.toolMetadata.set("enabled", [
      { name: "disabled_search", originalName: "search", description: "enabled duplicate" },
    ]);
    expect(executeDescribe(state, "disabled_search").details).toMatchObject({ server: "enabled" });
    state.toolMetadata.delete("enabled");
    expect(executeDescribe(state, "disabled_search").details).toMatchObject({
      error: "server_disabled",
    });
    expect(executeSearch(state, { query: "cached" }).details).toMatchObject({ count: 0 });
    expect(executeSearch(state, { query: "cached", server: "disabled" }).details).toMatchObject({
      error: "server_disabled",
    });
    expect(
      (await executeCall(state, { toolName: "disabled_search", args: {} })).details,
    ).toMatchObject({
      error: "server_disabled",
    });
    expect(
      (
        await executeCall(state, {
          toolName: "disabled_search",
          args: {},
          serverOverride: "disabled",
        })
      ).details,
    ).toMatchObject({
      error: "server_disabled",
    });
    expect((await executeConnect(state, { serverName: "disabled" })).details).toMatchObject({
      error: "server_disabled",
    });
    expect((await executeAuthStart(state, "disabled")).details).toMatchObject({
      error: "server_disabled",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects manager and UI resource connections for disabled definitions", async () => {
    const manager = new McpServerManager();
    host.state({ manager });
    await expect(manager.connect("disabled", { command: "node", disabled: true })).rejects.toThrow(
      "disabled",
    );
    const handler = new UiResourceHandler(manager, {
      mcpServers: { disabled: { url: "https://example.test", disabled: true } },
    });
    await expect(handler.readUiResource("disabled", "ui://example")).rejects.toThrow("disabled");
  });

  it("writes only a project-local disabled override and removes it cleanly", () => {
    const cwd = mkdtempSync(join(host.directory, "pi-mcp-disabled-override-"));
    const filePath = join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(join(cwd, ".pi", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        unrelated: { keep: true },
        mcpServers: {
          disabled: { disabled: false, directTools: true },
          onlyFlag: { disabled: true },
        },
      }),
    );

    expect(writeProjectServerDisabledOverride(undefined, cwd, "disabled", true)).toMatchObject({
      changed: true,
      path: filePath,
    });
    const disabledRaw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    expect(disabledRaw).toHaveProperty("unrelated", { keep: true });
    expect(disabledRaw).toHaveProperty("mcpServers.disabled", {
      disabled: true,
      directTools: true,
    });

    expect(writeProjectServerDisabledOverride(undefined, cwd, "onlyFlag", false)).toMatchObject({
      changed: true,
    });
    const enabledRaw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    expect(enabledRaw).not.toHaveProperty("mcpServers.onlyFlag");
    expect(enabledRaw).toHaveProperty("mcpServers.disabled.directTools", true);
  });

  it("writes an explicit enabled override when a lower config disables the server", () => {
    const cwd = mkdtempSync(join(host.directory, "pi-mcp-disabled-layer-"));
    const overridePath = join(cwd, "factory.json");
    writeFileSync(
      overridePath,
      JSON.stringify({ mcpServers: { lower: { command: "node", disabled: true } } }),
    );

    expect(writeProjectServerDisabledOverride(overridePath, cwd, "lower", false)).toMatchObject({
      changed: true,
    });
    const raw: unknown = JSON.parse(
      readFileSync(join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json"), "utf8"),
    );
    expect(raw).toHaveProperty("mcpServers.lower", { disabled: false });
    const lower = loadMcpConfig(overridePath, cwd).mcpServers.lower;
    assert(lower !== undefined);
    expect(lower.disabled).toBe(false);
  });

  it("enables a server disabled by an import declared in the project override", () => {
    const cwd = mkdtempSync(join(host.directory, "pi-mcp-disabled-project-import-"));
    mkdirSync(join(cwd, ".vscode"));
    mkdirSync(join(cwd, ".pi", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      join(cwd, ".vscode", "mcp.json"),
      JSON.stringify({
        mcpServers: { imported: { command: "node", disabled: true } },
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json"),
      JSON.stringify({
        imports: ["vscode"],
        mcpServers: { imported: { disabled: true } },
      }),
    );

    expect(writeProjectServerDisabledOverride(undefined, cwd, "imported", false)).toMatchObject({
      changed: true,
    });
    const raw: unknown = JSON.parse(
      readFileSync(join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json"), "utf8"),
    );
    expect(raw).toHaveProperty("mcpServers.imported", { disabled: false });
    expect(loadMcpConfig(undefined, cwd).mcpServers.imported).toMatchObject({
      command: "node",
      disabled: false,
    });
  });

  it("preserves the supported raw server-map key while updating an override", () => {
    const cwd = mkdtempSync(join(host.directory, "pi-mcp-disabled-alias-"));
    const filePath = join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(join(cwd, ".pi", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ "mcp-servers": { alias: { command: "node", args: ["server"] } } }),
    );

    expect(writeProjectServerDisabledOverride(undefined, cwd, "alias", true)).toMatchObject({
      changed: true,
    });
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw).not.toHaveProperty("mcpServers");
    expect(raw).toHaveProperty(["mcp-servers", "alias"], {
      command: "node",
      args: ["server"],
      disabled: true,
    });
    expect(loadMcpConfig(undefined, cwd).mcpServers.alias).toMatchObject({
      command: "node",
      args: ["server"],
      disabled: true,
    });
  });

  it("preserves malformed project overrides instead of replacing them", () => {
    const cwd = mkdtempSync(join(host.directory, "pi-mcp-disabled-malformed-"));
    const filePath = join(cwd, ".pi", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(join(cwd, ".pi", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(filePath, "{ malformed");

    expect(() => writeProjectServerDisabledOverride(undefined, cwd, "server", true)).toThrow(
      "Failed to read project MCP override",
    );
    expect(readFileSync(filePath, "utf8")).toBe("{ malformed");
  });

  it("initializes all-disabled config without attempting connections or cache bootstrap", async () => {
    const state = await host.initialize({
      config: { mcpServers: { one: { command: "node", disabled: true } } },
    });

    expect(host.ui.notify).toHaveBeenCalledWith("MCP: All 1 server(s) are disabled", "info");
    expect(state.manager.getAllConnections().size).toBe(0);
  });

  it("connects only enabled servers during mixed eager initialization", async () => {
    const wire = await host.wire();
    const connect = vi.spyOn(McpServerManager.prototype, "connect");
    host.runner.setUIContext(undefined, "print");
    const state = await host.initialize({
      config: {
        mcpServers: {
          disabled: { ...wire.definition, lifecycle: "eager", disabled: true },
          enabled: { ...wire.definition, lifecycle: "eager" },
        },
      },
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      "enabled",
      expect.objectContaining({ lifecycle: "eager" }),
      expect.any(AbortSignal),
    );
    expect(state.manager.getConnection("enabled")?.status).toBe("connected");
    expect(state.manager.getConnection("disabled")).toBeUndefined();
    expect(wire.methods).toContain("tools/list");
  });

  it("keeps no-theme status usable and reports disabled count", async () => {
    const state = await disabledState();
    state.config.settings = { mcpFooterStatus: "full" };
    // A JavaScript host can omit the required SDK theme at runtime.
    // Preserve the adapter fallback without inventing a partial Theme class.
    const ui = { ...host.ui };
    Object.defineProperty(ui, "theme", { value: undefined });
    state.ui = ui;
    updateStatusBar(state);
    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled (1 disabled)");
  });
});
