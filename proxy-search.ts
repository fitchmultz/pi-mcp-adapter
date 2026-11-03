import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import { isServerDisabled, type ToolMetadata } from "./types.ts";
import { catalogCoverage, toToolDescriptor } from "./tool-metadata.ts";
import { paginate, rankToolMatches } from "./search-ranking.ts";
import { isToolCallApprovalRequired } from "./tool-approval.ts";
import { truncateAtWord } from "./utils.ts";

interface SearchContinuation {
  caller: "mcp" | "mcp_search";
  query: string;
  server: string | undefined;
  showSchemas: boolean;
  limit: number;
}
function searchContinuation(options: SearchContinuation, nextOffset: number | null): string {
  const { caller, query, server, showSchemas, limit } = options;
  return `${caller}({ ${caller === "mcp" ? 'action: "search", ' : ""}query: ${JSON.stringify(query)}${(server ?? "").length > 0 ? `, server: ${JSON.stringify(server)}` : ""}${caller === "mcp" && !showSchemas ? ", includeSchemas: false" : ""}, limit: ${limit}, offset: ${String(nextOffset)} })`;
}
function formatSearchMatch(
  state: McpExtensionState,
  match: { server: string; tool: ToolMetadata },
  showSchemas: boolean,
): string {
  const approval = isToolCallApprovalRequired(state.config, match.server, match.tool);
  if (showSchemas) {
    return `${JSON.stringify({ ...toToolDescriptor(match.server, match.tool), ...(approval ? { approvalRequired: true } : {}) }, null, 2)}\n\n`;
  }
  const description =
    match.tool.description.length > 0 ? ` - ${truncateAtWord(match.tool.description, 50)}` : "";
  return `- ${match.tool.name}${approval ? " (requires approval)" : ""}${description}\n`;
}

function emptySearchPage(
  page: ReturnType<typeof paginate<{ server: string; tool: ToolMetadata; score: number }>>,
  options: SearchContinuation & {
    offset: number;
    coverage: ReturnType<typeof catalogCoverage>;
    coverageNotice: string;
  },
): ProxyToolResult | undefined {
  const { server, query, offset, coverage, coverageNotice } = options;
  if (page.total === 0) {
    const msg =
      (server ?? "").length > 0
        ? `No tools matching "${query}" in "${server ?? ""}"`
        : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg + coverageNotice }],
      details: {
        mode: "search",
        matches: [],
        count: 0,
        hasMore: false,
        nextOffset: null,
        query,
        coverage,
      },
    };
  }
  if (page.items.length === 0) {
    const retry = searchContinuation(options, 0);
    return {
      content: [
        {
          type: "text" as const,
          text: `No search results at offset ${offset}; ${page.total} tools match. Retry with ${retry}.`,
        },
      ],
      details: {
        mode: "search",
        error: "offset_out_of_range",
        matches: [],
        count: page.total,
        hasMore: false,
        nextOffset: null,
        query,
      },
    };
  }

  return;
}

function searchMatches(
  state: McpExtensionState,
  query: string,
  server: string | undefined,
): Array<{ server: string; tool: ToolMetadata; score: number }> | ProxyToolResult {
  let matches: Array<{ server: string; tool: ToolMetadata; score: number }>;
  if (query.trim().length === 0) {
    if (server === undefined || server.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Search query cannot be empty" }],
        details: { mode: "search", error: "empty_query" },
      };
    }
    matches = (state.toolMetadata.get(server) ?? [])
      .filter((tool) => (tool.resourceUri ?? "").length === 0)
      .map((tool) => ({ server, tool, score: 0 }))
      .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  } else {
    matches = rankToolMatches(state, query, server);
  }

  return matches;
}
function searchPageText(
  state: McpExtensionState,
  page: ReturnType<typeof paginate<{ server: string; tool: ToolMetadata; score: number }>>,
  options: SearchContinuation & { offset: number },
): string {
  const { query, offset, showSchemas } = options;
  let text = `Found ${page.total} tool${page.total === 1 ? "" : "s"} matching "${query}":\n\n`;
  text += page.items.map((match) => formatSearchMatch(state, match, showSchemas)).join("");
  const first = (Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0) + 1;
  const nextSearch = searchContinuation(options, page.nextOffset);
  text += page.hasMore
    ? `\n${first}-${first + page.items.length - 1} of ${page.total} — ${nextSearch} for more\n`
    : `\n${first}-${first + page.items.length - 1} of ${page.total} — end\n`;

  return text;
}
export function executeSearch(
  state: McpExtensionState,
  query: string,
  server?: string,
  includeSchemas?: boolean,
  limit = 12,
  offset = 0,
  caller: "mcp" | "mcp_search" = "mcp",
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;
  if (
    server !== undefined &&
    server.length > 0 &&
    isServerDisabled(state.config.mcpServers[server])
  ) {
    return disabledResult("search", server);
  }

  const matches = searchMatches(state, query, server);
  if (!Array.isArray(matches)) {
    return matches;
  }

  const page = paginate(matches, offset, limit);
  const coverage = catalogCoverage(state, server);
  const coverageNotice = coverage.complete
    ? ""
    : `\nCatalog is incomplete. Undiscovered servers: ${coverage.unknownServers.join(", ")}. Search with server to discover one.`;
  const empty = emptySearchPage(page, {
    caller,
    query,
    server,
    showSchemas,
    limit,
    offset,
    coverage,
    coverageNotice,
  });
  if (empty) {
    return empty;
  }

  const text = searchPageText(state, page, { caller, query, server, showSchemas, limit, offset });

  return {
    content: [{ type: "text" as const, text: text.trim() + coverageNotice }],
    details: {
      mode: "search",
      coverage,
      matches: page.items.map((match) => ({
        server: match.server,
        tool: match.tool.name,
        score: match.score,
      })),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      query,
    },
  };
}
