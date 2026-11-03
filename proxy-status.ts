import type { McpExtensionState } from "./state.ts";
import type { ProxyToolResult } from "./proxy-result.ts";

import type { ServerConnection } from "./server-manager.ts";
import { type ToolMetadata, isServerDisabled } from "./types.ts";
import { getFailureAgeSeconds } from "./init.ts";
import { catalogCoverage } from "./tool-metadata.ts";

function serverStatus(state: McpExtensionState, name: string) {
  const definition = state.config.mcpServers[name];
  const disabled = isServerDisabled(definition);
  const connection = disabled ? undefined : state.manager.getConnection(name);
  const metadata = disabled ? undefined : state.toolMetadata.get(name);
  const toolCount = metadata?.filter((tool) => (tool.resourceUri ?? "").length === 0).length ?? 0;
  const failedAgo = disabled ? null : getFailureAgeSeconds(state, name);
  const status = disabled ? "disabled" : connectionStatus(connection, metadata, failedAgo);
  return { name, status, toolCount, failedAgo, ...(disabled ? { disabled: true } : {}) };
}
function connectionStatus(
  connection: ServerConnection | undefined,
  metadata: ToolMetadata[] | undefined,
  failedAgo: number | null,
): string {
  if (connection?.status === "connected") {
    return "connected";
  }
  if (connection?.status === "needs-auth") {
    return "needs-auth";
  }
  if (failedAgo !== null) {
    return "failed";
  }
  return metadata === undefined ? "not connected" : "cached";
}

function formatServerStatus(server: ReturnType<typeof serverStatus>): string {
  if (server.disabled === true) {
    return `⊘ ${server.name} (disabled)\n`;
  }
  if (server.status === "connected") {
    return `✓ ${server.name} (${server.toolCount} tools)\n`;
  }
  if (server.status === "needs-auth") {
    return `⚠ ${server.name} (needs auth)\n`;
  }
  if (server.status === "cached") {
    return `○ ${server.name} (${server.toolCount} tools, cached)\n`;
  }
  if (server.status === "failed") {
    return `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
  }
  return `○ ${server.name} (not discovered)\n`;
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: ReturnType<typeof serverStatus>[] = [];

  servers.push(...Object.keys(state.config.mcpServers).map((name) => serverStatus(state, name)));

  const disabledCount = servers.filter((s) => s.disabled === true).length;
  const enabledServers = servers.filter((s) => s.disabled !== true);
  const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = enabledServers.filter((s) => s.status === "connected").length;
  const coverage = catalogCoverage(state);

  let text = `MCP: ${connectedCount}/${enabledServers.length} connected, ${totalTools} tools available (calls connect lazily)`;
  if (disabledCount > 0) {
    text += ` (${disabledCount} disabled)`;
  }
  text += "\n\n";
  for (const server of servers) {
    text += formatServerStatus(server);
  }

  if (servers.length > 0) {
    text += `\nmcp_search({ query: "...", server: "name" }) to discover tools; mcp({ action: "resources", server: "name" }) for resources.`;
    if (!coverage.complete) {
      text += `\nPartial catalog: ${coverage.unknownServers.length} undiscovered server(s).`;
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount, disabledCount, coverage },
  };
}
