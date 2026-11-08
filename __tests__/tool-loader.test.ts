import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolLoader } from "../tool-loader.ts";
import { computeServerHash } from "../metadata-cache.ts";
import type { DirectToolSpec, McpConfig, McpTool, MetadataCache } from "../types.ts";
import {
  createScriptingLoaderHost,
  loaderFixtureTool,
} from "./fixtures/scripting-runtime-loader.ts";

const hosts: Awaited<ReturnType<typeof createScriptingLoaderHost>>[] = [];
async function host(allow?: (ref: { name: string }) => boolean) {
  const instance = await createScriptingLoaderHost(allow);
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
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    const pins: DirectToolSpec[][] = [];
    expect(loader.sync(config, cache(), undefined, (specs) => void pins.push(specs))).toHaveLength(
      1,
    );
    expect(pins[0]?.map((spec) => spec.prefixedName)).toEqual(["demo_pinned"]);
    expect(h.definitions.size).toBe(3);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }, { name: "demo_pinned" }]);
    expect(definition(h, "demo_pinned")).not.toHaveProperty("exposure");
    const search = definition(h, "demo_search");
    expect(search.exposure).toBe("deferred");
    expect(search.parameters).toEqual(schema);
    expect(search.namespace).toEqual({ name: "mcp_demo" });
    expect(search).not.toHaveProperty("promptSnippet");
    expect(search).not.toHaveProperty("promptGuidelines");
    expect(definition(h, "other_search").exposure).toBe("deferred");
  });

  it("serializes guarded calls at the public execution boundary", async () => {
    const guardedHost = await host();
    const guarded = createToolLoader(
      guardedHost.api,
      () => null,
      () => null,
      async () => {
        /* Gate intentionally allows the call; registration must still be sequential. */
      },
    );
    guarded.sync(config, cache());
    expect(definition(guardedHost, "demo_search").executionMode).toBe("sequential");
  });

  it("re-registers a tool when its pin, schema or server instructions change", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.sync(config, cache());
    expect(loader.sync(unpinned, cache())).toEqual([]);
    expect(definition(h, "demo_pinned").exposure).toBe("deferred");
    loader.sync(config, cache());
    expect(definition(h, "demo_pinned")).not.toHaveProperty("exposure");
    const updated = cache();
    const first = updated.servers.demo?.tools[0];
    assert.ok(first);
    first.outputSchema = { type: "object", properties: { changed: { type: "boolean" } } };
    updated.servers.demo = { ...requireEntry(updated, "demo"), instructions: "Demo guidance" };
    loader.sync(config, updated);
    expect(definition(h, "demo_pinned").outputSchema).toMatchObject({
      anyOf: [{ properties: { changed: { type: "boolean" } } }, {}],
    });
    expect(definition(h, "demo_search").namespace).toEqual({
      name: "mcp_demo",
      instructions: "Demo guidance",
    });
  });

  it("uses unique public names without touching foreign tools", async () => {
    const h = await host();
    h.api.registerTool(loaderFixtureTool("search", { name: "outside" }));
    h.api.registerTool(loaderFixtureTool("mcp_script"));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.sync({ ...config, settings: { toolPrefix: "none" } }, cache());
    expect(definition(h, "search").namespace).toEqual({ name: "outside" });
    expect(h.definitions.has("pinned")).toBe(true);
    loader.sync(config, cache());
    expect([...h.definitions.keys()].sort()).toEqual([
      "demo_pinned",
      "demo_search",
      "mcp_script",
      "other_search",
      "pinned",
      "search",
    ]);
    expect(h.active()).toContainEqual({ name: "search" });
    expect(h.active()).toContainEqual({ name: "demo_pinned" });
  });

  it("reports no pins when the host excludes them", async () => {
    const h = await host((ref) => ["mcp", "read"].includes(ref.name));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    expect(loader.sync(config, cache())).toEqual([]);
  });

  it("withdraws tools that leave the catalog and restores them when they return", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.sync(config, cache());
    const shrunk = cache();
    shrunk.servers.demo = { ...requireEntry(shrunk, "demo"), tools: [tool("pinned")] };
    loader.sync(config, shrunk);
    expect(definition(h, "demo_search").exposure).toBe("hidden");
    expect(definition(h, "demo_pinned")).not.toHaveProperty("exposure");
    loader.sync(config, cache());
    expect(definition(h, "demo_search").exposure).toBe("deferred");
    loader.sync({ mcpServers: {} }, null);
    expect(definition(h, "demo_pinned").exposure).toBe("hidden");
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
  });

  it("registers nothing when direct tools are suppressed by the environment", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    expect(loader.sync(config, cache(), null)).toEqual([]);
    expect(h.definitions.size).toBe(0);
  });
});
