import { describe, expect, it, vi } from "vitest";
import { createToolLoader, supportsNativeAsync, type SearchAPI } from "../tool-loader.ts";
import { computeServerHash } from "../metadata-cache.ts";
import type { McpConfig, McpTool } from "../types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Ref = { name: string; namespace?: string };
const refKey = (ref: Ref) => JSON.stringify([ref.namespace ?? null, ref.name]);
function host(native = false, allow: (ref: Ref) => boolean = () => true) {
  const definitions = new Map<string, any>();
  let active: Ref[] = [{ name: "mcp" }, { name: "read" }];
  const entries: any[] = [];
  const api = {
    registerTool: vi.fn((tool: any) => {
      definitions.set(refKey(tool), tool);
      if (allow(tool) && !active.some(ref => refKey(ref) === refKey(tool))) active.push({ name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) });
    }),
    registerEntryRenderer: vi.fn(),
    getAllTools: () => [...definitions.values()].filter(allow),
    getActiveTools: () => active.map(ref => ref.namespace ? refKey(ref) : ref.name),
    setActiveTools: (names: string[]) => { active = names.map(name => ({ name })).filter(allow); },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    ...(native ? {
      registerToolSearch: vi.fn(),
      getActiveToolReferences: () => active,
      setActiveToolReferences: (refs: Ref[]) => { active = refs.filter(allow); },
    } : {}),
  } as unknown as SearchAPI;
  const ctx = { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
  return { api, ctx, entries, definitions, active: () => active };
}
const config: McpConfig = { mcpServers: { demo: { command: "unused", directTools: ["pinned"] }, other: { command: "unused" } } };
const schema = { type: "object" as const, properties: { query: { type: "string", description: "Exact query", enum: ["one", "two"] } }, additionalProperties: false };
const tool = (name: string): McpTool => ({ name, description: name, inputSchema: schema, outputSchema: { type: "object", properties: { result: { type: "number" } } } });
function cache() {
  return { version: 2, servers: Object.fromEntries(Object.entries(config.mcpServers).map(([server, definition]) => [server, {
    configHash: computeServerHash(definition), tools: server === "demo" ? [tool("pinned"), tool("search")] : [tool("search")], resources: [], cachedAt: Date.now(),
  }])) };
}
const match = (server: string, originalName: string) => ({ server, tool: { ...tool(originalName), description: originalName, name: `${server}_${originalName}`, originalName } });

