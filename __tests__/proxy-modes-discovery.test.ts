import { describe, expect, it, vi } from "vitest";
import { executeCall, executeDescribe, executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";

function createState(): McpExtensionState {
  return {
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
    manager: {
      getConnection: () => undefined,
    },
    serverInstructions: new Map(),
    failureTracker: new Map(),
  } as unknown as McpExtensionState;
}

describe("proxy discovery", () => {
  it("searches MCP tools only", () => {
    const result = executeSearch(createState(), "read");

    expect(result.content[0].text).toBe('No tools matching "read"');
    expect(result.details).toMatchObject({ count: 0, matches: [] });
  });

  it("treats a long query as plain text rather than a pattern", () => {
    const result = executeSearch(createState(), "search terms ".repeat(40));

    expect(result.details).toMatchObject({ count: 0 });
  });

  it("paginates server listings", () => {
    const result = executeList(createState(), "demo", 1, 0);

    expect(result.content[0].text).toContain("demo_search");
    expect(result.content[0].text).not.toContain("demo_find");
    expect(result.content[0].text).toContain('1-1 of 2 — mcp({ server: "demo", limit: 1, offset: 1 }) for more');
    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      tools: ["demo_search"],
    });
  });

  it("explains an out-of-range server-list offset", () => {
    const result = executeList(createState(), "demo", 1, 99);

    expect(result.content[0].text).toBe('No tools at offset 99; "demo" has 2 tools. Retry with mcp({ server: "demo", limit: 1, offset: 0 }).');
    expect(result.details).toMatchObject({ error: "offset_out_of_range", count: 2, tools: [] });
  });

  it("explains lazy connection state", () => {
    const result = executeStatus(createState());

    expect(result.content[0].text).toContain("MCP: 0/1 connected, 2 tools available (calls connect lazily)");
  });

  it("returns ranked paged search details", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 0);

    expect(result.content[0].text).toContain('1-1 of 2 — mcp({ search: "demo", limit: 1, offset: 1 }) for more');

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      matches: [{ server: "demo", tool: "demo_find", score: expect.any(Number) }],
    });
  });

  it("paginates search results without changing their order", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 1);

    expect(result.content[0].text).toContain("2-2 of 2 — end");
    expect(result.details).toMatchObject({
      count: 2,
      hasMore: false,
      nextOffset: null,
      matches: [{ server: "demo", tool: "demo_search", score: expect.any(Number) }],
    });
  });

  it("explains an out-of-range search offset", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 99);

    expect(result.content[0].text).toContain("No search results at offset 99; 2 tools match");
    expect(result.details).toMatchObject({ error: "offset_out_of_range", count: 2, matches: [] });
  });

  it("scopes prefix-mangled suggestions to the matching server", () => {
    const state = createState();
    state.config.mcpServers.noise = { command: "npx", args: ["noise"] };
    state.toolMetadata.set("noise", [{
      name: "noise_search",
      originalName: "search",
      description: "Search demo records",
    }]);

    const result = executeDescribe(state, "demo_sear");

    expect(result.details).toMatchObject({ suggestions: ["demo_search"] });
    expect(result.content[0].text).toContain('Inspect with mcp({ describe: "demo_search" })');
  });

  it("keeps cached prefixed call typos bounded without connecting", async () => {
    const state = createState();
    const connect = vi.fn();
    state.manager = { getConnection: () => undefined, connect } as never;

    const result = await executeCall(state, "demo_sear");

    expect(connect).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Did you mean: demo_search");
    expect(result.content[0].text).not.toContain("demo_find");
    expect(result.content[0].text).toContain('mcp({ connect: "demo" })');
    expect(result.content[0].text.length).toBeLessThan(300);

    const missing = await executeCall(state, "demo_new_tool");
    expect(missing.content[0].text).toContain('mcp({ connect: "demo" })');
    expect(connect).not.toHaveBeenCalled();
  });

  it("suggests unprefixed tools when an explicit server is provided", async () => {
    const state = createState();
    state.config.mcpServers.demo.toolPrefix = "none";
    state.toolMetadata.set("demo", [{ name: "search", originalName: "search", description: "Search" }]);

    const result = await executeCall(state, "sear", undefined, "demo");

    expect(result.details).toMatchObject({ hintServer: "demo", suggestions: ["search"] });
  });

  it("recovers from an explicit server that does not own the tool", async () => {
    const state = createState();
    state.config.mcpServers.gh = { command: "gh" };
    state.config.mcpServers.slack = { command: "slack" };
    state.toolMetadata = new Map([
      ["gh", [{ name: "gh_list_issues", originalName: "list_issues", description: "List issues" }]],
      ["slack", [{ name: "slack_send", originalName: "send", description: "Send" }]],
    ]);

    const result = await executeCall(state, "gh_list_issues", undefined, "slack");

    expect(result.details).toMatchObject({ hintServer: "slack", suggestions: ["gh_list_issues"] });
    expect(result.content[0].text).toContain("Did you mean: gh_list_issues");
    expect(result.content[0].text).not.toContain('connect: "slack"');
    expect(result.content[0].text).not.toContain('server: "slack"');
  });

  it("uses effective per-server prefixes for lazy routing", async () => {
    const state = createState();
    state.config.mcpServers = {
      "github-enterprise": { command: "enterprise", toolPrefix: "none" },
      github: { command: "github" },
    };
    state.toolMetadata = new Map([["github-enterprise", [{
      name: "search",
      originalName: "search",
      description: "Search enterprise",
    }]]]);
    const connect = vi.fn(async () => { throw new Error("stop after routing"); });
    state.manager = {
      getConnection: () => undefined,
      getAllConnections: () => [],
      connect,
    } as never;

    await executeCall(state, "github_enterprise_search");

    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBe("github");
  });

  it("honors a server prefix override when the global prefix is none", async () => {
    const state = createState();
    state.config.settings = { toolPrefix: "none" };
    state.config.mcpServers = { github: { command: "github", toolPrefix: "server" } };
    state.toolMetadata.clear();
    const connect = vi.fn(async () => { throw new Error("stop after routing"); });
    state.manager = {
      getConnection: () => undefined,
      getAllConnections: () => [],
      connect,
    } as never;

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
    state.toolMetadata = new Map([["github-enterprise", [{
      name: "github_enterprise_search",
      originalName: "search",
      description: "Search enterprise",
    }]]]);
    const connect = vi.fn();
    state.manager = { getConnection: () => undefined, connect } as never;

    const result = await executeCall(state, "github_enterprise_sear");

    expect(connect).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ hintServer: "github-enterprise", suggestions: ["github_enterprise_search"] });
  });

  it("tells callers to invoke native Pi tools directly", async () => {
    const result = await executeCall(
      createState(),
      "read",
      undefined,
      undefined,
      () => [{ name: "read", description: "Read a file" } as any],
    );

    expect(result.content[0].text).toBe(
      '"read" is a native Pi tool. Call read directly instead of using mcp({ tool: "read" }).',
    );
    expect(result.details).toMatchObject({ error: "native_tool", requestedTool: "read" });
  });
});
