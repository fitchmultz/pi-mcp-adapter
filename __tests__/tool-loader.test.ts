import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolLoader } from "../tool-loader.ts";
import { computeServerHash } from "../metadata-cache.ts";
import type { McpConfig, McpTool } from "../types.ts";
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
const refKey = (ref: { name: string }) => ref.name;
const config: McpConfig = {
  mcpServers: {
    demo: { command: "unused", directTools: ["pinned"] },
    other: { command: "unused" },
  },
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
function cache() {
  return {
    version: 2,
    servers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([server, definition]) => [
        server,
        {
          configHash: computeServerHash(definition),
          tools: server === "demo" ? [tool("pinned"), tool("search")] : [tool("search")],
          resources: [],
          cachedAt: Date.now(),
        },
      ]),
    ),
  };
}
const match = (server: string, originalName: string) => ({
  server,
  tool: {
    ...tool(originalName),
    description: originalName,
    name: `${server}_${originalName}`,
    originalName,
  },
});

describe("MCP typed loader", () => {
  it.each([10, 43_000])(
    "restores the first valid backward snapshot across %s unrelated entries",
    async (size) => {
      const h = await host();
      h.append(...Array.from({ length: size }, () => ({ type: "message" as const })));
      h.append({
        type: "custom",
        customType: "mcp-tool-selection",
        data: { selected: [{ server: "demo", tool: "search" }] },
      });
      h.append({
        type: "custom",
        customType: "mcp-tool-selection",
        data: { selected: "corrupt" },
      });
      h.append({ type: "message" }, { type: "message" });
      const loader = createToolLoader(
        h.api,
        () => null,
        () => null,
      );
      loader.restore(h.ctx);
      loader.sync(config, cache());
      expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned", "demo_search"]);
      expect(h.ctx.sessionManager.getEntry).toHaveBeenCalledTimes(4);
      // An empty complete snapshot must not resurrect older selections.
      h.append({
        type: "custom",
        customType: "mcp-tool-selection",
        data: { selected: [], inactive: [{ server: "demo", tool: "pinned" }] },
      });
      loader.restore(h.ctx);
      loader.sync(config, cache());
      expect(h.api.getActiveTools()).toEqual(["mcp", "read"]);
      expect(h.ctx.sessionManager.getEntry).toHaveBeenCalledTimes(5);
    },
  );

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
    guarded.restore(guardedHost.ctx);
    guarded.sync(config, cache());
    const registered = guardedHost.definitions.get("demo_search");
    if (!registered) {
      throw new Error("Missing demo_search definition");
    }
    expect(registered.executionMode).toBe("sequential");
  });

  it("registers real schemas silently but activates only pins until discovery", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.definitions.size).toBe(3);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }, { name: "demo_pinned" }]);
    const definition = h.definitions.get(refKey({ name: "demo_search" }));
    if (!definition) {
      throw new Error("Missing demo_search definition");
    }
    expect(definition.parameters).toEqual(schema);
    expect(definition).not.toHaveProperty("promptSnippet");
    expect(definition).not.toHaveProperty("promptGuidelines");
  });

  it("unions parallel searches and restores selection from the current branch only", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    await Promise.all([
      Promise.resolve().then(() => loader.activate([match("demo", "search")])),
      Promise.resolve().then(() => loader.activate([match("other", "search")])),
    ]);
    expect(h.api.getActiveTools()).toEqual([
      "mcp",
      "read",
      "demo_pinned",
      "demo_search",
      "other_search",
    ]);
    const firstBranch = h.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "mcp-tool-selection",
    );
    if (!firstBranch) {
      throw new Error("Missing first branch snapshot");
    }
    h.manager.branch(firstBranch.id);
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned", "demo_search"]);
    h.manager.resetLeaf();
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(h.api.getActiveTools()).toEqual(["mcp", "read", "demo_pinned"]);
  });

  it("keeps startup pins separate from tools selected by discovery", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    loader.persist();
    expect(h.lastSelection().selected).toEqual([]);
    const unpinned = {
      ...config,
      mcpServers: { ...config.mcpServers, demo: { ...config.mcpServers.demo, directTools: false } },
    };
    loader.sync(unpinned, cache());
    expect(h.api.getActiveTools()).not.toContain("demo_pinned");
    loader.activate([match("demo", "pinned")]);
    loader.sync(config, cache());
    loader.sync(unpinned, cache());
    expect(h.api.getActiveTools()).toContain("demo_pinned");
  });

  it("retains explicit discovery of a startup pin after unpin and branch restore", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.activate([match("demo", "pinned")])).toEqual([{ name: "demo_pinned" }]);
    expect(h.lastSelection().selected).toEqual([{ server: "demo", tool: "pinned" }]);
    const unpinned = {
      ...config,
      mcpServers: { ...config.mcpServers, demo: { ...config.mcpServers.demo, directTools: false } },
    };
    const ref = { name: "demo_pinned" };
    loader.sync(unpinned, cache());
    expect(h.active()).toContainEqual(ref);
    loader.restore(h.ctx);
    loader.sync(unpinned, cache());
    expect(h.active()).toContainEqual(ref);
    h.api.setActiveTools(["mcp", "read"]);
    loader.persist();
    expect(h.lastSelection().selected).toEqual([]);
  });

  it("preserves manually disabled pins through schema refresh and a new loader", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    // Native Pi retains the order of tools that remain active; re-enable mcp after read.
    h.api.setActiveTools(["read"]);
    h.api.setActiveTools(["read", "mcp"]);
    const updated = cache();
    const first = updated.servers.demo?.tools[0];
    assert.ok(first);
    first.outputSchema = {
      type: "object",
      properties: { changed: { type: "boolean" } },
    };
    loader.sync(config, updated);
    expect(h.api.getActiveTools()).toEqual(["read", "mcp"]);
    loader.persist();
    const fresh = await host();
    fresh.copyHistory(h.entries);
    const reloaded = createToolLoader(
      fresh.api,
      () => null,
      () => null,
    );
    reloaded.restore(fresh.ctx);
    reloaded.sync(config, cache());
    expect(fresh.api.getActiveTools()).toEqual(["mcp", "read"]);
  });

  it("uses unique public names without losing other namespaces", async () => {
    const h = await host();
    h.api.registerTool(loaderFixtureTool("search", { name: "outside" }));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.activate([match("demo", "search"), match("other", "search")])).toEqual([
      { name: "demo_search" },
      { name: "other_search" },
    ]);
    expect(h.active()).toContainEqual({ name: "search" });
    expect(h.active()).toContainEqual({ name: "demo_pinned" });
  });

  it("unions gateway activation with typed and foreign tools through late registration", async () => {
    const h = await host();
    h.api.registerTool(loaderFixtureTool("mcp_search"));
    h.api.registerTool(loaderFixtureTool("foreign_mcp"));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.registerFeature("gateway", loaderFixtureTool("mcp"));
    loader.registerFeature("script", loaderFixtureTool("mcp_script"));
    h.api.setActiveTools(["read", "mcp_search", "foreign_mcp"]);
    const gateways = () => ({ gateway: {}, script: {} });
    loader.restore(h.ctx);
    loader.sync(config, cache(), undefined, gateways);
    expect(h.active()).not.toContainEqual({ name: "mcp" });
    await Promise.all([
      Promise.resolve().then(() => loader.activate([match("demo", "search")], ["script"])),
      Promise.resolve().then(() => loader.activate([], ["gateway"])),
    ]);
    const expected = [
      { name: "foreign_mcp" },
      { name: "demo_search" },
      { name: "mcp" },
      { name: "mcp_script" },
    ];
    for (const ref of expected) {
      expect(h.active()).toContainEqual(ref);
    }
    const updated = cache();
    const other = updated.servers.other;
    assert.ok(other);
    other.tools.push(tool("late"));
    loader.sync(config, updated, undefined, gateways);
    for (const ref of expected) {
      expect(h.active()).toContainEqual(ref);
    }
    expect(h.active()).not.toContainEqual({ name: "other_late" });
    // A config restriction removes only the adapter's own gateway.
    loader.sync(config, updated, undefined, () => ({ script: {} }));
    expect(loader.activate([], ["gateway"])).toEqual([]);
    expect(h.active()).not.toContainEqual({ name: "mcp" });
    expect(h.active()).toContainEqual({ name: "foreign_mcp" });
    expect(h.lastSelection().features).toEqual(["script"]);
  });

  it("does not remove a same-name definition it never registered when the adapter feature is disabled", async () => {
    const h = await host();
    h.api.registerTool(loaderFixtureTool("mcp_script"));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.sync({ mcpServers: {}, settings: { scriptMode: false } }, null, undefined, () => ({}));
    expect(h.api.getActiveTools()).toContain("mcp_script");
    expect(loader.activate([], ["script"])).toEqual([]);
  });

  it("honors the host allowlist", async () => {
    const h = await host((ref) => ["mcp", "read"].includes(ref.name));
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
    loader.restore(h.ctx);
    loader.sync(config, cache());
    expect(loader.activate([match("demo", "search"), match("demo", "pinned")])).toEqual([]);
    expect(h.lastSelection().selected).toEqual([]);
    expect(h.active()).toEqual([{ name: "mcp" }, { name: "read" }]);
  });

  it("does not advertise colliding flat tools or reactivate removed tools", async () => {
    const h = await host();
    const loader = createToolLoader(
      h.api,
      () => null,
      () => null,
    );
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
