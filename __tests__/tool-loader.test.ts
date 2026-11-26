import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolLoader } from "../tool-loader.ts";
import { computeServerHash } from "../metadata-cache.ts";
import type { DirectToolSpec, McpConfig, McpTool, MetadataCache } from "../types.ts";
import { createLoaderHost, loaderFixtureTool } from "./fixtures/loader-host.ts";

const hosts: Awaited<ReturnType<typeof createLoaderHost>>[] = [];
async function host(allow?: (ref: { name: string }) => boolean) {
  const instance = await createLoaderHost(allow);
  hosts.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((instance) => instance.dispose()));
  vi.restoreAllMocks();
});
const config: McpConfig = {
  mcpServers: {
    demo: { command: "unused", directTools: ["pinned"] },
    other: { command: "unused" },
  },
};
const unpinned: McpConfig = {
  ...config,
  mcpServers: { ...config.mcpServers, demo: { ...config.mcpServers.demo, directTools: false } },
};
const schema = {
  type: "object" as const,
  properties: { query: { type: "string", description: "Exact query", enum: ["one", "two"] } },
  additionalProperties: false,
};
const tool = (name: string): McpTool => ({
  name,
  description: name,
  inputSchema: schema,
  outputSchema: { type: "object", properties: { result: { type: "number" } } },
});
function cache(): MetadataCache {
  return {
    version: 2,
    servers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([server, entry]) => [
        server,
        {
          configHash: computeServerHash(entry),
          tools: server === "demo" ? [tool("pinned"), tool("search")] : [tool("search")],
          resources: [],
          cachedAt: Date.now(),
        },
      ]),
    ),
  };
}
function requireEntry(entries: MetadataCache, server: string) {
  const entry = entries.servers[server];
  if (!entry) {
    throw new Error(`Missing ${server} cache entry`);
  }
  return entry;
}
function definition(h: Awaited<ReturnType<typeof host>>, name: string) {
  const found = h.definitions.get(name);
  if (!found) {
    throw new Error(`Missing ${name} definition`);
  }
  return found;
}

