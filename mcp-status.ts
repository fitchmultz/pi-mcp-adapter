import type { McpExtensionState } from "./state.ts";
import type { McpStatusEventBus } from "./mcp-status-events.ts";
export type { McpStatusEventBus } from "./mcp-status-events.ts";
import {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
} from "./types.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;

function getActiveFailureAgeSeconds(
  state: McpExtensionState,
  serverName: string,
): number | undefined {
  const failedAt = state.failureTracker.get(serverName);
  if (failedAt === undefined || failedAt === 0 || Number.isNaN(failedAt)) {
    return undefined;
  }
  const ageMs = Date.now() - failedAt;
  return ageMs > FAILURE_BACKOFF_MS ? undefined : Math.round(ageMs / 1000);
}

function getServerStatus(
  connection: ReturnType<McpExtensionState["manager"]["getConnection"]>,
  failedAgoSeconds: number | undefined,
  catalogKnown: boolean,
): McpServerStatusSnapshot["status"] {
  if (connection?.status === "connected") {
    return "connected";
  }
  if (connection?.status === "needs-auth") {
    return "needs-auth";
  }
  if (failedAgoSeconds !== undefined) {
    return "failed";
  }
  return catalogKnown ? "cached" : "not-connected";
}

function getCatalogCounts(
  state: McpExtensionState,
  name: string,
  connection: ReturnType<McpExtensionState["manager"]["getConnection"]>,
): { toolCount: number; resourceCount: number | undefined; catalogKnown: boolean } {
  const metadata = state.toolMetadata.get(name);
  const connected = connection?.status === "connected";
  const toolCount =
    metadata?.filter((tool) => (tool.resourceUri ?? "").length === 0).length ??
    (connected ? connection.tools.length : 0);
  const resourceCount =
    state.resourceCounts.get(name) ?? (connected ? connection.resources.length : undefined);

  return { toolCount, resourceCount, catalogKnown: metadata !== undefined || connected };
}

function getServerSnapshot(state: McpExtensionState, name: string): McpServerStatusSnapshot {
  if (state.config.mcpServers[name]?.disabled === true) {
    return { name, status: "disabled", toolCount: 0, catalogKnown: false, disabled: true };
  }
  const connection = state.manager.getConnection(name);
  const { toolCount, resourceCount, catalogKnown } = getCatalogCounts(state, name, connection);
  const failedAgoSeconds = getActiveFailureAgeSeconds(state, name);
  const status = getServerStatus(connection, failedAgoSeconds, catalogKnown);
  return {
    name,
    status,
    toolCount,
    catalogKnown,
    ...(resourceCount !== undefined ? { resourceCount } : {}),
    ...(status === "failed" && failedAgoSeconds !== undefined ? { failedAgoSeconds } : {}),
    disabled: false,
  };
}

/** Build a sanitized snapshot without connecting or querying any MCP server. */
export function createMcpStatusSnapshot(state: McpExtensionState): McpStatusSnapshot {
  const servers = Object.keys(state.config.mcpServers).map((name) =>
    getServerSnapshot(state, name),
  );
  return {
    version: MCP_STATUS_SNAPSHOT_VERSION,
    servers,
    totalTools: servers.reduce((sum, server) => sum + server.toolCount, 0),
    totalResources: servers.reduce((sum, server) => sum + (server.resourceCount ?? 0), 0),
    connectedCount: servers.filter((server) => server.status === "connected").length,
    disabledCount: servers.filter((server) => server.disabled).length,
  };
}

export function publishMcpStatusSnapshot(
  state: McpExtensionState,
  snapshot?: McpStatusSnapshot,
): void {
  const events = state.statusEvents;
  if (!events) {
    return;
  }
  try {
    events.emit(MCP_STATUS_EVENT, snapshot ?? createMcpStatusSnapshot(state));
  } catch {
    // Event consumers must not be able to interrupt MCP operations.
  }
}

export function publishMcpStatusShutdown(events: McpStatusEventBus | undefined): void {
  if (!events) {
    return;
  }
  try {
    events.emit(MCP_STATUS_EVENT, {
      version: MCP_STATUS_SNAPSHOT_VERSION,
      servers: [],
      totalTools: 0,
      totalResources: 0,
      connectedCount: 0,
      disabledCount: 0,
    } satisfies McpStatusSnapshot);
  } catch {
    // Event consumers must not be able to interrupt MCP shutdown.
  }
}

export type { McpServerStatusSnapshot, McpStatusSnapshot } from "./types.ts";
export { MCP_STATUS_EVENT, MCP_STATUS_SNAPSHOT_VERSION } from "./types.ts";
