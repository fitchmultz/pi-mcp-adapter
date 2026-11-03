import assert from "node:assert/strict";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { firstText, parsedRecord, proxyRuntimeConnection } from "./fixtures/proxy-runtime.ts";
import { describe, expect, it, vi } from "vitest";
import {
  executeCall,
  executeDescribe,
  executeList,
  executeSearch,
  executeStatus,
} from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";

function createState(): McpExtensionState {
  return createTestState({
    config: {
      mcpServers: {
        demo: { command: "npx", args: ["demo"] },
      },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_search",
            originalName: "search",
            description: "Search demo records",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "demo_find",
            originalName: "find",
            description: "Find demo records",
          },
        ],
      ],
    ]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
  });
}

describe("proxy discovery", () => {
  const anyNumber: unknown = expect.any(Number);
  it("returns exact input/output schemas and guidance in describe and search content", () => {
    const state = createState();
    const tool = state.toolMetadata.get("demo")?.[0];
    assert.ok(tool);
    tool.inputSchema = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Unique lookup guidance",
          pattern: "^[a-z]+$",
          default: "open",
        },
      },
      additionalProperties: false,
    };
    tool.outputSchema = {
      type: "object",
      properties: { total: { type: "integer" } },
      required: ["total"],
    };
    tool.title = "Record search";
    tool._meta = { "example/hint": "retain" };
    const described = parsedRecord(firstText(executeDescribe(state, "demo_search")));
    expect(described).toMatchObject({
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      title: tool.title,
      _meta: tool._meta,
    });
    expect(described).not.toHaveProperty("inputTypeScript");
    const text = firstText(executeSearch(state, "unique lookup"));
    const searched = parsedRecord(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(searched.inputSchema).toEqual(tool.inputSchema);
    expect(searched.outputSchema).toEqual(tool.outputSchema);
  });

  it("reports partial catalog coverage and keeps resources out of the tool inventory", () => {
    const state = createState();
    state.config.mcpServers.unknown = { command: "not-started" };
    const metadata = state.toolMetadata.get("demo");
    assert.ok(metadata);
    metadata.push({
      name: "demo_read_guide",
      originalName: "read_guide",
      description: "Guide",
      resourceUri: "docs://guide",
    });
    const search = executeSearch(state, "guide");
    expect(search.details).toMatchObject({
      count: 0,
      coverage: { complete: false, unknownServers: ["unknown"] },
    });
    expect(firstText(search)).toContain("Catalog is incomplete");
    expect(executeList(state, "demo").details.count).toBe(2);
    expect(executeStatus(state).details.totalTools).toBe(2);
  });

  it("searches MCP tools only", () => {
    const result = executeSearch(createState(), "read");

    expect(firstText(result)).toBe('No tools matching "read"');
    expect(result.details).toMatchObject({ count: 0, matches: [] });
  });

  it("treats a long query as plain text rather than a pattern", () => {
    const result = executeSearch(createState(), ".*[unknown](terms)? ".repeat(40));

    expect(result.details).toMatchObject({ count: 0 });
  });

  it("paginates server listings", () => {
    const result = executeList(createState(), "demo", 1, 0);

    expect(firstText(result)).toContain("demo_search");
    expect(firstText(result)).not.toContain("demo_find");
    expect(firstText(result)).toContain(
      '1-1 of 2 — mcp({ action: "list", server: "demo", limit: 1, offset: 1 }) for more',
    );
    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      tools: ["demo_search"],
    });
  });

  it("explains an out-of-range server-list offset", () => {
    const result = executeList(createState(), "demo", 1, 99);

    expect(firstText(result)).toBe(
      'No tools at offset 99; "demo" has 2 tools. Retry with mcp({ action: "list", server: "demo", limit: 1, offset: 0 }).',
    );
    expect(result.details).toMatchObject({ error: "offset_out_of_range", count: 2, tools: [] });
  });

  it("explains lazy connection state", () => {
    const result = executeStatus(createState());

    expect(firstText(result)).toContain(
      "MCP: 0/1 connected, 2 tools available (calls connect lazily)",
    );
  });

  it("returns ranked paged search details", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 0);

    expect(firstText(result)).toContain(
      '1-1 of 2 — mcp({ action: "search", query: "demo", includeSchemas: false, limit: 1, offset: 1 }) for more',
    );

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      matches: [{ server: "demo", tool: "demo_find", score: anyNumber }],
    });
  });

  it("keeps the default schema mode implicit in search continuations", () => {
    const result = executeSearch(createState(), "demo", undefined, undefined, 1, 0);

    expect(firstText(result)).not.toContain("includeSchemas");
  });

  it("preserves compact server-scoped search in continuation and retry calls", () => {
    const state = createState();
    const page = executeSearch(state, "demo", "demo", false, 1, 0);
    const retry = executeSearch(state, "demo", "demo", false, 1, 99);

    expect(firstText(page)).toContain(
      'mcp({ action: "search", query: "demo", server: "demo", includeSchemas: false, limit: 1, offset: 1 })',
    );
    expect(firstText(retry)).toContain(
      'mcp({ action: "search", query: "demo", server: "demo", includeSchemas: false, limit: 1, offset: 0 })',
    );
  });

  it("paginates search results without changing their order", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 1);

    expect(firstText(result)).toContain("2-2 of 2 — end");
    expect(result.details).toMatchObject({
      count: 2,
      hasMore: false,
      nextOffset: null,
      matches: [{ server: "demo", tool: "demo_search", score: anyNumber }],
    });
  });

  it("explains an out-of-range search offset", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 99);

    expect(firstText(result)).toContain("No search results at offset 99; 2 tools match");
    expect(result.details).toMatchObject({ error: "offset_out_of_range", count: 2, matches: [] });
  });

  it("scopes prefix-mangled suggestions to the matching server", () => {
    const state = createState();
    state.config.mcpServers.noise = { command: "npx", args: ["noise"] };
    state.toolMetadata.set("noise", [
      {
        name: "noise_search",
        originalName: "search",
        description: "Search demo records",
      },
    ]);

    const result = executeDescribe(state, "demo_sear");

    expect(result.details).toMatchObject({ suggestions: ["demo_search"] });
    expect(firstText(result)).toContain(
      'Inspect with mcp({ action: "describe", tool: "demo_search" })',
    );
  });

  it("keeps cached prefixed call typos bounded without connecting", async () => {
    const state = createState();
    const connect = vi.spyOn(state.manager, "connect");

    const result = await executeCall(state, "demo_sear");

    expect(connect).not.toHaveBeenCalled();
    expect(firstText(result)).toContain("Did you mean: demo_search");
    expect(firstText(result)).not.toContain("demo_find");
    expect(firstText(result)).toContain('mcp({ action: "connect", server: "demo" })');
    expect(firstText(result).length).toBeLessThan(300);

    const missing = await executeCall(state, "demo_new_tool");
    expect(firstText(missing)).toContain('mcp({ action: "connect", server: "demo" })');
    expect(connect).not.toHaveBeenCalled();
  });

  it("prefers the explicit server's original tool name over another server's exact name", async () => {
    const state = createState();
    state.config.mcpServers.noise = { command: "noise", toolPrefix: "none" };
    state.toolMetadata.set("noise", [
      { name: "search", originalName: "search", description: "Search noise" },
    ]);

    const definition = state.config.mcpServers.demo;
    assert.ok(definition);
    const connection = await proxyRuntimeConnection(definition);
    const callTool = vi.spyOn(connection.client, "callTool");
    vi.spyOn(state.manager, "getConnection").mockImplementation((server) =>
      server === "demo" ? connection : undefined,
    );
    const result = await executeCall(state, "search", undefined, "demo");

    expect(result.details).toMatchObject({ server: "demo", tool: "search" });
    expect(callTool).toHaveBeenCalledOnce();
    expect(firstText(result)).toBe("demo result");
  });

  it("normalizes the explicit server's original tool name before redirecting", async () => {
    const state = createState();
    state.config.mcpServers.noise = { command: "noise", toolPrefix: "none" };
    state.toolMetadata.set("demo", [
      { name: "demo_list_issues", originalName: "list_issues", description: "List demo issues" },
    ]);
    state.toolMetadata.set("noise", [
      { name: "list_issues", originalName: "list_issues", description: "List noise issues" },
    ]);

    const result = await executeCall(state, "list-issues", undefined, "demo");

    expect(result.details).toMatchObject({ hintServer: "demo", suggestions: ["demo_list_issues"] });
    expect(firstText(result)).not.toContain('server "noise"');
  });

  it("suggests unprefixed tools when an explicit server is provided", async () => {
    const state = createState();
    const definition = state.config.mcpServers.demo;
    assert.ok(definition);
    definition.toolPrefix = "none";
    state.toolMetadata.set("demo", [
      { name: "search", originalName: "search", description: "Search" },
    ]);

    const result = await executeCall(state, "sear", undefined, "demo");

    expect(result.details).toMatchObject({ hintServer: "demo", suggestions: ["search"] });
  });

  it("recovers from an explicit server that does not own the tool", async () => {
    const state = createState();
    state.config.mcpServers.gh = { command: "gh" };
    state.config.mcpServers.slack = { command: "slack" };
    state.toolMetadata = new Map([
      ["gh", [{ name: "gh_list_issues", originalName: "list_issues", description: "List issues" }]],
      [
        "slack",
        [
          { name: "slack_send", originalName: "send", description: "Send" },
          { name: "gh_list_issue", originalName: "gh_list_issue", description: "Near match" },
        ],
      ],
    ]);

    const result = await executeCall(state, "gh_list_issues", undefined, "slack");

    expect(result.details).toMatchObject({
      hintServer: "slack",
      suggestedServer: "gh",
      suggestions: ["gh_list_issues"],
    });
    expect(firstText(result)).toBe(
      'Tool "gh_list_issues" is on server "gh", not "slack". Retry the same call with server: "gh" or omit server.',
    );

    const alias = await executeCall(state, "gh-list-issues", undefined, "slack");
    expect(alias.details).toMatchObject({ suggestedServer: "gh" });
  });

  it("uses effective per-server prefixes for lazy routing", async () => {
    const state = createState();
    state.config.mcpServers = {
      "github-enterprise": { command: "enterprise", toolPrefix: "none" },
      github: { command: "github" },
    };
    state.toolMetadata = new Map([
      [
        "github-enterprise",
        [
          {
            name: "search",
            originalName: "search",
            description: "Search enterprise",
          },
        ],
      ],
    ]);
    const connect = vi
      .spyOn(state.manager, "connect")
      .mockRejectedValue(new Error("stop after routing"));

    await executeCall(state, "github_enterprise_search");

    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBe("github");
  });

  it("honors a server prefix override when the global prefix is none", async () => {
    const state = createState();
    state.config.settings = { toolPrefix: "none" };
    state.config.mcpServers = { github: { command: "github", toolPrefix: "server" } };
    state.toolMetadata.clear();
    const connect = vi
      .spyOn(state.manager, "connect")
      .mockRejectedValue(new Error("stop after routing"));

    await executeCall(state, "github_search");

    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBe("github");
  });

  it("does not connect a shorter overlapping prefix after a cached miss", async () => {
    const state = createState();
    state.config.mcpServers = {
      "github-enterprise": { command: "enterprise" },
      github: { command: "github" },
    };
    state.toolMetadata = new Map([
      [
        "github-enterprise",
        [
          {
            name: "github_enterprise_search",
            originalName: "search",
            description: "Search enterprise",
          },
        ],
      ],
    ]);
    const connect = vi.spyOn(state.manager, "connect");

    const result = await executeCall(state, "github_enterprise_sear");

    expect(connect).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      hintServer: "github-enterprise",
      suggestions: ["github_enterprise_search"],
    });
  });

  it("tells callers to invoke native Pi tools directly", async () => {
    const host = await createTestExtensionContext("builtin");
    let result;
    try {
      assert.ok(host.api.getAllTools().some((tool) => tool.name === "read"));
      result = await executeCall(createState(), "read", undefined, undefined, () =>
        host.api.getAllTools(),
      );
    } finally {
      await host.dispose();
    }

    expect(firstText(result)).toBe(
      '"read" is a native Pi tool. Call read directly instead of using mcp({ action: "call", tool: "read" }).',
    );
    expect(result.details).toMatchObject({ error: "native_tool", requestedTool: "read" });
  });
});
