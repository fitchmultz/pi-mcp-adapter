import { describe, expect, it } from "vitest";
import { resolvePinnedTools } from "./fixtures/pinned-tools.ts";
import { computeServerHash, reconstructToolMetadata, serializeResources, serializeTools } from "../metadata-cache.ts";
import { rankToolMatches } from "../search-ranking.ts";
import { buildToolMetadata, findToolByName } from "../tool-metadata.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpTool, ServerCacheEntry, ServerEntry } from "../types.ts";

function cacheEntry(tools: McpTool[], definition: ServerEntry = {}): ServerCacheEntry {
  return {
    configHash: computeServerHash(definition),
    cachedAt: Date.now(),
    tools: serializeTools(tools),
    resources: [],
  };
}

const descriptor = {
  name: "list_issues",
  title: "Browse issues",
  description: "List issues in the workspace",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    title: "Issue filters",
    properties: {
      query: { type: "string", description: "Search issue title or description", minLength: 2, maxLength: 100, pattern: "\\S", default: "open" },
      state: { $ref: "#/$defs/state" },
      limit: { type: "integer", minimum: 1, maximum: 250 },
    },
    $defs: { state: { enum: ["backlog", "triage"] } },
    required: ["query"],
    additionalProperties: { type: "string" },
    allOf: [{ if: { required: ["state"] }, then: { required: ["limit"] } }],
  },
  outputSchema: {
    type: "object" as const,
    properties: { issues: { type: "array", items: { type: "string" }, minItems: 0 } },
    required: ["issues"],
    additionalProperties: false,
  },
  annotations: { title: "Issue listing", readOnlyHint: true, idempotentHint: true },
  icons: [{ src: "https://example.test/icon.png", mimeType: "image/png" }],
  _meta: {
    ui: { resourceUri: "ui://issues", visibility: ["model", "app"], "pi-mcp-adapter.streamMode": "stream-first" },
    "example/guidance": { preserve: true },
  },
};

