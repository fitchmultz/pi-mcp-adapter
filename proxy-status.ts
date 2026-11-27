import type { McpExtensionState } from "./state.ts";
import type { ProxyToolResult } from "./proxy-result.ts";

import { isServerDisabled } from "./types.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import { catalogCoverage } from "./tool-metadata.ts";
import {
  formatFailureSummary,
  proxyStatusText,
  serverStage,
  type ServerStage,
} from "./server-status.ts";

interface ServerStatusEntry {
  name: string;
  stage: ServerStage;
  status: string;
  toolCount: number;
  skillCount?: number;
  failedAgo: number | null;
  failureMessage?: string;
  disabled?: true;
}

function statusFailureMessage(
  state: McpExtensionState,
  name: string,
  stage: ServerStage,
  connection: ReturnType<McpExtensionState["manager"]["getConnection"]>,
): string | null {
  if (stage === "connected" || stage === "disabled") {
    return null;
  }
  const closedStderr = connection?.status === "closed" ? connection.getStderrTail?.() : null;
  return formatFailureSummary(getFailureMessage(state, name) ?? closedStderr);
}

function serverStatus(state: McpExtensionState, name: string): ServerStatusEntry {
  const definition = state.config.mcpServers[name];
  if (isServerDisabled(definition)) {
    return {
      name,
      stage: "disabled",
      status: proxyStatusText("disabled"),
      toolCount: 0,
      failedAgo: null,
      disabled: true,
    };
  }
  const connection = state.manager.getConnection(name);
  const metadata = state.toolMetadata.get(name);
  const toolCount = metadata?.filter((tool) => (tool.resourceUri ?? "").length === 0).length ?? 0;
  const skillCount = state.skillMetadata?.get(name)?.length ?? 0;
  const failedAgo = getFailureAgeSeconds(state, name);
  const stage = serverStage({
    definition,
    transport: connection?.status,
    failedAgoSeconds: failedAgo,
    catalogKnown: metadata !== undefined,
  });
  const failureMessage = statusFailureMessage(state, name, stage, connection);
  return {
    name,
    stage,
    status: proxyStatusText(stage),
    toolCount,
    ...(skillCount > 0 ? { skillCount } : {}),
    failedAgo,
    ...(failureMessage !== null ? { failureMessage } : {}),
  };
}

function formatSkillSuffix(skillCount: number | undefined): string {
  if (skillCount === undefined || skillCount <= 0) {
    return "";
  }
  return `, ${skillCount} skill${skillCount === 1 ? "" : "s"}`;
}

function formatServerStatus({
  name,
  stage,
  toolCount,
  skillCount,
  failedAgo,
  failureMessage,
}: ServerStatusEntry): string {
  const reason = failureMessage !== undefined && failureMessage.length > 0 ? failureMessage : null;
  const skillSuffix = formatSkillSuffix(skillCount);
  switch (stage) {
    case "disabled":
      return `⊘ ${name} (disabled)\n`;
    case "connected":
      return `✓ ${name} (${toolCount} tools${skillSuffix})\n`;
    case "needs-auth":
      return `⚠ ${name} (needs auth${reason !== null ? ` — ${reason}` : ""})\n`;
    case "cached":
      return `○ ${name} (${toolCount} tools${skillSuffix}, cached${reason !== null ? `; last error: ${reason}` : ""})\n`;
    case "failed":
      return `✗ ${name} (failed ${failedAgo ?? 0}s ago${reason !== null ? ` — ${reason}` : ""})\n`;
    case "undiscovered":
      return `○ ${name} (not discovered${reason !== null ? `; last error: ${reason}` : ""})\n`;
  }
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const entries = Object.keys(state.config.mcpServers).map((name) => serverStatus(state, name));
  const servers = entries.map(({ stage: _stage, ...row }) => row);

  const disabledCount = servers.filter((s) => s.disabled === true).length;
  const enabledServers = servers.filter((s) => s.disabled !== true);
  const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);
  const totalSkills = enabledServers.reduce((sum, s) => sum + (s.skillCount ?? 0), 0);
  const connectedCount = enabledServers.filter((s) => s.status === "connected").length;
  const coverage = catalogCoverage(state);

  const skillSummary = totalSkills > 0 ? `, ${totalSkills} skills` : "";
  let text = `MCP: ${connectedCount}/${enabledServers.length} connected, ${totalTools} tools${skillSummary} available (calls connect lazily)`;
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
    details: {
      mode: "status",
      servers,
      totalTools,
      ...(totalSkills > 0 ? { totalSkills } : {}),
      connectedCount,
      disabledCount,
      coverage,
    },
  };
}
