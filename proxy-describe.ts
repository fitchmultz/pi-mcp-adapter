import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import { DEFAULT_TOOL_PREFIX, isServerDisabled, resolveToolPrefix } from "./types.ts";
import {
  catalogCoverage,
  findToolByName,
  matchesBackwardCompatibleToolName,
  toToolDescriptor,
  undiscoveredServersHint,
} from "./tool-metadata.ts";
import { rankSuggestions } from "./search-ranking.ts";
import { isToolCallApprovalRequired } from "./tool-approval.ts";

function matchesDisabledTool(
  state: McpExtensionState,
  server: string,
  tools: McpExtensionState["toolMetadata"] extends Map<string, infer T> ? T : never,
  toolName: string,
): boolean {
  if (findToolByName(tools, toolName) !== undefined) {
    return true;
  }
  const prefix = resolveToolPrefix(
    state.config.mcpServers[server],
    state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX,
  );
  return tools.some((tool) => matchesBackwardCompatibleToolName(tool, server, toolName, prefix));
}

function missingDescription(
  state: McpExtensionState,
  toolName: string,
  serverFilter?: string,
): ProxyToolResult {
  const disabled = [...state.toolMetadata].find(
    ([server, tools]) =>
      isServerDisabled(state.config.mcpServers[server]) &&
      matchesDisabledTool(state, server, tools, toolName),
  );
  if (disabled) {
    return disabledResult("describe", disabled[0]);
  }
  const suggestions = rankSuggestions(state, toolName, 5, serverFilter);
  const { unknownServers } = catalogCoverage(state, serverFilter);
  const baseHint =
    suggestions.length > 0
      ? `Did you mean: ${suggestions.join(", ")}. Inspect with mcp({ action: "describe", tool: "${String(suggestions[0])}" }).`
      : `Use mcp({ action: "search", query: "..." }) to search.`;
  const hint = `${baseHint}${undiscoveredServersHint(state, serverFilter)}`;
  return {
    content: [{ type: "text", text: `Tool "${toolName}" not found. ${hint}` }],
    details: {
      mode: "describe",
      error: "tool_not_found",
      requestedTool: toolName,
      suggestions,
      ...(unknownServers.length > 0 ? { undiscoveredServers: unknownServers } : {}),
    },
  };
}

function describeMatches(
  state: McpExtensionState,
  toolName: string,
  serverFilter: string | undefined,
) {
  const catalog = [...state.toolMetadata].flatMap(([server, tools]) =>
    ((serverFilter ?? "").length === 0 || serverFilter === server) &&
    state.config.mcpServers[server] &&
    !isServerDisabled(state.config.mcpServers[server])
      ? tools.map((tool) => ({ server, tool }))
      : [],
  );
  const originals =
    (serverFilter ?? "").length > 0
      ? catalog.filter(({ tool }) => tool.originalName === toolName)
      : [];
  if (originals.length > 0) {
    return originals;
  }
  const exact = catalog.filter(({ tool }) => tool.name === toolName);
  if (exact.length > 0) {
    return exact;
  }
  const normalized = toolName.replace(/-/g, "_");
  const hyphenMatches = catalog.filter(({ tool }) => tool.name.replace(/-/g, "_") === normalized);
  if (hyphenMatches.length > 0) {
    return hyphenMatches;
  }
  const globalPrefix = state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX;
  return catalog.filter(({ server, tool }) =>
    matchesBackwardCompatibleToolName(
      tool,
      server,
      toolName,
      resolveToolPrefix(state.config.mcpServers[server], globalPrefix),
    ),
  );
}
function describePayload(
  state: McpExtensionState,
  serverName: string,
  toolMeta: McpExtensionState["toolMetadata"] extends Map<string, Array<infer T>> ? T : never,
): Record<string, unknown> {
  const descriptor = toToolDescriptor(serverName, toolMeta);
  const approvalRequired = isToolCallApprovalRequired(state.config, serverName, toolMeta);
  const instructions = state.serverInstructions.get(serverName)?.trim();
  const serverInstructions =
    instructions !== undefined && instructions.length > 0 ? instructions : undefined;
  return {
    ...descriptor,
    ...((toolMeta.resourceUri ?? "").length > 0
      ? {
          resourceUri: toolMeta.resourceUri,
          readWith: {
            action: "read-resource",
            server: serverName,
            uri: toolMeta.resourceUri,
          },
        }
      : {}),
    ...(approvalRequired ? { approvalRequired: true } : {}),
    ...(serverInstructions !== undefined ? { serverInstructions } : {}),
  };
}
export function executeDescribe(
  state: McpExtensionState,
  toolName: string,
  serverFilter?: string,
): ProxyToolResult {
  if (
    serverFilter !== undefined &&
    serverFilter.length > 0 &&
    isServerDisabled(state.config.mcpServers[serverFilter])
  ) {
    return disabledResult("describe", serverFilter);
  }
  const matches = describeMatches(state, toolName, serverFilter);
  if (matches.length > 1) {
    return {
      content: [
        {
          type: "text",
          text: `Tool ${JSON.stringify(toolName)} is ambiguous. Specify server and original tool name: ${JSON.stringify(matches.map(({ server, tool }) => ({ server, tool: tool.originalName })))}`,
        },
      ],
      details: { mode: "describe", error: "ambiguous_tool", requestedTool: toolName },
    };
  }
  const match = matches[0];
  if (!match) {
    return missingDescription(state, toolName, serverFilter);
  }
  const { server: serverName, tool: toolMeta } = match;
  return {
    content: [
      { type: "text", text: JSON.stringify(describePayload(state, serverName, toolMeta), null, 2) },
    ],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}