describe("canonical tool catalog", () => {
  it("retains distinct identities even when their legacy aliases collide", () => {
    const metadata = buildToolMetadata([{ name: "find.item" }, { name: "find_item" }], [
      { name: "Guide", uri: "docs://one" }, { name: "Guide", uri: "docs://two" },
    ], {}, "demo", "server").metadata;
    expect(metadata.map(tool => tool.originalName)).toEqual(["find.item", "find_item", "read_guide", "read_guide"]);
    expect(metadata.filter(tool => tool.resourceUri).map(tool => tool.resourceUri)).toEqual(["docs://one", "docs://two"]);
    expect(findToolByName(metadata, "demo_find_item")).toBeUndefined();
    expect(findToolByName(metadata, "demo_read_guide")).toBeUndefined();
  });

  it("preserves complete raw descriptors through cache, live metadata and direct selection", () => {
    const definition = { directTools: true };
    const entry = cacheEntry([descriptor], definition);
    expect(entry.tools).toEqual([descriptor]);
    expect(entry.tools[0]).not.toHaveProperty("uiResourceUri");
    const stored = JSON.parse(JSON.stringify(entry)) as ServerCacheEntry;
    const live = buildToolMetadata([descriptor], [], definition, "linear", "server").metadata;
    const cached = reconstructToolMetadata("linear", stored, "server", definition);
    expect(cached).toEqual(live);
    expect(live[0]).toMatchObject({
      ...descriptor,
      name: "linear_list_issues",
      originalName: "list_issues",
      uiResourceUri: "ui://issues",
      uiVisibility: ["model", "app"],
      uiStreamMode: "stream-first",
    });
    expect(live[0]?.inputSchema).toBe(descriptor.inputSchema);
    const direct = resolvePinnedTools({ mcpServers: { linear: definition } }, { version: 1, servers: { linear: stored } }, "server");
    const { name, ...metadata } = cached[0]!;
    expect(direct).toEqual([{ ...metadata, serverName: "linear", prefixedName: name }]);
  });

  it("applies visibility and configured filters identically to live, cached and pinned tools", () => {
    const tools = [
      { name: "visible" },
      { name: "app_only", _meta: { ui: { visibility: ["app"] } } },
      { name: "invalid", _meta: { ui: { visibility: ["model", "unknown"] } } },
      { name: "empty", _meta: { ui: { visibility: [] } } },
      { name: "malformed", _meta: { ui: { visibility: "model" } } },
      { name: "both", _meta: { ui: { visibility: ["model", "app"] } } },
      { name: "excluded" },
    ];
    const definition = { directTools: true, includeTools: ["demo_*"], excludeTools: ["excluded"] };
    const entry = cacheEntry(tools, definition);
    const live = buildToolMetadata(tools, [], definition, "demo", "server").metadata;
    expect(live.map(tool => tool.originalName)).toEqual(["visible", "both"]);
    expect(reconstructToolMetadata("demo", entry, "server", definition)).toEqual(live);
    const state = { config: { mcpServers: { demo: definition } }, toolMetadata: new Map([["demo", live]]) } as McpExtensionState;
    expect(rankToolMatches(state, "app only invalid empty malformed")).toEqual([]);
    const config = { mcpServers: { demo: definition } };
    const cache = { version: 1, servers: { demo: entry } };
    expect(resolvePinnedTools(config, cache, "server").map(tool => tool.originalName)).toEqual(["visible", "both"]);
    expect(resolvePinnedTools(config, cache, "server", ["demo/app_only"])).toEqual([]);
    definition.directTools = false;
    expect(resolvePinnedTools(config, cache, "server", ["demo/visible"])).toHaveLength(1);
  });

  it("reconstructs old flattened UI cache records without exposing app-only tools", () => {
    const definition = { directTools: true };
    const entry: ServerCacheEntry = {
      ...cacheEntry([], definition),
      tools: [
        { name: "legacy", uiResourceUri: "ui://legacy", uiVisibility: ["model"], uiStreamMode: "eager" },
        { name: "app_only", uiVisibility: ["app"] },
        { name: "invalid", uiVisibility: [] },
        { name: "plain" },
      ],
    };
    const metadata = reconstructToolMetadata("demo", entry, "server", definition);
    expect(metadata.map(tool => tool.originalName)).toEqual(["legacy", "plain"]);
    expect(metadata[0]).toMatchObject({ uiResourceUri: "ui://legacy", uiVisibility: ["model"], uiStreamMode: "eager" });
    expect(resolvePinnedTools({ mcpServers: { demo: definition } }, { version: 1, servers: { demo: entry } }, "server").map(tool => tool.originalName)).toEqual(["legacy", "plain"]);
  });

  it("keeps resource aliases readable but never registers them as pinned functions", () => {
    const definition = { directTools: true, includeTools: ["demo_*"], excludeTools: ["read_secret"] };
    const resources = [
      { name: "guide", title: "Guide", uri: "docs://guide", mimeType: "text/plain", _meta: { source: "docs" } },
      { name: "secret", uri: "docs://secret" },
    ];
    const entry = { ...cacheEntry([{ name: "get_guide" }], definition), resources: serializeResources(resources) };
    expect(entry.resources).toEqual(resources);
    expect(reconstructToolMetadata("demo", entry, "server", definition).find(tool => tool.resourceUri)?.resourceDescriptor).toEqual(resources[0]);
    expect(reconstructToolMetadata("demo", entry, "server", definition)).toContainEqual({
      name: "demo_read_guide", originalName: "read_guide", description: "Read resource: docs://guide", resourceUri: "docs://guide", resourceDescriptor: resources[0],
    });
    expect(resolvePinnedTools({ mcpServers: { demo: definition } }, { version: 1, servers: { demo: entry } }, "server").map(tool => tool.originalName)).toEqual(["get_guide"]);
    expect(resolvePinnedTools({ mcpServers: { demo: definition } }, { version: 1, servers: { demo: entry } }, "server", ["demo/read_guide"])).toEqual([]);
  });

  it("finds issue listing from parameter guidance without changing exact identity lookup", () => {
    const metadata = buildToolMetadata([descriptor, { name: "get_issue", description: "Get an issue" }], [], {}, "linear", "server").metadata;
    const state = { config: { mcpServers: { linear: {} } }, toolMetadata: new Map([["linear", metadata]]) } as McpExtensionState;
    expect(rankToolMatches(state, "search issues", "linear")[0]?.tool.originalName).toBe("list_issues");
    expect(rankToolMatches(state, "triage", "linear").map(match => match.tool.originalName)).toEqual(["list_issues"]);
    expect(findToolByName(metadata, "linear_list_issues")?.originalName).toBe("list_issues");
    expect(findToolByName(metadata, "linear_list_issuse")).toBeUndefined();
    expect(findToolByName(metadata, "search issues")).toBeUndefined();
  });
});
