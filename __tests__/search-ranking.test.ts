import { afterEach, describe, expect, it, vi } from "vitest";
import MiniSearch from "minisearch";
import { paginate, rankSuggestions, rankToolMatches } from "../search-ranking.ts";
import type { McpExtensionState } from "../state.ts";
import type { ToolMetadata } from "../types.ts";

afterEach(() => vi.restoreAllMocks());

const tool = (name: string, description: string, originalName = name) => ({
  name,
  originalName,
  description,
});

function stateWithTools(tools: ToolMetadata[]): McpExtensionState {
  return { config: { mcpServers: { demo: {} } }, toolMetadata: new Map([["demo", tools]]) } as McpExtensionState;
}

describe("search ranking", () => {
  it("ranks a name match above a description match", () => {
    const state = stateWithTools([tool("search_records", "Find records"), tool("find_records", "Search records")]);
    expect(rankToolMatches(state, "search").map(match => match.tool.name)).toEqual(["search_records", "find_records"]);
  });

  it("retains partial candidates behind stronger multi-term matches", () => {
    const state = stateWithTools([tool("search_records", "Find records"), tool("search_missing", "Search missing records")]);
    expect(rankToolMatches(state, "search missing").map(match => match.tool.name)).toEqual(["search_missing", "search_records"]);
  });

  it("uses lexical prefixes without reverse stemming or fuzzy discovery", () => {
    const state = stateWithTools([tool("sync_icon", "Add an icon to your project's icons file.")]);
    expect(rankToolMatches(state, "simulator")).toEqual([]);
    expect(rankToolMatches(state, "synchronize")).toEqual([]);
    expect(rankToolMatches(state, "icno")).toEqual([]);
    expect(rankToolMatches(state, "ico")[0]?.tool.name).toBe("sync_icon");
  });

  it("builds the index on demand and rebuilds after catalog replacement, addition and removal", () => {
    const add = vi.spyOn(MiniSearch.prototype, "add");
    const state = stateWithTools([tool("old_tool", "Old guidance")]);
    expect(add).not.toHaveBeenCalled();
    expect(rankToolMatches(state, "old")).toHaveLength(1);
    expect(add).toHaveBeenCalledOnce();
    expect(rankToolMatches(state, "old")).toHaveLength(1);
    expect(add).toHaveBeenCalledOnce();

    state.toolMetadata.set("demo", [tool("new_tool", "New guidance")]);
    expect(rankToolMatches(state, "old")).toEqual([]);
    expect(rankToolMatches(state, "new")[0]?.tool.name).toBe("new_tool");
    state.config.mcpServers.other = {};
    state.toolMetadata.set("other", [tool("other_tool", "Separate guidance")]);
    expect(rankToolMatches(state, "separate")[0]?.server).toBe("other");
    state.toolMetadata.delete("other");
    expect(rankToolMatches(state, "separate")).toEqual([]);
    state.toolMetadata.clear();
    expect(rankToolMatches(state, "new")).toEqual([]);
  });

  it("applies server scope and current config filters even to an already-built index", () => {
    const state = stateWithTools([tool("demo_search", "Search records", "search")]);
    state.config.mcpServers.other = {};
    state.toolMetadata.set("other", [tool("other_search", "Search records", "search")]);
    expect(rankToolMatches(state, "search")).toHaveLength(2);
    expect(rankToolMatches(state, "search", "demo").map(match => match.server)).toEqual(["demo"]);
    expect(rankToolMatches(state, "search", "missing")).toEqual([]);

    state.config.mcpServers.other!.disabled = true;
    expect(rankToolMatches(state, "search").map(match => match.server)).toEqual(["demo"]);
    expect(rankSuggestions(state, "other_serch", 5)).toEqual([]);
    state.config.mcpServers.demo!.includeTools = ["demo_search"];
    expect(rankToolMatches(state, "search")).toHaveLength(1);
    state.config.mcpServers.demo!.excludeTools = ["search"];
    expect(rankToolMatches(state, "search")).toEqual([]);
    state.config.mcpServers.demo!.excludeTools = [];
    state.config.mcpServers.demo!.includeTools = ["unrelated"];
    expect(rankToolMatches(state, "search")).toEqual([]);
  });

  it("ranks same-server fuzzy suggestions and drops noise", () => {
    const state = {
      config: { mcpServers: { datadog: { command: "datadog" } } },
      toolMetadata: new Map([["datadog", [
        tool("datadog_get_datadog_incident", "Get an incident", "get_datadog_incident"),
        tool("datadog_get_datadog_metric", "Get a metric", "get_datadog_metric"),
        tool("datadog_get_datadog_dashboard", "Get a dashboard", "get_datadog_dashboard"),
        tool("datadog_aggregate_events", "Aggregate events", "aggregate_events"),
      ]]]),
    } as any;

    expect(rankSuggestions(state, "datadog_get_datadog_metrc", 5)[0]).toBe("datadog_get_datadog_metric");
    expect(rankSuggestions(state, "datadog_aggregate_evnts", 5)).toEqual(["datadog_aggregate_events"]);
    expect(rankSuggestions(state, "datadgo_aggregate_evnts", 5)).toEqual(["datadog_aggregate_events"]);
    expect(rankSuggestions(state, "datadog_get_datadog_xyzzy", 5)).toEqual([]);
    expect(rankSuggestions(state, `datadog_${"x".repeat(10_000)}`, 5)).toEqual([]);
  });

  it("falls back to token ranking for reordered names", () => {
    const state = {
      config: { mcpServers: { gh: { command: "gh" } } },
      toolMetadata: new Map([["gh", [tool("gh_list_issues", "List issues", "list_issues"), tool("gh_create_issue", "Create an issue", "create_issue")]]]),
    } as any;

    expect(rankSuggestions(state, "gh_issues_list", 5)[0]).toBe("gh_list_issues");
  });

  it("does not suggest unrelated operations by matching the server prefix", () => {
    const state = stateWithTools([
      tool("demo_publish", "Publish a document", "publish"),
      tool("demo_archive", "Archive a record", "archive"),
    ]);
    expect(rankToolMatches(state, "demo")).toHaveLength(2);
    expect(rankSuggestions(state, "demo_dem", 5)).toEqual([]);
    expect(rankSuggestions(state, "demo_dem", 5, "demo")).toEqual([]);
  });

  it("uses explicit servers and tool suffixes for suggestions", () => {
    const unprefixed = {
      config: { mcpServers: { datadog: { command: "datadog", toolPrefix: "none" } } },
      toolMetadata: new Map([["datadog", [tool("aggregate_events", "Aggregate events")]]]),
    } as any;
    expect(rankSuggestions(unprefixed, "aggregate_evnts", 5, "datadog")).toEqual(["aggregate_events"]);

    const server = "very-long-descriptive-server";
    const prefix = "very_long_descriptive_server";
    const longPrefix = {
      config: { mcpServers: { [server]: { command: "demo" } } },
      toolMetadata: new Map([[server, [tool(`${prefix}_foo`, "Foo", "foo")]]]),
    } as any;
    expect(rankSuggestions(longPrefix, `${prefix}_bar`, 5)).toEqual([]);
  });

  it("paginates including offsets beyond the result set", () => {
    expect(paginate(["a", "b", "c"], 1, 1)).toEqual({
      items: ["b"], total: 3, hasMore: true, nextOffset: 2,
    });
    expect(paginate(["a", "b", "c"], 5, 1)).toEqual({
      items: [], total: 3, hasMore: false, nextOffset: null,
    });
    expect(paginate(Array.from({ length: 101 }, (_, index) => index), 0, 1_000)).toMatchObject({
      items: expect.arrayContaining([0, 99]), total: 101, hasMore: true, nextOffset: 100,
    });
  });
});
