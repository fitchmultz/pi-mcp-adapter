import { describe, expect, it } from "vitest";
import { executeCall, executeDescribe, executeSearch } from "../proxy-modes.ts";
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

  it("returns ranked paged search details", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 0);

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      matches: [{ server: "demo", tool: "demo_find", score: expect.any(Number) }],
    });
  });

  it("paginates search results without changing their order", () => {
    const result = executeSearch(createState(), "demo", undefined, false, 1, 1);

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: false,
      nextOffset: null,
      matches: [{ server: "demo", tool: "demo_search", score: expect.any(Number) }],
    });
  });

  it("suggests the matching tool for a prefix-mangled describe name", () => {
    const result = executeDescribe(createState(), "demo_sear");

    expect(result.details).toMatchObject({ suggestions: ["demo_search"] });
    expect(result.content[0].text).toContain("Did you mean: demo_search");
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
