import { describe, expect, it } from "vitest";
import { paginate, rankSuggestions, scoreToolMatch } from "../search-ranking.ts";

const tool = (name: string, description: string) => ({
  name,
  originalName: name,
  description,
});

describe("search ranking", () => {
  it("ranks an exact name above a description match", () => {
    const exact = scoreToolMatch(tool("search_records", "Find records"), "demo", "search")!;
    const description = scoreToolMatch(tool("find_records", "Search records"), "demo", "search")!;

    expect(exact).toBeGreaterThan(description);
  });

  it("drops partial two-token matches", () => {
    expect(scoreToolMatch(tool("search_records", "Find records"), "demo", "search missing")).toBeNull();
  });

  it("ignores single-letter possessive tokens instead of stem-matching them", () => {
    // "project's" tokenizes to ["project", "s"]; a bare "s" must not match "simulator".
    expect(scoreToolMatch(tool("sync_icon", "Add an icon to your project's icons file."), "better-icons", "simulator")).toBeNull();
    // Real stems still match: "sync" (4+ chars) may prefix-match "synchronize".
    expect(scoreToolMatch(tool("sync_icon", "Sync an icon."), "better-icons", "synchronize")).not.toBeNull();
  });

  it("ranks same-server edit-distance suggestions and drops noise", () => {
    const state = {
      config: { mcpServers: { datadog: { command: "datadog" } } },
      toolMetadata: new Map([["datadog", [
        tool("datadog_get_datadog_incident", "Get an incident"),
        tool("datadog_get_datadog_metric", "Get a metric"),
        tool("datadog_get_datadog_dashboard", "Get a dashboard"),
        tool("datadog_aggregate_events", "Aggregate events"),
      ]]]),
    } as any;

    expect(rankSuggestions(state, "datadog_get_datadog_metrc", 5)[0]).toBe("datadog_get_datadog_metric");
    expect(rankSuggestions(state, "datadog_aggregate_evnts", 5)).toEqual(["datadog_aggregate_events"]);
    expect(rankSuggestions(state, "datadog_get_datadog_xyzzy", 5)).toEqual([]);
  });

  it("paginates including offsets beyond the result set", () => {
    expect(paginate(["a", "b", "c"], 1, 1)).toEqual({
      items: ["b"], total: 3, hasMore: true, nextOffset: 2,
    });
    expect(paginate(["a", "b", "c"], 5, 1)).toEqual({
      items: [], total: 3, hasMore: false, nextOffset: null,
    });
  });
});
