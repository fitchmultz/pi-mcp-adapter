import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import { isServerDisabled } from "./types.ts";
import { findToolByName, toToolDescriptor } from "./tool-metadata.ts";
import { rankSuggestions } from "./search-ranking.ts";
import { isToolCallApprovalRequired } from "./tool-approval.ts";
function missingDescription(
  state: McpExtensionState,
  toolName: string,
  serverFilter?: string,
): ProxyToolResult {
  const disabled = [...state.toolMetadata].find(
    ([server, tools]) =>
      isServerDisabled(state.config.mcpServers[server]) &&
      findToolByName(tools, toolName) !== undefined,
  );
  if (disabled) {
    return disabledResult("describe", disabled[0]);
  }
  const suggestions = rankSuggestions(state, toolName, 5, serverFilter);
  const hint =
    suggestions.length > 0
      ? `Did you mean: ${suggestions.join(", ")}. Inspect with mcp({ action: "describe", tool: "${String(suggestions[0])}" }). Load if inactive: mcp_search({ enable: ["gateway"] }).`
      : `Use mcp_search({ query: "..." }) to search.`;
  return {
    content: [{ type: "text", text: `Tool "${toolName}" not found. ${hint}` }],
    details: { mode: "describe", error: "tool_not_found", requestedTool: toolName, suggestions },
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
  const exact =
    originals.length > 0 ? originals : catalog.filter(({ tool }) => tool.name === toolName);
  const matches =
    exact.length > 0
      ? exact
      : catalog.filter(({ tool }) => tool.name.replace(/-/g, "_") === toolName.replace(/-/g, "_"));

  return matches;
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
  const descriptor = toToolDescriptor(serverName, toolMeta);
  const approvalRequired = isToolCallApprovalRequired(state.config, serverName, toolMeta);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      },
    ],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}
