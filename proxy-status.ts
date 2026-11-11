import type { McpExtensionState } from "./state.ts";
import type { ProxyToolResult } from "./proxy-result.ts";

import { isServerDisabled } from "./types.ts";
import { getFailureAgeSeconds } from "./init.ts";
import { catalogCoverage } from "./tool-metadata.ts";
import { proxyStatusText, serverStage } from "./server-status.ts";

function serverStatus(state: McpExtensionState, name: string) {
  const definition = state.config.mcpServers[name];
  const disabled = isServerDisabled(definition);
  const connection = disabled ? undefined : state.manager.getConnection(name);
  const metadata = disabled ? undefined : state.toolMetadata.get(name);
  const toolCount = metadata?.filter((tool) => (tool.resourceUri ?? "").length === 0).length ?? 0;
  const failedAgo = disabled ? null : getFailureAgeSeconds(state, name);
  const stage = serverStage({
    definition,
    transport: connection?.status,
    failedAgoSeconds: failedAgo,
    catalogKnown: metadata !== undefined,
  });
  return {
    name,
    stage,
    status: proxyStatusText(stage),
    toolCount,
    failedAgo,
    ...(disabled ? { disabled: true } : {}),
  };
}

function formatServerStatus({
  name,
  stage,
  toolCount,
  failedAgo,
}: ReturnType<typeof serverStatus>): string {
  switch (stage) {
    case "disabled":
      return `⊘ ${name} (disabled)\n`;
    case "connected":
      return `✓ ${name} (${toolCount} tools)\n`;
    case "needs-auth":
      return `⚠ ${name} (needs auth)\n`;
    case "cached":
      return `○ ${name} (${toolCount} tools, cached)\n`;
    case "failed":
      return `✗ ${name} (failed ${failedAgo ?? 0}s ago)\n`;
    case "undiscovered":
      return `○ ${name} (not discovered)\n`;
  }
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const entries = Object.keys(state.config.mcpServers).map((name) => serverStatus(state, name));
  const servers = entries.map(({ stage: _stage, ...row }) => row);

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
  for (const server of entries) {
    text += formatServerStatus(server);
  }

  if (servers.length > 0) {
    text += `\ntool_search loads typed tools; mcp({ action: "search", query: "...", server: "name" }) inspects a catalog; mcp({ action: "resources", server: "name" }) lists resources.`;
    if (!coverage.complete) {
      text += `\nPartial catalog: ${coverage.unknownServers.length} undiscovered server(s).`;
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount, disabledCount, coverage },
  };
}