describe("MCP catalog registration", () => {
  it("registers pins as active direct tools and the rest of the catalog deferred", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    const pins: DirectToolSpec[][] = [];
    expect(loader.sync(config, cache(), undefined, (specs) => void pins.push(specs))).toHaveLength(
      1,
    );
    expect(pins[0]?.map((spec) => spec.prefixedName)).toEqual(["mcp__demo__pinned"]);
    expect(h.definitions.size).toBe(3);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }, { name: "mcp__demo__pinned" }]);
    expect(definition(h, "mcp__demo__pinned")).not.toHaveProperty("exposure");
    const search = definition(h, "mcp__demo__search");
    expect(search.exposure).toBe("deferred");
    expect(search.parameters).toEqual(schema);
    expect(search.namespace).toEqual({ name: "mcp_demo", aliases: ["demo"] });
    expect(search).not.toHaveProperty("promptSnippet");
    expect(search).not.toHaveProperty("promptGuidelines");
    expect(definition(h, "mcp__other__search").exposure).toBe("deferred");
  });

  it("serializes guarded calls at the public execution boundary", async () => {
    const guardedHost = await host();
    const guarded = createToolLoader(guardedHost.api, {
      getState: () => null,
      getInitPromise: () => null,
      async beforeExecute() {
        /* Gate intentionally allows the call; registration must still be sequential. */
      },
    });
    guarded.sync(config, cache());
    expect(definition(guardedHost, "mcp__demo__search").executionMode).toBe("sequential");
  });

  it("attaches CallToolResult outputSchema without codemode description boilerplate and forwards server description", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    const entries = cache();
    const other = requireEntry(entries, "other");
    other.tools = [{ name: "raw-search", description: "Raw search", inputSchema: schema }];
    const withDescription: McpConfig = {
      mcpServers: {
        ...config.mcpServers,
        other: { ...config.mcpServers.other, description: "Other knowledge base" },
      },
    };
    loader.sync(withDescription, entries);

    expect(definition(h, "mcp__demo__search").description).toBe("search");
    const unstructured = definition(h, "mcp__other__raw-search");
    expect(unstructured.description).toBe("Raw search");
    expect(unstructured.description).not.toContain("Codemode:");
    expect(unstructured.outputSchema).toMatchObject({
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "array" },
        structuredContent: {},
        isError: { type: "boolean" },
      },
    });
    expect(unstructured.namespace).toEqual({
      name: "mcp_other",
      aliases: ["other"],
      description: "Other knowledge base",
    });
  });

  it("re-registers a tool when its pin, schema, server description, or server instructions change", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    loader.sync(config, cache());
    expect(loader.sync(unpinned, cache())).toEqual([]);
    expect(definition(h, "mcp__demo__pinned").exposure).toBe("deferred");
    expect(h.active()).not.toContainEqual({ name: "mcp__demo__pinned" });
    loader.sync(config, cache());
    expect(definition(h, "mcp__demo__pinned")).not.toHaveProperty("exposure");
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
    const updated = cache();
    const first = updated.servers.demo?.tools[0];
    assert.ok(first);
    first.outputSchema = { type: "object", properties: { changed: { type: "boolean" } } };
    updated.servers.demo = { ...requireEntry(updated, "demo"), instructions: "Demo guidance" };
    const describedConfig: McpConfig = {
      mcpServers: {
        ...config.mcpServers,
        demo: { ...config.mcpServers.demo, description: "Demo server" },
      },
    };
    loader.sync(describedConfig, updated);
    expect(definition(h, "mcp__demo__pinned").outputSchema).toMatchObject({
      type: "object",
      properties: {
        structuredContent: { type: "object", properties: { changed: { type: "boolean" } } },
      },
    });
    expect(definition(h, "mcp__demo__search").namespace).toEqual({
      name: "mcp_demo",
      aliases: ["demo"],
      description: "Demo server",
      instructions: "Demo guidance",
    });
  });

  it("uses unique public names with hash disambiguation without touching foreign tools", async () => {
    const h = await host();
    h.api.registerTool(loaderFixtureTool("search", { name: "outside" }));
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    loader.sync({ ...config, settings: { toolPrefix: "none" } }, cache());
    expect(definition(h, "search").namespace).toEqual({ name: "outside" });
    expect(h.definitions.has("pinned")).toBe(true);
    const disambiguated = [...h.definitions.keys()]
      .filter((name) => name.startsWith("search_"))
      .sort();
    expect(disambiguated).toHaveLength(2);
    expect(
      disambiguated
        .map((name) => definition(h, name).namespace?.name ?? "")
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["mcp_demo", "mcp_other"]);
    loader.sync(config, cache());
    expect([...h.definitions.keys()].sort()).toEqual([
      "mcp__demo__pinned",
      "mcp__demo__search",
      "mcp__other__search",
      "pinned",
      "search",
      ...disambiguated,
    ]);
    expect(h.active()).toContainEqual({ name: "search" });
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
  });

  it("reports no pins when the host excludes them", async () => {
    const h = await host((ref) => ["mcp", "read"].includes(ref.name));
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    expect(loader.sync(config, cache())).toEqual([]);
  });

  it("keeps a live pin deselection until a session boundary, which keeps a recorded removal", async () => {
    const h = await host();
    let recorded = false;
    const loader = createToolLoader(h.api, {
      getState: () => null,
      getInitPromise: () => null,
      removedOnBranch: (name) => recorded && name === "mcp__demo__pinned",
    });
    loader.sync(config, cache());
    h.api.setActiveTools(["mcp", "read"]);
    const refreshed = cache();
    refreshed.servers.demo = { ...requireEntry(refreshed, "demo"), instructions: "Changed" };
    loader.sync(config, refreshed);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
    recorded = true;
    loader.settlePins();
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
    recorded = false;
    loader.settlePins();
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
    // A boundary while the pin is withdrawn decides its return from the branch it reaches.
    loader.sync({ mcpServers: {} }, null);
    h.api.setActiveTools(["mcp", "read"]);
    recorded = true;
    loader.settlePins();
    loader.sync(config, cache());
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
    loader.sync({ mcpServers: {} }, null);
    recorded = false;
    loader.settlePins();
    // A prompt sent while the pin is withdrawn records it removed; that is not a deselection.
    recorded = true;
    loader.sync(config, cache());
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
  });

  it("re-activates a deferred tool that returns pinned after leaving the catalog", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, {
      getState: () => null,
      getInitPromise: () => null,
      removedOnBranch: () => true,
    });
    loader.sync(unpinned, cache());
    expect(definition(h, "mcp__demo__pinned").exposure).toBe("deferred");
    loader.sync({ mcpServers: {} }, null);
    expect(definition(h, "mcp__demo__pinned").exposure).toBe("hidden");
    // It never had a pin to lose, so its return is a gain even with a recorded removal.
    loader.sync(config, cache());
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
  });

  it("withdraws tools that leave the catalog and restores them when they return", async () => {
    const h = await host();
    let recorded = false;
    const loader = createToolLoader(h.api, {
      getState: () => null,
      getInitPromise: () => null,
      removedOnBranch: (name) => recorded && name === "mcp__demo__pinned",
    });
    loader.sync(config, cache());
    const shrunk = cache();
    shrunk.servers.demo = { ...requireEntry(shrunk, "demo"), tools: [tool("pinned")] };
    loader.sync(config, shrunk);
    expect(definition(h, "mcp__demo__search").exposure).toBe("hidden");
    expect(definition(h, "mcp__demo__pinned")).not.toHaveProperty("exposure");
    loader.sync(config, cache());
    expect(definition(h, "mcp__demo__search").exposure).toBe("deferred");
    loader.sync({ mcpServers: {} }, null);
    expect(definition(h, "mcp__demo__pinned").exposure).toBe("hidden");
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
    // The next prompt records the withdrawn pin as removed, which is not a user deselection.
    recorded = true;
    loader.sync(config, cache());
    expect(h.active()).toContainEqual({ name: "mcp__demo__pinned" });
    // A pin the user deselected stays off when it leaves and returns.
    h.api.setActiveTools(["mcp", "read"]);
    loader.sync({ mcpServers: {} }, null);
    loader.sync(config, cache());
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
    loader.settlePins();
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
  });

  it("registers nothing when direct tools are suppressed by the environment", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    expect(loader.sync(config, cache(), null)).toEqual([]);
    expect(h.definitions.size).toBe(0);
  });

  it("refreshes deferred catalog tools via syncDeferred while keeping pins and active tools frozen", async () => {
    const h = await host();
    const loader = createToolLoader(h.api, { getState: () => null, getInitPromise: () => null });
    loader.sync(config, cache());
    // Simulate tool_search activating one deferred tool before freezing.
    h.api.setActiveTools([...h.active().map((entry) => entry.name), "mcp__demo__search"]);
    const activeBefore = h.active();

    const updated = cache();
    const demo = requireEntry(updated, "demo");
    demo.tools = [
      { ...tool("pinned"), description: "pinned changed" },
      { ...tool("search"), description: "active deferred changed" },
      { ...tool("fresh"), description: "new deferred tool" },
    ];
    const other = requireEntry(updated, "other");
    other.tools = [];

    loader.syncDeferred(config, updated);

    // Pinned and active tools stay untouched; inactive deferred tools add/withdraw cleanly.
    expect(h.active()).toEqual(activeBefore);
    expect(definition(h, "mcp__demo__pinned").description).toBe("pinned");
    expect(definition(h, "mcp__demo__search").description).toBe("search");
    expect(definition(h, "mcp__demo__fresh").exposure).toBe("deferred");
    expect(definition(h, "mcp__other__search").exposure).toBe("hidden");
  });
});