describe("MCP typed loader", () => {
  it("enables async only with host lifecycle support and for non-interactive direct calls", () => {
    const capability = { model: { compat: { supportsAsyncTools: true } } };
    expect(supportsNativeAsync(capability as unknown as ExtensionContext)).toBe(false);
    expect(supportsNativeAsync({ getPendingToolCalls() {}, ...capability } as unknown as ExtensionContext)).toBe(true);
    expect(supportsNativeAsync({ getPendingToolCalls() {}, model: { compat: { supportsAsyncTools: false } } } as unknown as ExtensionContext)).toBe(false);
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    const catalog = cache();
    catalog.servers.other!.tools[0]!._meta = { ui: { resourceUri: "ui://app" } };
    const gated = { ...config, settings: { approveTools: ["pinned"] } };
    loader.sync(gated, catalog, undefined, true);
    expect(h.definitions.get(refKey({ name: "demo_search" })).async).toBe(true);
    expect(h.definitions.get(refKey({ name: "demo_pinned" })).async).toBeUndefined();
    expect(h.definitions.get(refKey({ name: "other_search" })).async).toBeUndefined();
    loader.sync(gated, catalog, undefined, false);
    expect(h.definitions.get(refKey({ name: "demo_search" })).async).toBeUndefined();
    const guardedHost = host();
    const guarded = createToolLoader(guardedHost.api, () => null, () => null, async () => {});
    guarded.restore(guardedHost.ctx);
    guarded.sync(config, cache(), undefined, true);
    expect(guardedHost.definitions.get(refKey({ name: "demo_search" })).async).toBeUndefined();
    expect(guardedHost.definitions.get(refKey({ name: "demo_search" })).executionMode).toBe("sequential");
  });

  it("registers real schemas silently but activates only pins until discovery", () => {
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.definitions.size).toBe(3);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }, { name: "demo_pinned" }]);
    const definition = h.definitions.get(refKey({ name: "demo_search" }));
    expect(definition.parameters).toEqual(schema);
    expect(definition).not.toHaveProperty("promptSnippet");
    expect(definition).not.toHaveProperty("promptGuidelines");
  });

  it("unions parallel searches and restores selection from the current branch only", async () => {
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    await Promise.all([Promise.resolve().then(() => loader.activate([match("demo", "search")])), Promise.resolve().then(() => loader.activate([match("other", "search")]))]);
    expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned", "demo_search", "other_search"]);
    const firstBranch = h.entries[0];
    h.entries.splice(0, h.entries.length, firstBranch);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned", "demo_search"]);
    h.entries.length = 0;
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned"]);
  });

  it("keeps startup pins separate from tools selected by discovery", () => {
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    loader.persist();
    expect(h.entries.at(-1).data.selected).toEqual([]);
    const unpinned = { ...config, mcpServers: { ...config.mcpServers, demo: { ...config.mcpServers.demo, directTools: false } } };
    loader.sync(unpinned, cache());
    expect(h.api.getActiveTools()).not.toContain("demo_pinned");
    loader.activate([match("demo", "pinned")]);
    loader.sync(config, cache());
    loader.sync(unpinned, cache());
    expect(h.api.getActiveTools()).toContain("demo_pinned");
  });

  it.each([false, true])("retains explicit discovery of a startup pin after unpin and branch restore (native=%s)", native => {
    const h = host(native);
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.activate([match("demo", "pinned")])).toEqual([{ name: "demo_pinned" }]);
    expect(h.entries.at(-1).data.selected).toEqual([{ server: "demo", tool: "pinned" }]);
    const unpinned = { ...config, mcpServers: { ...config.mcpServers, demo: { ...config.mcpServers.demo, directTools: false } } };
    const ref = native ? { name: "pinned", namespace: "mcp_demo" } : { name: "demo_pinned" };
    loader.sync(unpinned, cache());
    expect(h.active()).toContainEqual(ref);
    loader.restore(h.ctx);
    loader.sync(unpinned, cache());
    expect(h.active()).toContainEqual(ref);
    if (native) h.api.setActiveToolReferences!([{ name: "mcp" }, { name: "read" }]);
    else h.api.setActiveTools(["mcp", "read"]);
    loader.persist();
    expect(h.entries.at(-1).data.selected).toEqual([]);
  });

  it("preserves manually disabled pins through schema refresh and a new loader", () => {
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    h.api.setActiveTools(["read", "mcp"]);
    const updated = cache();
    updated.servers.demo!.tools[0]!.outputSchema = { type: "object", properties: { changed: { type: "boolean" } } };
    loader.sync(config, updated);
    expect(h.api.getActiveTools()).toEqual(["read", "mcp"]);
    loader.persist();
    const fresh = host();
    fresh.entries.push(...h.entries);
    const reloaded = createToolLoader(fresh.api, () => null, () => null);
    reloaded.restore(fresh.ctx);
    reloaded.sync(config, cache());
    expect(fresh.api.getActiveTools()).toEqual(["mcp", "read"]);
  });

  it("uses exact native identities without losing other namespaces", () => {
    const h = host(true);
    h.api.registerTool({ name: "search", namespace: "outside" } as any);
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.native).toBe(true);
    expect(loader.activate([match("demo", "search"), match("other", "search")])).toEqual([
      { name: "search", namespace: "mcp_demo" }, { name: "search", namespace: "mcp_other" },
    ]);
    expect(h.active()).toContainEqual({ name: "search", namespace: "outside" });
    expect(h.active()).toContainEqual({ name: "demo_pinned" });
  });

  it.each([false, true])("honors the host allowlist (native=%s)", native => {
    const h = host(native, ref => ["mcp", "read"].includes(ref.name));
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.activate([match("demo", "search"), match("demo", "pinned")])).toEqual([]);
    expect(h.entries.at(-1).data.selected).toEqual([]);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
  });

  it("does not advertise colliding flat tools or reactivate removed tools", () => {
    const h = host();
    const loader = createToolLoader(h.api, () => null, () => null);
    loader.restore(h.ctx);
    const none = { ...config, settings: { toolPrefix: "none" as const } };
    loader.sync(none, cache());
    expect(h.definitions.has(refKey({ name: "search" }))).toBe(false);
    loader.sync(config, cache());
    loader.activate([match("demo", "search")]);
    loader.sync({ mcpServers: {} }, null);
    expect(loader.activate([match("demo", "search")])).toEqual([]);
    expect(h.api.getActiveTools()).toEqual(["mcp", "read"]);
  });
});
